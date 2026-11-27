import type { Checkpoint } from "../core/pipeline.js";
import { DEFAULT_LIMITS } from "../core/laneLimits.js";
import { keysFromLegacy, type StoredKey } from "../core/keys.js";
import type { RunSettings } from "../core/types.js";

export type Settings = RunSettings & {
  lane: "gemini" | "groq" | "cloudflare";
  directBrowser: boolean;
  /** Danh sách khóa nhập trên trình duyệt (chỉ nằm ở localStorage). */
  keys: StoredKey[];
  /** Nhà cung cấp mà khóa server (.env) bị tắt: "gemini" | "groq" | "cloudflare". */
  serverOff: string[];
  geminiModel: string;
  geminiFallbacks: string;
  groqModel: string;
  cfModel: string;
  /** Hạn mức Gemini (free tier: số chưa công bố, xem AI Studio → Rate limits). */
  rpm: number;
  tpm: number;
  rpd: number;
  useGemini: boolean;
  useGroq: boolean;
  useCloudflare: boolean;
  groqRpm: number;
  groqTpm: number;
  groqOtpm: number;
  groqRpd: number;
  cfRpm: number;
  cfNeuronStop: number;
  extraNames: string;
};

export const defaultSettings: Settings = {
  lane: "gemini",
  directBrowser: true,
  keys: [],
  serverOff: [],
  geminiModel: "gemini-3.1-flash-lite",
  geminiFallbacks: "gemini-4-hydrogen",
  groqModel: "qwen/qwen3.8-27b",
  cfModel: "@cf/qwen/qwen3.8-27b",
  batchSize: 4,
  concurrency: 6,
  rpm: DEFAULT_LIMITS.gemini.rpm,
  tpm: DEFAULT_LIMITS.gemini.tpm,
  rpd: DEFAULT_LIMITS.gemini.rpd,
  useGemini: true,
  useGroq: true,
  useCloudflare: true,
  groqRpm: DEFAULT_LIMITS.groq.rpm,
  groqTpm: DEFAULT_LIMITS.groq.tpm,
  groqOtpm: DEFAULT_LIMITS.groq.otpm ?? 1_000,
  groqRpd: DEFAULT_LIMITS.groq.rpd,
  cfRpm: DEFAULT_LIMITS.cloudflare.rpm,
  cfNeuronStop: DEFAULT_LIMITS.cloudflare.neuronStop ?? 9_000,
  maxAttempts: 3,
  maxOutputTokens: 8192,
  bible: false,
  temperature: 0.7,
  fullScript: true,
  contextScenes: 4,
  topic: "",
  protagonist: "",
  prefix: "",
  footer: "modern 2D webtoon comic style, crisp ink line art, cel-shaded, warm daylight, clean frame, no text, 16:9",
  extraNames: "",
};

const SETTINGS_KEY = "storyprompt.settings.v4";
const PRIOR_SETTINGS_KEY = "storyprompt.settings.v3";
const LEGACY_SETTINGS_KEY = "storyprompt.settings.v2";
const THEME_KEY = "storyprompt.theme.v2";
const USAGE_KEY = "storyprompt.usage.v1";

export type DayUsage = { dayKey: string; count: number };

type LegacyShape = Partial<Settings> & { geminiKey?: string; groqKey?: string; cfToken?: string; cfAccount?: string };

