import type { Checkpoint } from "../core/pipeline.js";
import type { RunSettings } from "../core/types.js";

export type Settings = RunSettings & {
  lane: "gemini" | "groq" | "cloudflare";
  directBrowser: boolean;
  geminiKey: string;
  geminiModel: string;
  geminiFallbacks: string;
  groqKey: string;
  groqModel: string;
  cfAccount: string;
  cfToken: string;
  cfModel: string;
  rpm: number;
  tpm: number;
  rpd: number;
  extraNames: string;
};

export const defaultSettings: Settings = {
  lane: "gemini",
  directBrowser: true,
  geminiKey: "",
  geminiModel: "gemini-3.1-flash-lite",
  geminiFallbacks: "gemini-3.8-flash, gemini-flash-latest",
  groqKey: "",
  groqModel: "qwen/qwen3.8-27b",
  cfAccount: "",
  cfToken: "",
  cfModel: "@cf/meta/llama-3.1-8b-instruct",
  batchSize: 4,
  concurrency: 4,
  rpm: 15,
  tpm: 250_000,
  rpd: 500,
  maxAttempts: 3,
  maxOutputTokens: 8192,
  bible: false,
  temperature: 0.7,
  fullScript: true,
  topic: "",
  protagonist: "",
  prefix: "",
  footer: "modern 2D webtoon comic style, crisp ink line art, cel-shaded, warm daylight, clean frame, no text, 16:9",
  extraNames: "",
};

const SETTINGS_KEY = "storyprompt.settings.v2";
const THEME_KEY = "storyprompt.theme.v2";
const USAGE_KEY = "storyprompt.usage.v1";

export type DayUsage = { dayKey: string; count: number };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...JSON.parse(raw) };
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

export async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(checkpoint);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* trình duyệt riêng tư vẫn chạy được trong bộ nhớ */
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
