import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cfNeurons, DEFAULT_LIMITS } from "../core/laneLimits.js";
import { isUsable, keyDisplayName, SERVER_KEY_ID, type KeyProvider, type StoredKey } from "../core/keys.js";
import { geminiProvider, resolveGeminiModels } from "../core/providers/gemini.js";
import { generateCloudflare, generateGroq } from "../core/providers/httpLanes.js";
import { createMockProvider } from "../core/providers/mock.js";
import type { LaneSlot } from "../core/router.js";
import { createScheduler } from "../core/scheduler.js";
import type { Provider } from "../core/types.js";

export const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
export const DEFAULT_CF_MODEL = "@cf/qwen/qwen3.8-27b";

export type LaneUsage = { dayKey: string; count: number; neurons: number };

/** Bộ đếm request/neuron theo ngày UTC, lưu ra đĩa để các lượt chạy nền cộng dồn đúng hạn mức ngày. */
export type UsageStore = {
  load: (key: string) => LaneUsage;
  save: (key: string, usage: LaneUsage) => void;
};

function today(now: () => number): string {
  return new Date(now()).toISOString().slice(0, 10);
}

export function memoryUsage(now: () => number = Date.now): UsageStore {
  const map = new Map<string, LaneUsage>();
  return {
    load: (key) => {
      const row = map.get(key);
      return row && row.dayKey === today(now) ? row : { dayKey: today(now), count: 0, neurons: 0 };
    },
    save: (key, usage) => void map.set(key, usage),
  };
}

export function fileUsage(file: string, now: () => number = Date.now): UsageStore {
  let all: Record<string, LaneUsage> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8")) as Record<string, LaneUsage>;
  } catch {
    all = {};
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(all));
      renameSync(tmp, file);
    } catch {
      /* đếm tạm trong bộ nhớ vẫn dùng được */
    }
  };
  return {
    load: (key) => {
      const row = all[key];
      return row && row.dayKey === today(now)
        ? { dayKey: row.dayKey, count: row.count ?? 0, neurons: row.neurons ?? 0 }
        : { dayKey: today(now), count: 0, neurons: 0 };
    },
    save: (key, usage) => {
      all[key] = usage;
      if (!timer) timer = setTimeout(flush, 500);
    },
  };
}

/** Khóa người dùng gửi kèm yêu cầu (chỉ nằm trong bộ nhớ, không ghi đĩa, không log). */
export type JobKey = { id?: string; provider: KeyProvider; label?: string; key: string; account?: string; enabled?: boolean };

export type LaneSettings = {
  lane?: KeyProvider;
  useGemini?: boolean;
  useGroq?: boolean;
  useCloudflare?: boolean;
  /** Lane mà khóa .env của server bị tắt. */
  serverOff?: string[];
  geminiModel?: string;
  geminiFallbacks?: string;
  groqModel?: string;
  cfModel?: string;
  rpm?: number;
  tpm?: number;
  rpd?: number;
  groqRpm?: number;
  groqTpm?: number;
  groqOtpm?: number;
  groqRpd?: number;
  cfRpm?: number;
  cfNeuronStop?: number;
};

export type BuiltLanes = {
  slots: LaneSlot[];
  /** Tên lane để hiển thị (không chứa giá trị khóa). */
  labels: string[];
  /** "server" nếu chỉ dùng khóa .env, "browser" nếu chỉ khóa gửi kèm, "mixed" nếu cả hai. */
  keySource: "server" | "browser" | "mixed" | "none";
};

type Cred = { id: string; label: string; key: string; account: string; server: boolean };

function credentials(lane: KeyProvider, keys: JobKey[], settings: LaneSettings, env: NodeJS.ProcessEnv): Cred[] {
  const out: Cred[] = [];
  keys
    .map((item, index): StoredKey => ({ id: item.id || `b${index}`, provider: item.provider, label: item.label ?? "", key: item.key ?? "", account: item.account, enabled: item.enabled !== false }))
    .filter((item) => item.provider === lane && isUsable(item))
    .forEach((item, index) =>
      out.push({ id: item.id, label: keyDisplayName(item, index), key: item.key.trim(), account: item.account?.trim() ?? "", server: false }),
    );
  if (!(settings.serverOff ?? []).includes(lane)) {
    const present =
      lane === "gemini" ? env.GEMINI_API_KEY : lane === "groq" ? env.GROQ_API_KEY : env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID;
    if (present) out.push({ id: SERVER_KEY_ID, label: "Từ server (.env)", key: "", account: "", server: true });
  }
  return out;
}

const ENABLED: Record<KeyProvider, keyof LaneSettings> = { gemini: "useGemini", groq: "useGroq", cloudflare: "useCloudflare" };

