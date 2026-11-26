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
  return /(v\.?\s*o\.?|o\.?\s*s\.?|off)/i.test(cue);
}

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
      if (!containsName(line, name)) continue;
      if (clauseAbsents(line, name)) add(mentioned, name);
      else add(present, name);
    }
  }

  const mentionedOnly = mentioned.filter((name) => !present.some((item) => eqName(item, name)));
  return { present, mentionedOnly };
}

export function splitExtraNames(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}
