import type { Cue, ParseResult, Scene } from "./types.js";

const TIME =
  /(\d{2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{1,3})/;

const NUMBERED_HEAD =
  /^(?:cảnh|canh|scene|sc)\s*[:.#-]?\s*(\d+)\b(.*)$/i;

const SLUG_HEAD = /^(?:int\.?|ext\.?|i\/e\.?|int\/ext\.?|nội\.?|ngoại\.?)\b/i;

function clean(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseCues(raw: string): Cue[] {
  const blocks = clean(raw)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let cursor = 0;
    if (/^\d+$/.test(lines[0]?.trim() ?? "") && (lines[1]?.includes("-->") ?? false)) {
      cursor = 1;
    }
    const timeLine = lines[cursor] ?? "";
    const match = timeLine.match(TIME);
    if (!match) continue;
    const text = lines.slice(cursor + 1).join("\n").trim();
    if (!text) continue;
    cues.push({
      index: cues.length + 1,
      start: match[1],
      end: match[2],
      text,
    });
  }
  return cues;
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  return NUMBERED_HEAD.test(trimmed) || SLUG_HEAD.test(trimmed);
}

function headingNumber(line: string): string | null {
  const match = line.trim().match(NUMBERED_HEAD);
  return match?.[1] ?? null;
}

export function cleanTitle(heading: string): string {
  const stripped = heading
    .trim()
    .replace(/^(?:cảnh|canh|scene|sc)\s*[:.#-]?\s*\d+\s*[.\-:—–]?\s*/i, "")
    .trim();
  return stripped || heading.trim();
}

function padId(num: string): string {
  return num.padStart(3, "0");
}

export function parseSrt(raw: string): ParseResult {
  const cues = parseCues(raw);
  const warnings: string[] = [];
  if (!cues.length) {
    warnings.push("File không có cue SRT nào.");
    return { cues, scenes: [], warnings };
  }

  const anyHeading = cues.some((cue) => cue.text.split("\n").some((line) => isHeadingLine(line)));
  if (!anyHeading) {
    warnings.push("Không thấy tiêu đề cảnh. Mỗi cue được tính là một cảnh.");
    const scenes = cues.map((cue, index) => ({
      sceneId: padId(String(index + 1)),
      title: cue.text.split("\n")[0]?.trim().slice(0, 80) || `Cảnh ${index + 1}`,
      heading: "",
      source: cue.text.trim(),
      start: cue.start,
      end: cue.end,
      cueIndexes: [cue.index],
    }));
    return { cues, scenes, warnings };
  }

  type Draft = {
    heading: string;
    lines: string[];
    cues: Cue[];
  };

  const drafts: Draft[] = [];
  const lead: Cue[] = [];
  let current: Draft | null = null;

  for (const cue of cues) {
    const lines = cue.text.split("\n");
    const headingIndex = lines.findIndex((line) => isHeadingLine(line));
    if (headingIndex === -1) {
      if (current) {
        current.lines.push(cue.text.trim());
        current.cues.push(cue);
      } else {
        lead.push(cue);
      }
      continue;
    }
    if (current) drafts.push(current);
    const heading = lines[headingIndex].trim();
    const rest = lines
      .filter((_, index) => index !== headingIndex)
      .join("\n")
      .trim();
    current = { heading, lines: rest ? [rest] : [], cues: [cue] };
  }
  if (current) drafts.push(current);

  if (lead.length && drafts.length) {
    warnings.push("Có lời thoại trước cảnh đầu. Phần đó được gắn vào cảnh đầu tiên.");
    drafts[0].lines.unshift(...lead.map((cue) => cue.text.trim()));
    drafts[0].cues.unshift(...lead);
  }

  const used = new Set<string>();
  const dupCount = new Map<string, number>();
  const scenes: Scene[] = drafts.map((draft, index) => {
    const num = headingNumber(draft.heading) ?? String(index + 1);
    let sceneId = padId(num);
    if (used.has(sceneId)) {
      const next = (dupCount.get(sceneId) ?? 1) + 1;
      dupCount.set(sceneId, next);
      const aliased = `${sceneId}-${next}`;
      warnings.push(`Trùng số cảnh ${sceneId}. Đổi thành ${aliased}.`);
      sceneId = aliased;
    }
    used.add(sceneId);
    const ordered = [...draft.cues].sort((a, b) => a.index - b.index);
    return {
      sceneId,
      title: cleanTitle(draft.heading),
      heading: draft.heading,
      source: [draft.heading, ...draft.lines].filter(Boolean).join("\n").trim(),
      start: ordered[0]?.start ?? "",
      end: ordered[ordered.length - 1]?.end ?? "",
      cueIndexes: ordered.map((cue) => cue.index),
    };
  });

  return { cues, scenes, warnings };
}