/**
 * Dựng lane chạy ngay trong server (không qua trình duyệt).
 * Lane chính = settings.lane (mặc định Gemini); các lane còn lại là dự phòng, chỉ nhận lô khi lane chính phải chờ lâu.
 */
export function buildServerLanes(args: {
  settings: LaneSettings;
  keys: JobKey[];
  env: NodeJS.ProcessEnv;
  usage: UsageStore;
  mode?: "live" | "mock";
}): BuiltLanes {
  const { settings, keys, env, usage } = args;
  if (args.mode === "mock") {
    const base = createMockProvider({ delayMs: 20 });
    return {
      slots: [{ provider: base, scheduler: createScheduler({ rpm: 6_000, tpm: 50_000_000, rpd: 1_000_000 }) }],
      labels: ["mock"],
      keySource: "none",
    };
  }
  const primary: KeyProvider = settings.lane ?? "gemini";
  const order = [primary, "gemini", "groq", "cloudflare"] as KeyProvider[];
  const seen = new Set<string>();
  const slots: LaneSlot[] = [];
  const labels: string[] = [];
  let server = 0;
  let browser = 0;
  const models = [settings.geminiModel ?? "gemini-3.1-flash-lite", ...(settings.geminiFallbacks ?? "gemini-4-hydrogen").split(",")].map((item) => item.trim()).filter(Boolean);

  for (const lane of order) {
    if (seen.has(lane)) continue;
    seen.add(lane);
    if (settings[ENABLED[lane]] === false) continue;
    for (const cred of credentials(lane, keys, settings, env)) {
      const usageKey = `${lane}:${cred.id}`;
      const day = usage.load(usageKey);
      const common = {
        dayKey: day.dayKey,
        dayCount: day.count,
        onUsage: (next: LaneUsage) => usage.save(usageKey, next),
      };
      const identity = { keyId: cred.id, keyLabel: cred.label, usageKey };
      const backup = lane !== primary;
      if (cred.server) server += 1;
      else browser += 1;
      labels.push(`${lane}:${cred.label}${backup ? " (dự phòng)" : ""}`);
      if (lane === "gemini") {
        const apiKey = cred.server ? env.GEMINI_API_KEY! : cred.key;
        const provider = { ...geminiProvider({ apiKey, models: resolveGeminiModels(models) }), ...identity };
        slots.push({
          provider,
          backup,
          scheduler: createScheduler({
            ...common,
            rpm: settings.rpm ?? DEFAULT_LIMITS.gemini.rpm,
            tpm: settings.tpm ?? DEFAULT_LIMITS.gemini.tpm,
            rpd: settings.rpd ?? DEFAULT_LIMITS.gemini.rpd,
            tpmInputOnly: true,
          }),
        });
      } else if (lane === "groq") {
        const model = settings.groqModel || env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
        const apiKey = cred.server ? env.GROQ_API_KEY! : cred.key;
        const provider: Provider = {
          lane: "groq",
          model,
          available: true,
          ...identity,
          generate: (request, signal) => generateGroq({ apiKey, model, request, signal }),
        };
        slots.push({
          provider,
          backup,
          scheduler: createScheduler({
            ...common,
            rpm: settings.groqRpm ?? DEFAULT_LIMITS.groq.rpm,
            tpm: settings.groqTpm ?? DEFAULT_LIMITS.groq.tpm,
            otpm: settings.groqOtpm ?? DEFAULT_LIMITS.groq.otpm,
            rpd: settings.groqRpd ?? DEFAULT_LIMITS.groq.rpd,
          }),
        });
      } else {
        const model = settings.cfModel || env.CLOUDFLARE_MODEL || DEFAULT_CF_MODEL;
        const token = cred.server ? env.CLOUDFLARE_API_TOKEN! : cred.key;
        const accountId = cred.server ? env.CLOUDFLARE_ACCOUNT_ID! : cred.account;
        const provider: Provider = {
          lane: "cloudflare",
          model,
          available: true,
          ...identity,
          generate: (request, signal) => generateCloudflare({ token, accountId, model, request, signal }),
        };
        slots.push({
          provider,
          backup,
          neurons: (input, output) => cfNeurons(model, input, output),
          scheduler: createScheduler({
            ...common,
            rpm: settings.cfRpm ?? DEFAULT_LIMITS.cloudflare.rpm,
            tpm: 10_000_000,
            rpd: 100_000,
            neuronStop: settings.cfNeuronStop ?? DEFAULT_LIMITS.cloudflare.neuronStop,
            neuronsUsed: day.neurons,
          }),
        });
      }
    }
  }
  const keySource = !slots.length ? "none" : server && browser ? "mixed" : server ? "server" : "browser";
  return { slots, labels, keySource };
}
