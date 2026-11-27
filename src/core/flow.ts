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

/** Cụm app AI Studio gắn sau "@You's hand": da trắng phẳng của You (đúng chữ trong modal Prompt Ảnh @You). */
export const HAND_SKIN = "(pure flat white skin #FFFFFF)";
const HAND_SKIN_RE = /\(pure flat white skin #FFFFFF\)/gi;
const BODY_PART_AFTER_YOU = /@You's\s+(?:(?:left|right|bare|both)\s+)*(?:index\s+fingers?|hands?|fingers?|arms?|palms?|fists?|wrists?|thumbs?)\b/i;

/** Bỏ cụm da trắng khi đếm từ / kiểm mã màu (cụm này do code thêm, không phải lỗi của model). */
export function stripHandSkin(text: string): string {
  return text.replace(HAND_SKIN_RE, " ").replace(/\s{2,}/g, " ").trim();
}

/** Khi chỉ thấy tay/bộ phận của @You thì thêm đúng cụm của AI Studio, một lần. */
export function addHandSkin(text: string): string {
  if (/pure flat white skin/i.test(text)) return text;
  return text.replace(BODY_PART_AFTER_YOU, (match) => `${match} ${HAND_SKIN}`);
}

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
  return cast.some((name) => eqName(name, "You")) ? addHandSkin(text) : text;
}

/** Prompt dán vào Flow: tiền tố + câu cảnh đã gắn @Tên + khối phong cách. */
export function composeFlowPrompt(prompt: string, cast: string[], prefix: string, footer: string, aspectRatio?: string): string {
  const body = tagCast(prompt, cast);
  const sentence = body ? body.charAt(0).toUpperCase() + body.slice(1) : body;
  // --ar là cú pháp Midjourney của app AI Studio; Flow chọn tỷ lệ trong menu nên mặc định không thêm (xem cài đặt).
  return [prefix.trim(), sentence, footer.trim(), aspectRatio ? `--ar ${aspectRatio}` : ""].filter(Boolean).join(" ");
}

/** Ảnh tham chiếu cần gắn cho cảnh: đúng các nhân vật trong khung, theo thứ tự roster. */
export function referencesFor(cast: string[], roster: string[]): string[] {
  const out: string[] = [];
  for (const name of [...roster, ...cast]) {
    if (cast.some((item) => eqName(item, name)) && !out.some((item) => eqName(item, name))) out.push(name);
  }
  return out;
}
