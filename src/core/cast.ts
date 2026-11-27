const BLOCK = new Set([
  "int",
  "ext",
  "cảnh",
  "canh",
  "scene",
  "sc",
  "ok",
  "tv",
  "nội",
  "ngoại",
  "vo",
  "os",
]);

const ABSENT =
  /(đã rời|rời khỏi|rời đi|đi khuất|không còn ở|vắng mặt|biến mất|đã bỏ đi|off-screen|off screen|has left|walks away|is gone)/i;

const SPEAKER =
  /^([\p{L}][\p{L}0-9'’.\-]*(?:\s+[\p{L}][\p{L}0-9'’.\-]*){0,3})\s*(?:\(([^)]{1,24})\))?\s*:\s+(\S.*)$/u;

const HONORIFIC_SOURCE =
  "(?:^|[^\\p{L}])(?:[Ôô]ng|[Bb]à|[Aa]nh|[Cc]hị|[Cc]ô|[Cc]hú|[Bb]ác)\\s+([A-ZÀ-Ỹ][a-zà-ỹ]+)";

export type Presence = {
  present: string[];
  mentionedOnly: string[];
};

export function eqName(a: string, b: string): boolean {
  return a.normalize("NFC").localeCompare(b.normalize("NFC"), "vi", { sensitivity: "accent" }) === 0;
}

export function titleCaseName(name: string): string {
  return name
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("vi")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase("vi") + word.slice(1))
    .join(" ");
}

