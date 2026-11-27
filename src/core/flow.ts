import { eqName } from "./cast.js";

/**
 * Định dạng prompt cho Google Flow (labs.google/flow), theo quy ước app AI Studio "Kịch bản fin"
 * (modal Prompt Ảnh @You): nhân vật gọi bằng @Tên, ngoại hình để ảnh tham chiếu quyết định.
 * Trợ giúp Flow (support.google.com/flow/answer/16729550): gõ @ + tên asset để chọn ảnh tham chiếu,
 * và câu prompt phải nói ảnh tham chiếu được dùng thế nào.
 */

/** Nhân vật mặc định của bạn (khớp tên file ảnh tham chiếu You.png, Derek.jpg…). */
export const DEFAULT_CHARACTERS = ["You", "Derek", "Chloe", "Julian", "Arthur"];

/** Khối phong cách cố định, viết theo bộ ảnh nhân vật (2D phẳng, nét đen đậm, màu phẳng, ít đổ bóng). */
export const FLOW_STYLE_FOOTER =
  "Flat 2D cartoon illustration in the same style as the character reference images: clean bold black outlines, flat solid colors, minimal soft shading, simple uncluttered background. Keep each tagged character's face, hair and outfit exactly as in their reference image. No text, no captions, no watermark.";

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Gắn @ cho tên nhân vật đang trong khung (visible_cast) nếu model quên.
 * Riêng You: lời kể ngôi thứ hai nên "your hand" → "@You's hand", "you" → "@You".
 */
export function tagCast(prompt: string, cast: string[]): string {
  let text = (prompt ?? "").trim();
  for (const name of cast) {
    if (!name) continue;
    const tagged = new RegExp(`@${escape(name)}(?![\\p{L}\\p{N}])`, "iu");
    if (eqName(name, "You")) {
      if (tagged.test(text)) {
        text = text.replace(new RegExp(`@you(?![\\p{L}\\p{N}])`, "giu"), "@You");
        continue;
      }
      if (/(?<![@\p{L}])your(?![\p{L}])/iu.test(text)) {
        text = text.replace(/(?<![@\p{L}])your(?![\p{L}])/iu, "@You's");
      } else if (/(?<![@\p{L}])you(?![\p{L}'’])/iu.test(text)) {
        text = text.replace(/(?<![@\p{L}])you(?![\p{L}'’])/iu, "@You");
      }
      continue;
    }
    const bare = new RegExp(`(?<![@\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "giu");
    text = text.replace(bare, `@${name}`);
    text = text.replace(new RegExp(`@${escape(name)}(?![\\p{L}\\p{N}])`, "giu"), `@${name}`);
  }
  return text;
}

/** Prompt dán vào Flow: tiền tố + câu cảnh đã gắn @Tên + khối phong cách. */
export function composeFlowPrompt(prompt: string, cast: string[], prefix: string, footer: string): string {
  const body = tagCast(prompt, cast);
  const sentence = body ? body.charAt(0).toUpperCase() + body.slice(1) : body;
  return [prefix.trim(), sentence, footer.trim()].filter(Boolean).join(" ");
}

/** Ảnh tham chiếu cần gắn cho cảnh: đúng các nhân vật trong khung, theo thứ tự roster. */
export function referencesFor(cast: string[], roster: string[]): string[] {
  const out: string[] = [];
  for (const name of [...roster, ...cast]) {
    if (cast.some((item) => eqName(item, name)) && !out.some((item) => eqName(item, name))) out.push(name);
  }
  return out;
}
