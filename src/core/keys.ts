/** Quản lý nhiều khóa API cho mỗi nhà cung cấp. Thuần dữ liệu, không đụng mạng, không in giá trị khóa. */
export type KeyProvider = "gemini" | "groq" | "cloudflare";

export const KEY_PROVIDERS: KeyProvider[] = ["gemini", "groq", "cloudflare"];

export const PROVIDER_NAMES: Record<KeyProvider, string> = {
  gemini: "Gemini",
  groq: "Groq",
  cloudflare: "Cloudflare Workers AI",
};

export type StoredKey = {
  id: string;
  provider: KeyProvider;
  /** Tên gợi nhớ, có thể để trống. */
  label: string;
  /** Gemini/Groq: API key. Cloudflare: API token. */
  key: string;
  /** Chỉ Cloudflare: account id đi kèm token. */
  account?: string;
  enabled: boolean;
};

/** Id đặc biệt của khóa đặt trên server (.env); không bao giờ lưu giá trị. */
export const SERVER_KEY_ID = "server";

export function newKeyId(random: () => number = Math.random, now: () => number = Date.now): string {
  return `k${now().toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
}

/** 4 ký tự đầu + 4 ký tự cuối; khóa quá ngắn thì che hết. */
export function maskKey(key: string): string {
  const value = key.trim();
  if (value.length < 12) return value ? "••••••••" : "";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function keyDisplayName(item: StoredKey, index: number): string {
  return item.label.trim() || `${PROVIDER_NAMES[item.provider]} #${index + 1}`;
}

export function isUsable(item: StoredKey): boolean {
  if (!item.enabled || !item.key.trim()) return false;
  return item.provider === "cloudflare" ? Boolean(item.account?.trim()) : true;
}

export function validateNewKey(input: { provider: KeyProvider; key: string; account?: string }, existing: StoredKey[]): string | null {
  const key = input.key.trim();
  if (!key) return "Chưa nhập key.";
  if (/\s/.test(key)) return "Key không được chứa khoảng trắng.";
  if (input.provider === "cloudflare") {
    const account = (input.account ?? "").trim();
    if (!/^[0-9a-f]{32}$/i.test(account)) return "Account ID Cloudflare gồm 32 ký tự hex.";
  }
  if (existing.some((item) => item.provider === input.provider && item.key === key)) return "Key này đã có trong danh sách.";
  return null;
}

type LegacyKeys = { geminiKey?: string; groqKey?: string; cfToken?: string; cfAccount?: string };

/** Settings cũ có một ô khóa cho mỗi nhà cung cấp → chuyển thành danh sách khóa. */
export function keysFromLegacy(old: LegacyKeys): StoredKey[] {
  const out: StoredKey[] = [];
  if (old.geminiKey?.trim()) out.push({ id: newKeyId(() => 0.1, () => 1), provider: "gemini", label: "", key: old.geminiKey.trim(), enabled: true });
  if (old.groqKey?.trim()) out.push({ id: newKeyId(() => 0.2, () => 2), provider: "groq", label: "", key: old.groqKey.trim(), enabled: true });
  if (old.cfToken?.trim()) {
    out.push({ id: newKeyId(() => 0.3, () => 3), provider: "cloudflare", label: "", key: old.cfToken.trim(), account: old.cfAccount?.trim() ?? "", enabled: true });
  }
  return out;
}

export function keysOf(keys: StoredKey[], provider: KeyProvider): StoredKey[] {
  return keys.filter((item) => item.provider === provider);
}
