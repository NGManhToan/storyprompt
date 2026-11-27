import { ProviderError, parseRetryAfter } from "../core/errors.js";
import { geminiProvider } from "../core/providers/gemini.js";
import { createMockProvider } from "../core/providers/mock.js";
import type { GenerateRequest, GenerateResponse, Provider } from "../core/types.js";
import { cfNeurons } from "../core/laneLimits.js";
import type { LaneSlot } from "../core/router.js";
import { createScheduler } from "../core/scheduler.js";
import { isUsable, keyDisplayName, keysOf, SERVER_KEY_ID, type KeyProvider } from "../core/keys.js";
import type { LaneUsage, Settings } from "./storage.js";

export type ServerHealth = {
  ok: boolean;
  gemini: boolean;
  groq: boolean;
  cloudflare: boolean;
  /** 4 ký tự cuối của khóa .env (không phải toàn bộ) để người dùng nhận ra khóa server. */
  hints?: Partial<Record<KeyProvider, string>>;
  models?: { gemini: string[]; groq: string; cloudflare: string };
};

function modelsOf(settings: Settings): string[] {
  return [settings.geminiModel, ...settings.geminiFallbacks.split(",")]
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Một "khóa" dùng được: khóa trên trình duyệt hoặc khóa .env của server (key/account rỗng → server tự điền). */
export type Credential = { id: string; label: string; key: string; account: string; server: boolean };

export function laneCredentials(settings: Settings, lane: KeyProvider, health: ServerHealth | null): Credential[] {
  const own = keysOf(settings.keys ?? [], lane);
  const list: Credential[] = own
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isUsable(item))
    .map(({ item, index }) => ({ id: item.id, label: keyDisplayName(item, index), key: item.key.trim(), account: item.account?.trim() ?? "", server: false }));
  if (health?.[lane] && !(settings.serverOff ?? []).includes(lane)) {
    list.push({ id: SERVER_KEY_ID, label: "Từ server (.env)", key: "", account: "", server: true });
  }
  return list;
}

async function postGenerate(settings: Settings, lane: Settings["lane"], cred: Credential, request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Khóa server: không gửi header, server tự lấy từ .env.
  if (!cred.server) {
    if (lane === "gemini") headers["x-gemini-key"] = cred.key;
    else if (lane === "groq") headers["x-groq-key"] = cred.key;
    else {
      headers["x-cf-token"] = cred.key;
      headers["x-cf-account"] = cred.account;
    }
  }
  const response = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      lane,
      models: modelsOf(settings),
      groqModel: settings.groqModel,
      cfModel: settings.cfModel,
      request,
    }),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ProviderError(payload.error || `Proxy HTTP ${response.status}`, {
      status: response.status,
      lane,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
  return (await response.json()) as GenerateResponse;
}

function identity(lane: Settings["lane"], cred: Credential) {
  return { keyId: cred.id, keyLabel: cred.label, usageKey: `${lane}:${cred.id}` };
}

function proxyProvider(settings: Settings, lane: Settings["lane"], cred: Credential): Provider {
  const model = lane === "groq" ? settings.groqModel : lane === "cloudflare" ? settings.cfModel : modelsOf(settings)[0];
  return {
    lane,
    model,
    available: true,
    ...identity(lane, cred),
    generate: (request, signal) => postGenerate(settings, lane, cred, request, signal),
  };
}

const ENABLED: Record<Settings["lane"], keyof Settings> = {
  gemini: "useGemini",
  groq: "useGroq",
  cloudflare: "useCloudflare",
};

export function buildLanes(settings: Settings, health: ServerHealth | null, mode: "mock" | "live"): Provider[] {
  if (mode === "mock") {
    return [createMockProvider({ delayMs: 220, fail: { "003": "language", "005": "omit" } })];
  }
  const order = [settings.lane, "gemini", "groq", "cloudflare"] as const;
  const seen = new Set<string>();
  const lanes: Provider[] = [];
  for (const lane of order) {
    if (seen.has(lane)) continue;
    seen.add(lane);
    if (settings[ENABLED[lane]] === false) continue;
    // Mỗi khóa là một slot riêng: hạn mức, breaker 429 và bộ đếm ngày riêng.
    for (const cred of laneCredentials(settings, lane, health)) {
      const proxy = proxyProvider(settings, lane, cred);
      if (lane === "gemini" && settings.directBrowser && !cred.server) {
        const direct = geminiProvider({ apiKey: cred.key, models: modelsOf(settings) });
        lanes.push({
          ...direct,
          ...identity(lane, cred),
          async generate(request, signal) {
            try {
              return await direct.generate(request, signal);
            } catch (error) {
              if (error instanceof ProviderError) throw error;
              return proxy.generate(request, signal);
            }
          },
        });
      } else lanes.push(proxy);
    }
  }
  return lanes;
}

/** Mỗi lane một bộ hạn mức riêng; router chia lô theo lane đang rảnh. */
export function buildSlots(
  settings: Settings,
  lanes: Provider[],
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    mode: "mock" | "live";
    usage: (lane: string) => LaneUsage;
    onUsage: (lane: string, usage: LaneUsage) => void;
  },
): LaneSlot[] {
  return lanes.map((provider) => {
    const live = options.mode === "live";
    const usageKey = provider.usageKey ?? provider.lane;
    const day = live ? options.usage(usageKey) : { dayKey: new Date().toISOString().slice(0, 10), count: 0, neurons: 0 };
    const common = {
      now: options.now,
      sleep: options.sleep,
      dayKey: day.dayKey,
      dayCount: day.count,
      onUsage: live ? (next: LaneUsage) => options.onUsage(usageKey, next) : undefined,
    };
    if (!live) {
      return { provider, scheduler: createScheduler({ ...common, rpm: 600, tpm: 2_000_000, rpd: 10_000 }) };
    }
    if (provider.lane === "groq") {
      return {
        provider,
        scheduler: createScheduler({ ...common, rpm: settings.groqRpm, tpm: settings.groqTpm, otpm: settings.groqOtpm, rpd: settings.groqRpd }),
      };
    }
    if (provider.lane === "cloudflare") {
      return {
        provider,
        neurons: (input: number, output: number) => cfNeurons(settings.cfModel, input, output),
        scheduler: createScheduler({
          ...common,
          rpm: settings.cfRpm,
          tpm: 10_000_000,
          rpd: 100_000,
          neuronStop: settings.cfNeuronStop,
          neuronsUsed: day.neurons,
        }),
      };
    }
    return {
      provider,
      scheduler: createScheduler({ ...common, rpm: settings.rpm, tpm: settings.tpm, rpd: settings.rpd, tpmInputOnly: true }),
    };
  });
}