/** v3 (một ô khóa mỗi nhà cung cấp) → v4 (danh sách khóa). Khóa cũ được giữ lại, các ô cũ bị bỏ khỏi settings. */
export function migrateSettings(raw: LegacyShape): Settings {
  const { geminiKey, groqKey, cfToken, cfAccount, ...rest } = raw;
  const merged = { ...defaultSettings, ...rest } as Settings;
  if (!Array.isArray(raw.keys)) merged.keys = keysFromLegacy({ geminiKey, groqKey, cfToken, cfAccount });
  if (!Array.isArray(merged.serverOff)) merged.serverOff = [];
  return merged;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return migrateSettings(JSON.parse(raw));
    const prior = localStorage.getItem(PRIOR_SETTINGS_KEY);
    if (prior) return migrateSettings(JSON.parse(prior));
    const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!legacy) return defaultSettings;
    // v2 → v4: giữ khóa và tuỳ chỉnh nội dung, đổi model/hạn mức sang mặc định mới (chuỗi AI Studio).
    const old = JSON.parse(legacy) as LegacyShape;
    return migrateSettings({
      geminiKey: old.geminiKey,
      groqKey: old.groqKey,
      cfToken: old.cfToken,
      cfAccount: old.cfAccount,
      directBrowser: old.directBrowser ?? defaultSettings.directBrowser,
      bible: old.bible ?? defaultSettings.bible,
      topic: old.topic ?? "",
      protagonist: old.protagonist ?? "",
      prefix: old.prefix ?? "",
      footer: old.footer ?? defaultSettings.footer,
      extraNames: old.extraNames ?? "",
    });
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadTheme(): "dark" | "light" {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "dark" ? "dark" : "light";
}

export function saveTheme(theme: "dark" | "light") {
  localStorage.setItem(THEME_KEY, theme);
}

export function loadUsage(): DayUsage {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return { dayKey: today, count: 0 };
    const parsed = JSON.parse(raw) as DayUsage;
    if (parsed.dayKey !== today) return { dayKey: today, count: 0 };
    return parsed;
  } catch {
    return { dayKey: today, count: 0 };
  }
}

export function saveUsage(usage: DayUsage) {
  localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
}

export type LaneUsage = { dayKey: string; count: number; neurons: number };
const LANE_USAGE_KEY = "storyprompt.laneUsage.v1";

/** Đếm request/neuron theo lane trong ngày UTC (RPD và neuron Cloudflare reset 00:00 UTC). */
export function loadLaneUsage(lane: string): LaneUsage {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const all = JSON.parse(localStorage.getItem(LANE_USAGE_KEY) || "{}") as Record<string, LaneUsage>;
    const row = all[lane];
    if (!row || row.dayKey !== today) return { dayKey: today, count: 0, neurons: 0 };
    return { dayKey: row.dayKey, count: row.count ?? 0, neurons: row.neurons ?? 0 };
  } catch {
    return { dayKey: today, count: 0, neurons: 0 };
  }
}

export function saveLaneUsage(lane: string, usage: LaneUsage) {
  try {
    const all = JSON.parse(localStorage.getItem(LANE_USAGE_KEY) || "{}") as Record<string, LaneUsage>;
    all[lane] = usage;
    localStorage.setItem(LANE_USAGE_KEY, JSON.stringify(all));
  } catch {
    /* bỏ qua */
  }
}

const DB = "storyprompt-web";
const STORE = "checkpoints";

const STILLS = "stills";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(STILLS)) {
        request.result.createObjectStore(STILLS, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveCheckpoint(checkpoint: Checkpoint): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(checkpoint);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function saveStills(id: string, images: Record<string, string[]>): Promise<void> {
  if (!id) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STILLS, "readwrite");
      tx.objectStore(STILLS).put({ id, images });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* bộ nhớ riêng của phiên vẫn giữ ảnh */
  }
}

export async function loadStills(id: string): Promise<Record<string, string[]> | null> {
  if (!id) return null;
  try {
    const db = await openDb();
    const row = await new Promise<{ images?: Record<string, string[]> } | null>((resolve, reject) => {
      const tx = db.transaction(STILLS, "readonly");
      const request = tx.objectStore(STILLS).get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return row?.images ?? null;
  } catch {
    return null;
  }
}

export async function loadCheckpoint(id: string): Promise<Checkpoint | null> {
  try {
    const db = await openDb();
    const row = await new Promise<Checkpoint | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => resolve((request.result as Checkpoint) ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return row;
  } catch {
    return null;
  }
}
