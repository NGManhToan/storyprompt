import { containsName, eqName, inferPresence, titleCaseName } from "./cast.js";
import type { Rejection, SceneDraft, SceneTask } from "./types.js";
import { countWords } from "./types.js";

const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "with", "into", "onto", "from", "over", "under",
  "across", "through", "while", "as", "at", "of", "to", "for", "in", "on", "by", "one",
  "her", "his", "their", "they", "them", "she", "he", "its", "it", "this", "that", "then",
  "than", "once", "down", "just", "only", "when", "before", "after", "toward", "towards",
  "medium", "shot", "eye", "level", "warm", "practical", "lamp", "against", "cool", "night",
  "shallow", "focus", "still", "frame", "cinematic", "wide", "close", "camera", "depth",
  "field", "soft", "fill", "key", "rim", "natural", "light", "lighting", "color", "grade",
  "photo", "photoreal", "reference", "image", "images", "rendered", "text", "appearance",
  "quiet", "clear", "steady", "measured", "grounded", "visible", "immediate", "concrete",
  // Từ máy quay / bố cục: trùng giữa hai cảnh cùng địa điểm không phải là mượn hành động.
  "static", "view", "captures", "capturing", "shows", "showing", "where", "frame", "framed", "scene",
  "angle", "composition", "atmosphere", "mood", "present", "people", "empty", "there",
]);

const VI_MARK = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const VI_WORDS =
  /\b(?:khong|không|nhung|những|trong|dang|đang|mot|một|cua|của|voi|với|nhin|nhìn|dung|đứng)\b/i;
const UNNAMED =
  /\b(?:a|an|the)\s+(?:man|woman|boy|girl|person|stranger|figure|guy|lady)\b|\b(?:someone|somebody|people|crowd)\b/i;
const OVERLAY =
  /\b(?:subtitle|subtitles|caption|captions|watermark|title card|on-screen text|onscreen text|text overlay|chyron|lower third)\b/i;
const READABLE = /\b(?:sign|letter|note|screen|page|banner)\b[^.]{0,48}\b(?:reads|says|reading)\b/i;
const DANGLING =
  /\b(?:and|or|but|with|to|of|for|the|a|an|in|on|at|from|into|onto)\s*[.!?]$/i;

export type Verdict = { ok: boolean; rejections: Rejection[] };

/** "no people present", "nobody", "without anyone"… là phủ định, không phải thêm người lạ vào khung. */
const NEGATED_PEOPLE =
  /\b(?:no|without(?:\s+any)?|empty of|free of|devoid of|absent of|not a single)\s+(?:other\s+)?(?:people|person|persons|figures?|crowds?|one|man|woman|stranger)\b|\bnobody\b|\bno-one\b/gi;

export function hasUnnamedCharacter(prompt: string): boolean {
  return UNNAMED.test(prompt.replace(NEGATED_PEOPLE, " "));
}

/**
 * Sửa kết câu khi model chỉ quên dấu chấm (finish_reason = stop).
 * Không sửa khi câu thật sự cụt: kết bằng dấu phẩy, dấu ba chấm hoặc từ nối — những trường hợp đó vẫn bị loại.
 * Dữ liệu C# live-60: 70/72 lỗi "truncated" đến từ phản hồi finish_reason = stop, tức là báo nhầm.
 */
