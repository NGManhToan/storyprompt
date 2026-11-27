import { ProviderError, parseRetryAfter } from "../core/errors.js";
import { geminiProvider } from "../core/providers/gemini.js";
import { createMockProvider } from "../core/providers/mock.js";
import type { GenerateRequest, GenerateResponse, Provider } from "../core/types.js";
import { cfNeurons } from "../core/laneLimits.js";
import type { LaneSlot } from "../core/router.js";
import { createScheduler } from "../core/scheduler.js";
import type { LaneUsage, Settings } from "./storage.js";

export type ServerHealth = {
  ok: boolean;
  gemini: boolean;
  groq: boolean;
  cloudflare: boolean;
  models?: { gemini: string[]; groq: string; cloudflare: string };
};

function modelsOf(settings: Settings): string[] {
  return [settings.geminiModel, ...settings.geminiFallbacks.split(",")]
    .map((item) => item.trim())
    .filter(Boolean);
}

async function postGenerate(settings: Settings, lane: Settings["lane"], request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gemini-key": settings.geminiKey,
      "x-groq-key": settings.groqKey,
      "x-cf-token": settings.cfToken,
      "x-cf-account": settings.cfAccount,
    },
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

function proxyProvider(settings: Settings, lane: Settings["lane"], health: ServerHealth | null): Provider {
  const model = lane === "groq" ? settings.groqModel : lane === "cloudflare" ? settings.cfModel : modelsOf(settings)[0];
  const available =
    lane === "gemini"
      ? Boolean(settings.geminiKey || health?.gemini)
      : lane === "groq"
        ? Boolean(settings.groqKey || health?.groq)
        : Boolean((settings.cfAccount && settings.cfToken) || health?.cloudflare);
  return {
    lane,
    model,
    available,
    generate: (request, signal) => postGenerate(settings, lane, request, signal),
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
  const proxy = {
    gemini: proxyProvider(settings, "gemini", health),
    groq: proxyProvider(settings, "groq", health),
    cloudflare: proxyProvider(settings, "cloudflare", health),
  };
  const direct =
    settings.directBrowser && settings.geminiKey
      ? geminiProvider({ apiKey: settings.geminiKey, models: modelsOf(settings) })
      : null;
  const gemini: Provider = direct
    ? {
        ...direct,
        async generate(request, signal) {
          try {
            return await direct.generate(request, signal);
          } catch (error) {
            if (error instanceof ProviderError || !proxy.gemini.available) throw error;
            return proxy.gemini.generate(request, signal);
          }
        },
      }
    : proxy.gemini;

  const selected = { gemini, groq: proxy.groq, cloudflare: proxy.cloudflare };
  const order = [settings.lane, "gemini", "groq", "cloudflare"] as const;
  const seen = new Set<string>();
  return order
    .filter((lane) => {
      if (seen.has(lane)) return false;
      seen.add(lane);
      return settings[ENABLED[lane]] !== false && selected[lane].available;
    })
    .map((lane) => selected[lane]);
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
    const day = live ? options.usage(provider.lane) : { dayKey: new Date().toISOString().slice(0, 10), count: 0, neurons: 0 };
    const common = {
      now: options.now,
      sleep: options.sleep,
      dayKey: day.dayKey,
      dayCount: day.count,
      onUsage: live ? (next: LaneUsage) => options.onUsage(provider.lane, next) : undefined,
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