export function containsName(text: string, name: string): boolean {
  const escaped = name.normalize("NFC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(text.normalize("NFC"));
}

function looksLikeSpeaker(name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  if (words.some((word) => BLOCK.has(word.toLocaleLowerCase("vi")))) return false;
  const allCaps = words.every((word) => word.length >= 2 && word === word.toLocaleUpperCase("vi"));
  if (allCaps) return true;
  return words.every((word) => /^[\p{Lu}]/u.test(word));
}

function isOffscreen(cue: string | undefined): boolean {
  if (!cue) return false;
  return /(v\.?\s*o\.?|o\.?\s*s\.?|off|phone|call|remote|filter)/i.test(cue);
}

/** Người chỉ nghe/nhận qua điện thoại, cuộc gọi, tin nhắn, email: không vào khung hình. */
const REMOTE_CUE =
  /\b(?:calls?|called|calling|voicemail|messages?|messaged|texts|texted|emails?|e-mail|speakerphone|on the line|hang(?:s|ing)? up|hung up|vibrates?|vibrated|video call|zoom|phone call|(?:on|over|into|via|by) (?:the |your |his |her |their )?(?:phone|cell|mobile|speaker)|(?:phone|cell) (?:rings|buzzes|lights up))\b/i;
const SECOND_PERSON = /\b(?:you|your|you're|yourself)\b/i;
/** "Your phone vibrates…": lời kể ngôi thứ hai nghĩa là You đang ở trong cảnh dù không có từ "You" đứng một mình. */
const YOU_POSSESSIVE_LINE = /\b(?:your|you're|yourself)\b/i;

type SpeakerHit = { name: string; cue?: string; utterance: string };

function matchSpeaker(line: string): SpeakerHit | null {
  const match = line.trim().match(SPEAKER);
  if (!match) return null;
  if (!looksLikeSpeaker(match[1])) return null;
  return { name: match[1], cue: match[2], utterance: match[3] };
}

function honorificNames(line: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(HONORIFIC_SOURCE, "gu");
  for (const match of line.normalize("NFC").matchAll(pattern)) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

function pushUnique(list: string[], name: string) {
  const titled = titleCaseName(name);
  if (!titled || BLOCK.has(titled.toLocaleLowerCase("vi"))) return;
  if (!list.some((item) => eqName(item, titled))) list.push(titled);
}

export function extractNames(script: string, extras: string[] = []): string[] {
  const found: string[] = [];
  for (const extra of extras) pushUnique(found, extra);
  for (const line of script.split(/\n/)) {
    const speaker = matchSpeaker(line);
    if (speaker) pushUnique(found, speaker.name);
    for (const name of honorificNames(line)) pushUnique(found, name);
  }
  return found;
}

function canon(name: string, known: string[]): string {
  return known.find((item) => eqName(item, name)) ?? titleCaseName(name);
}

function clauseAbsents(line: string, name: string): boolean {
  return line
    .split(/[.!?;]/)
    .some((clause) => containsName(clause, name) && ABSENT.test(clause));
}

export function inferPresence(source: string, knownNames: string[]): Presence {
  const known = extractNames(source, knownNames);
  const present: string[] = [];
  const mentioned: string[] = [];

  const add = (bucket: string[], name: string) => pushUnique(bucket, canon(name, known));

  for (const rawLine of source.split(/\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const speaker = matchSpeaker(line);
    if (speaker) {
      if (isOffscreen(speaker.cue)) add(mentioned, speaker.name);
      else add(present, speaker.name);
      for (const name of known) {
        if (eqName(name, speaker.name)) continue;
        if (containsName(speaker.utterance, name)) add(mentioned, name);
      }
      continue;
    }
    if (/^(?:cảnh|canh|scene|sc|int\.|ext\.|i\/e\.|int\/ext\.)/i.test(line)) continue;
    for (const name of known) {
      const isYou = eqName(name, "You");
      if (isYou && YOU_POSSESSIVE_LINE.test(line)) {
        add(present, name);
        continue;
      }
      if (!containsName(line, name)) continue;
      if (clauseAbsents(line, name)) {
        add(mentioned, name);
        continue;
      }
      // Gọi/nhắn với You: chỉ có tiếng hoặc chữ, không vào khung. Cảnh người đó tự hành động (không có You trong mệnh đề) vẫn hiện.
      const clauses = line.split(/[.!?;]/).filter((clause) => containsName(clause, name));
      const remote = REMOTE_CUE.test(line) && clauses.length > 0 && clauses.every((clause) => SECOND_PERSON.test(clause));
      const onScreen = isYou || !remote;
      add(onScreen ? present : mentioned, name);
    }
  }

  const mentionedOnly = mentioned.filter((name) => !present.some((item) => eqName(item, name)));
  return { present, mentionedOnly };
}

const BODY_PART =
  "(?:hands?|arms?|palms?|fingers?|fists?|wrists?|faces?|heads?|eyes?|shoulders?|backs?|chests?|bodies|body|feet|foot|legs?|thumbs?|necks?|index\\s+fingers?)";
const BODY_MOD = "(?:left|right|bare|gloved|own|upper|lower|both)\\s+";
const BARE_BODY = new RegExp(`^(?:(?:the|a|an)\\s+)?(?:${BODY_MOD})*${BODY_PART}$`, "iu");
const YOUR_BODY = new RegExp(`^(?:your|my)\\s+(?:${BODY_MOD})*${BODY_PART}$`, "iu");
const THEIR_BODY = new RegExp(`^(?:his|her|their)\\s+(?:${BODY_MOD})*${BODY_PART}$`, "iu");
const NAME_BODY = new RegExp(
  `^([\\p{L}][\\p{L}0-9'’.\\-]*(?:\\s+[\\p{L}][\\p{L}0-9'’.\\-]*){0,3})(?:'s|’s)\\s+(?:${BODY_MOD})*${BODY_PART}$`,
  "iu",
);
const NARRATOR_LABEL = /^(?:the\s+)?(?:protagonist|narrator|main character|viewer|reader)$/iu;
const YOU_POSSESSIVE = /\b(?:your|yours|yourself|yourselves)\b/i;

/**
 * "Your Hand", "Derek's left arm" không phải nhân vật riêng.
 * Quy về chủ nhân nếu biết (Your/My → You); bộ phận không chủ thì bỏ, không title-case thành "Your Hand".
 */
export function normalizeCastName(raw: string, knownNames: string[]): string | null {
  // Model đôi khi ghi luôn thẻ Flow vào visible_cast ("@you"): bỏ @ trước khi so roster.
  const text = raw.normalize("NFC").replace(/\s+/g, " ").trim().replace(/^@+/, "");
  if (!text) return null;
  const known = knownNames.find((item) => eqName(item, text));
  if (known) return known;
  if (BARE_BODY.test(text) || THEIR_BODY.test(text)) return null;
  if (YOUR_BODY.test(text)) return knownNames.find((item) => eqName(item, "You")) ?? null;
  // Nhãn chung cho người kể (model hay ghi "The Protagonist"): quy về You nếu roster có You.
  if (NARRATOR_LABEL.test(text)) {
    const you = knownNames.find((item) => eqName(item, "You"));
    if (you) return you;
  }
  const owned = text.match(NAME_BODY);
  if (owned?.[1]) {
    const owner = owned[1].trim();
    return knownNames.find((item) => eqName(item, owner)) ?? titleCaseName(owner);
  }
  return titleCaseName(text);
}

export function normalizeVisibleCast(raw: string[] | undefined, knownNames: string[]): string[] {
  const out: string[] = [];
  for (const name of raw ?? []) {
    const normalized = normalizeCastName(name, knownNames);
    if (normalized && !out.some((item) => eqName(item, normalized))) out.push(normalized);
  }
  return out;
}

/** Giống containsName, thêm "your/yours/yourself" khi nhân vật là You (POV ngôi thứ nhất). */
export function mentionsName(text: string, name: string): boolean {
  if (containsName(text, name)) return true;
  return eqName(name, "You") && YOU_POSSESSIVE.test(text);
}

export function splitExtraNames(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}