export function repairEnding(prompt: string): { prompt: string; fixed: boolean } {
  const text = (prompt ?? "").replace(/\s+$/u, "");
  if (!text) return { prompt: text, fixed: false };
  if (/[.!?]["”’)]*$/.test(text)) return { prompt: text, fixed: false };
  if (/(?:…|\.\.\.)$/.test(text) || /[,:;\-–—(]$/.test(text)) return { prompt: text, fixed: false };
  if (/\b(?:and|or|but|with|to|of|for|the|a|an|in|on|at|from|into|onto|while|as)$/i.test(text)) {
    return { prompt: text, fixed: false };
  }
  if (!/[\p{L}\p{N}"”’)]$/u.test(text)) return { prompt: text, fixed: false };
  return { prompt: `${text}.`, fixed: true };
}

function looseNorm(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tỷ lệ 3-gram từ của anchor có trong văn bản (0..1). */
export function anchorCoverage(anchor: string, text: string): number {
  const words = looseNorm(anchor).split(" ").filter(Boolean);
  if (words.length < 3) return looseNorm(text).includes(looseNorm(anchor)) && words.length ? 1 : 0;
  const haystack = ` ${looseNorm(text)} `;
  let hit = 0;
  let total = 0;
  for (let index = 0; index <= words.length - 3; index += 1) {
    total += 1;
    if (haystack.includes(` ${words.slice(index, index + 3).join(" ")} `)) hit += 1;
  }
  return total ? hit / total : 0;
}

export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP.has(word));
}

export function fourGrams(words: string[]): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index <= words.length - 4; index += 1) {
    grams.add(words.slice(index, index + 4).join(" "));
  }
  return grams;
}

export function visualKey(environment: string, prompt: string): string {
  return contentWords(`${environment} ${prompt}`).join(" ");
}

function norm(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function canonSceneId(raw: string, known: string[]): string | null {
  const text = String(raw ?? "").trim();
  if (known.includes(text)) return text;
  if (/^\d+$/.test(text)) {
    const padded = text.padStart(3, "0");
    if (known.includes(padded)) return padded;
  }
  return null;
}

export function validateDraft(
  draft: SceneDraft,
  task: SceneTask,
  knownNames: string[],
  neighborPrompts: { sceneId: string; prompt: string }[],
  seenKeys: Map<string, string>,
): Verdict {
  const rejections: Rejection[] = [];
  const prompt = draft.prompt?.trim() ?? "";
  const presence = inferPresence(task.source, knownNames);
  const cast = (draft.visible_cast ?? [])
    .map((name) => knownNames.find((item) => eqName(item, name)) ?? titleCaseName(name))
    .filter(Boolean);

  if (VI_MARK.test(prompt) || VI_WORDS.test(prompt)) {
    rejections.push({ code: "wrongLanguage", detail: "Prompt phải là tiếng Anh." });
  }

  const words = countWords(prompt);
  if (words < 28 || words > 42) {
    rejections.push({ code: "wordCount", detail: `Prompt có ${words} từ. Cần 28–42 từ.` });
  }

  if (
    !/[.!?]$/.test(prompt) ||
    /(?:…|\.\.\.)\s*$/.test(prompt) ||
    /[,:;]\s*$/.test(prompt) ||
    DANGLING.test(prompt)
  ) {
    rejections.push({ code: "incompleteEnding", detail: "Câu bị cụt hoặc kết thúc bằng từ nối." });
  }

  if (OVERLAY.test(prompt) || READABLE.test(prompt) || /[“"][^”"]{2,}[”"]/.test(prompt)) {
    rejections.push({ code: "overlayText", detail: "Prompt đang yêu cầu chữ trên hình." });
  }

  if (/@\w+/.test(prompt) || /#[0-9a-f]{3,8}\b/i.test(prompt)) {
    rejections.push({
      code: "appearanceOverride",
      detail: "Không dùng @tag hay mã màu. Ngoại hình để ảnh tham chiếu của Flow.",
    });
  }

  if (hasUnnamedCharacter(prompt)) {
    rejections.push({
      code: "unnamedCharacter",
      detail: presence.present.length
        ? "Hãy gọi đúng tên nhân vật đang trong khung, đừng dùng man/woman/person."
        : "Cảnh không có người trong khung nhưng prompt thêm người không tên.",
    });
  }

  for (const name of cast) {
    if (!presence.present.some((item) => eqName(item, name))) {
      rejections.push({
        code: "castAbsent",
        detail: `${name} không đứng trong cảnh này (chỉ được nhắc hoặc đã rời khung).`,
      });
    }
    if (!containsName(prompt, name)) {
      rejections.push({
        code: "castInconsistent",
        detail: `${name} có trong visible_cast nhưng không xuất hiện trong prompt.`,
      });
    }
  }

  for (const name of knownNames) {
    if (containsName(prompt, name) && !cast.some((item) => eqName(item, name))) {
      rejections.push({
        code: "castInconsistent",
        detail: `Prompt nhắc ${name} nhưng visible_cast không có tên đó.`,
      });
    }
  }

  if (!cast.length && presence.present.length) {
    rejections.push({
      code: "castMissing",
      detail: `Cảnh có ${presence.present.join(", ")} nhưng visible_cast đang trống.`,
    });
  }

  const borrow: string[] = [];
  const anchor = norm(draft.source_anchor ?? "");
  const source = norm(task.source);
  // Cho phép model đổi dấu câu / ngoặc kép khi chép anchor; chỉ loại khi phần lớn anchor không thuộc cảnh này
  // hoặc khớp cảnh bên cạnh tốt hơn.
  const own = anchor.length >= 8 ? (source.includes(anchor) ? 1 : anchorCoverage(anchor, source)) : 0;
  const best = Math.max(0, ...task.neighbors.map((neighbor) => anchorCoverage(anchor, neighbor.source)));
  if (anchor.length < 8 || own < 0.8 || best > own) {
    const fromNeighbor = anchor.length >= 8 && best > own && best >= 0.8;
    borrow.push(
      fromNeighbor
        ? "source_anchor chép từ cảnh bên cạnh."
        : "source_anchor không nằm trong lời của đúng cảnh này.",
    );
  }

  // Bỏ từ mô tả địa điểm của chính cảnh (environment) trước khi so 4-gram: cùng địa điểm thì được, cùng hành động thì không.
  const place = new Set(contentWords(draft.environment ?? ""));
  const actionWords = (text: string) => contentWords(text).filter((word) => !place.has(word));
  const grams = fourGrams(actionWords(prompt));
  for (const neighbor of neighborPrompts) {
    if (neighbor.sceneId === task.sceneId) continue;
    const shared = [...fourGrams(actionWords(neighbor.prompt))].find((gram) => grams.has(gram));
    if (shared) {
      borrow.push(`Cụm hành động trùng cảnh ${neighbor.sceneId}: “${shared}”.`);
      break;
    }
  }
  if (borrow.length) {
    rejections.push({ code: "borrowedAction", detail: borrow.join(" ") });
  }

  const key = visualKey(draft.environment ?? "", prompt);
  const owner = key ? seenKeys.get(key) : undefined;
  if (key && owner && owner !== task.sceneId) {
    rejections.push({
      code: "duplicateVisualKey",
      detail: `Trùng hình với cảnh ${owner}.`,
    });
  }

  return { ok: rejections.length === 0, rejections };
}

/** Phản hồi viết lại bằng tiếng Anh, có mục tiêu cụ thể (model viết prompt tiếng Anh). */
export function retryFeedback(rejections: Rejection[]): string {
  const lines = new Set<string>();
  for (const item of rejections) {
    const before = lines.size;
    switch (item.code) {
      case "wordCount": {
        const words = Number(/(\d+)/.exec(item.detail)?.[1] ?? 0);
        lines.add(
          words && words < 28
            ? `The prompt had ${words} words; it must be 30-40 words (hard limit 28-42). Add concrete visual detail from THIS scene's source: subject, action, setting, light.`
            : `The prompt had ${words || "too many"} words; it must be 30-40 words (hard limit 28-42). Cut filler, keep the action.`,
        );
        break;
      }
      case "wrongLanguage":
        lines.add("Write the prompt in English only.");
        break;
      case "incompleteEnding":
      case "truncated":
        lines.add("End the prompt with a complete sentence and a period.");
        break;
      case "unnamedCharacter":
        lines.add("Do not add unnamed people (man, woman, someone, crowd). Use roster names only, or show no person.");
        break;
      case "castAbsent":
      case "castInconsistent":
      case "castMissing":
        lines.add(`Cast: ${item.detail} visible_cast must list exactly the named people shown in the prompt.`);
        break;
      case "borrowedAction":
        lines.add("Depict only this scene's own action; do not reuse the neighbor scene's action or wording. source_anchor must be copied verbatim from this scene's SOURCE.");
        break;
      case "duplicateVisualKey":
        lines.add("This image duplicates an earlier scene. Change the camera angle, framing and focal action.");
        break;
      case "overlayText":
        lines.add("No readable text, captions or quoted words in the image.");
        break;
      case "appearanceOverride":
        lines.add("No @tags, hex colors or appearance descriptions.");
        break;
      default:
        lines.add(`${item.detail}`);
    }
    if (lines.size > before) {
      const last = [...lines].pop()!;
      lines.delete(last);
      lines.add(`[${item.code}] ${last}`);
    }
  }
  return [...lines].join(" ");
}
