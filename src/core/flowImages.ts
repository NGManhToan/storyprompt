/**
 * Phần thuần (không trình duyệt) của nút "Tạo ảnh" chạy qua Google Flow:
 * tách @Tên trong prompt, hạn mức ảnh/ngày, giãn cách, phân loại lỗi.
 */

export type FlowModel = "nano-banana-2.1" | "nano-banana-pro" | "nano-banana-2-lite";

export const FLOW_MODELS: { id: FlowModel; label: string; menu: string; exclude?: string; pool: QuotaPool }[] = [
  // Nhãn menu theo trợ giúp Flow (support.google.com/flow/answer/16729550); cần đối chiếu trên giao diện thật.
  { id: "nano-banana-2.1", label: "Nano Banana 2.1 (400 ảnh/ngày chung với 2 Lite)", menu: "Nano Banana 2", exclude: "Lite", pool: "nb2" },
  { id: "nano-banana-pro", label: "Nano Banana Pro (20 ảnh/ngày)", menu: "Nano Banana Pro", pool: "pro" },
  { id: "nano-banana-2-lite", label: "Nano Banana 2 Lite (chung 400 ảnh/ngày)", menu: "Nano Banana 2 Lite", pool: "nb2" },
];

export type QuotaPool = "nb2" | "pro";

/** Hạn mức tài khoản không có gói Google AI, theo trợ giúp Flow (đọc 28/11/2026). */
export const QUOTA_LIMITS: Record<QuotaPool, number> = { nb2: 400, pro: 20 };
const DAY_MS = 24 * 60 * 60 * 1000;

export type PoolUsage = { firstAt: number; count: number };
export type FlowUsage = Partial<Record<QuotaPool, PoolUsage>>;

export function modelInfo(model: string) {
  return FLOW_MODELS.find((item) => item.id === model) ?? FLOW_MODELS[0];
}

/** Hạn mức đặt lại 24 giờ sau lần tạo đầu tiên của nhóm mô hình (không phải nửa đêm). */
export function poolState(usage: FlowUsage, pool: QuotaPool, now: number) {
  const row = usage[pool];
  const limit = QUOTA_LIMITS[pool];
  if (!row || now - row.firstAt >= DAY_MS) return { used: 0, limit, left: limit, resetAt: undefined as number | undefined };
  return { used: row.count, limit, left: Math.max(0, limit - row.count), resetAt: row.firstAt + DAY_MS };
}

export function countGeneration(usage: FlowUsage, pool: QuotaPool, now: number, images = 1): FlowUsage {
  const row = usage[pool];
  const fresh = !row || now - row.firstAt >= DAY_MS;
  return { ...usage, [pool]: fresh ? { firstAt: now, count: images } : { firstAt: row.firstAt, count: row.count + images } };
}

/** Khoảng nghỉ ngẫu nhiên giữa hai ảnh (giây → mili giây). */
export function gapMs(minSec: number, maxSec: number, random: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  return Math.round((lo + (hi - lo) * random()) * 1000);
}

export type Segment = { text: string } | { mention: string };

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tách prompt thành đoạn chữ và @Tên (chỉ những tên có ảnh tham chiếu).
 * "@You's hand" → [mention You] + "'s hand". Tên dài khớp trước.
 */
export function splitMentions(prompt: string, names: string[]): Segment[] {
  const list = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return prompt ? [{ text: prompt }] : [];
  const re = new RegExp(`@(${list.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  const out: Segment[] = [];
  let last = 0;
  for (const match of prompt.matchAll(re)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: prompt.slice(last, at) });
    const canonical = list.find((name) => name.toLowerCase() === match[1].toLowerCase()) ?? match[1];
    out.push({ mention: canonical });
    last = at + match[0].length;
  }
  if (last < prompt.length) out.push({ text: prompt.slice(last) });
  return out;
}

/**
 * Tìm ảnh tham chiếu cho @Tên trong danh sách ô chọn của Flow.
 * Ưu tiên tên trùng khớp ("Derek"), rồi tên tệp trùng ("Derek.png"),
 * rồi tệp StoryPrompt tự đặt tên khi tải lên ("StoryPrompt_Derek_<mã>.png").
 * Trả về vị trí trong danh sách, -1 nếu không có.
 */
export function matchRefTitle(titles: string[], name: string): number {
  const want = name.trim().toLowerCase();
  if (!want) return -1;
  const clean = titles.map((title) => title.trim().toLowerCase());
  const exact = clean.indexOf(want);
  if (exact >= 0) return exact;
  const stem = clean.findIndex((title) => title.replace(/\.(png|jpe?g|webp|gif|heic)$/i, "") === want);
  if (stem >= 0) return stem;
  const prefix = `storyprompt_${want}_`;
  return clean.findIndex((title) => title.startsWith(prefix));
}

export type FlowErrorKind = "rate" | "quota" | "auth" | "policy" | "missing-ref" | "unknown";

/**
 * Phân loại thông báo Flow. Chỉ có câu tiếng Anh đã đọc trong trợ giúp Flow
 * ("You're requesting generations too quickly"); câu khác (kể cả bản tiếng Việt)
 * rơi vào "unknown" → job dừng chờ bạn xem, không tự thử lại.
 */
export function classifyFlowError(text: string): FlowErrorKind {
  const value = text.toLowerCase();
  if (/too quickly|unusual activity|unusual_activity|\b403\b|too many requests|\b429\b|rate.?limit/.test(value)) return "rate";
  if (/daily limit|limit reached|reached your|quota|out of (?:credits|generations)|hết lượt|giới hạn hằng ngày|giới hạn hàng ngày/.test(value)) return "quota";
  if (/sign in|signed out|log in|đăng nhập/.test(value)) return "auth";
  if (/policy|safety|blocked|violat|chính sách|an toàn/.test(value)) return "policy";
  if (/không có ảnh tham chiếu|reference not found/.test(value)) return "missing-ref";
  return "unknown";
}

/** URL project Flow hợp lệ (flow.google.com hoặc labs.google cũ). */
export function normalizeProjectUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (url.hostname === "flow.google.com" && /^\/project\/[0-9a-f-]{20,}\/?$/i.test(url.pathname)) return `https://flow.google.com${url.pathname.replace(/\/$/, "")}`;
    if (url.hostname === "labs.google" && /\/tools\/flow\/project\/[0-9a-f-]{20,}\/?$/i.test(url.pathname)) return `https://labs.google${url.pathname.replace(/\/$/, "")}`;
    return null;
  } catch {
    return null;
  }
}
