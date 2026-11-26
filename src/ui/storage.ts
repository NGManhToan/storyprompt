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
  groqModel: "llama-3.3-70b-versatile",
  cfAccount: "",
  cfToken: "",
  cfModel: "@cf/meta/llama-3.1-8b-instruct",
  batchSize: 6,
  concurrency: 4,
  rpm: 15,
  tpm: 250_000,
  rpd: 500,
  maxAttempts: 3,
  maxOutputTokens: 8192,
  bible: false,
  temperature: 0.4,
  prefix: "Cinematic 16:9 still,",
  footer: "No rendered text. Character appearance comes only from the reference images.",
  extraNames: "",
};

const SETTINGS_KEY = "storyprompt.settings.v1";
const THEME_KEY = "storyprompt.theme";
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
  return stored === "light" ? "light" : "dark";
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
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
