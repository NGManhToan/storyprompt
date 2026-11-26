import { parseCues, parseSrt } from "./srt.js";
import type { Cue, ParseResult, Scene } from "./types.js";

export type ChunkMode = "headings" | "fixed" | "sense";

function evenDuration(seconds: number): number {
  let value = seconds || 8;
  if (value % 2 !== 0) value = value === 7 ? 8 : Math.round(value / 2) * 2;
  if (value < 4) value = 4;
  return value;
}

function timecodeToSeconds(timeStr: string): number {
  const normalized = timeStr.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2) return 0;
  const numbers = parts.map((part) => Number.parseFloat(part) || 0);
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return numbers[0] * 60 + numbers[1];
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function cleanLine(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type TimedLine = { start: number; end: number; text: string };

function cuesToLines(cues: Cue[]): TimedLine[] {
  return cues.map((cue) => ({
    start: timecodeToSeconds(cue.start),
    end: timecodeToSeconds(cue.end),
    text: cleanLine(cue.text),
  }));
}

function padId(index: number): string {
  return String(index).padStart(3, "0");
}

function holdSource(text: string): string {
  const clean = text.trim();
  return clean || "No dialogue. Hold the current location.";
}

function makeScene(index: number, source: string, start: number, end: number, cutReason: string): Scene {
  const duration = Math.max(0, end - start);
  return {
    sceneId: padId(index),
    title: cutReason,
    heading: "",
    source: holdSource(source),
    start: formatClock(start),
    end: formatClock(end),
    cueIndexes: [],
    timeRange: `${formatClock(start)} - ${formatClock(end)}`,
    cutReason,
    durationSeconds: duration,
  };
}

export function chunkFixed(lines: TimedLine[], durationSeconds = 8): Scene[] {
  if (!lines.length) return [];
  const duration = evenDuration(durationSeconds);
  const last = Math.max(...lines.map((line) => line.end));
  const count = Math.max(1, Math.ceil(last / duration));
  const scenes: Scene[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * duration;
    const end = start + duration;
    const texts: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.start < end && line.end > start && line.text && !seen.has(line.text)) {
        seen.add(line.text);
        texts.push(line.text);
      }
    }
    scenes.push(makeScene(index + 1, texts.join(" "), start, end, `Cố định ${duration}s`));
  }
  return scenes;
}

export function chunkSense(lines: TimedLine[], durationSeconds = 8): Scene[] {
  if (!lines.length) return [];
  const target = evenDuration(durationSeconds);
  const minDuration = Math.max(4, target - 2);
  const maxDuration = Math.max(minDuration + 2, target + 2);
  const scenes: Scene[] = [];
  let group: TimedLine[] = [];
  let sceneStart = lines[0].start;
  let clock = 0;

  const terminal = (text: string) => /[.!?…]+["'»”)]?\s*$/.test(text.trim());
  const clause = (text: string) => /[,;:—–-]+["'»”)]?\s*$/.test(text.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (!group.length) sceneStart = line.start;
    group.push(line);
    const elapsed = line.end - sceneStart;
    const gap = next ? next.start - line.end : 0;
    let cut = false;
    let reason = "Cụm nghĩa";
    if (!next) {
      cut = true;
      reason = "Kết thúc phụ đề";
    } else if (elapsed >= minDuration && terminal(line.text)) {
      cut = true;
      reason = "Trọn câu";
    } else if (elapsed >= minDuration && gap >= 0.45) {
      cut = true;
      reason = `Khoảng dừng ${gap.toFixed(1)}s`;
    } else if (elapsed >= target && clause(line.text)) {
      cut = true;
      reason = "Ngắt ý";
    } else if (elapsed >= maxDuration) {
      cut = true;
      reason = `Tối đa ${target}s`;
    } else if (next && elapsed >= 4.5 && next.end - sceneStart > maxDuration && (terminal(line.text) || clause(line.text) || gap >= 0.45)) {
      cut = true;
      reason = "Cân đối độ dài";
    }
    if (!cut) continue;
    const seen = new Set<string>();
    const texts = group.map((item) => item.text).filter((text) => {
      if (!text || seen.has(text)) return false;
      seen.add(text);
      return true;
    });
    let even = Math.round((line.end - sceneStart) / 2) * 2;
    if (even < 4) even = 4;
    const start = clock;
    const end = start + even;
    clock = end;
    scenes.push(makeScene(scenes.length + 1, texts.join(" "), start, end, reason));
    group = [];
  }
  return scenes;
}

export function chunkPlainText(raw: string, mode: "by_line" | "by_sentences", durationSeconds = 8): Scene[] {
  const duration = evenDuration(durationSeconds);
  const clean = raw.replace(/^\uFEFF/, "").trim();
  if (!clean) return [];
  let pieces: { text: string; reason: string }[] = [];
  if (mode === "by_line") {
    pieces = clean
      .split(/\r?\n+/)
      .map((line) => cleanLine(line))
      .filter(Boolean)
      .map((text) => ({ text, reason: "Theo dòng" }));
  } else {
    const sentences = clean
      .replace(/([.!?…]+)/g, "$1|")
      .split("|")
      .map((part) => cleanLine(part))
      .filter(Boolean);
    const size = duration >= 8 ? 3 : 2;
    for (let index = 0; index < sentences.length; index += size) {
      pieces.push({ text: sentences.slice(index, index + size).join(" "), reason: "Cụm câu" });
    }
  }
  return pieces.map((piece, index) => makeScene(index + 1, piece.text, index * duration, (index + 1) * duration, piece.reason));
}

export function buildScenes(
  raw: string,
  options: { mode: ChunkMode; duration?: number; kind: "srt" | "txt"; txtMode?: "by_line" | "by_sentences" },
): ParseResult & { kind: "srt" | "txt" } {
  const duration = options.duration ?? 8;
  if (options.kind === "txt") {
    const scenes = chunkPlainText(raw, options.txtMode ?? "by_line", duration);
    return {
      kind: "txt",
      cues: [],
      scenes,
      warnings: scenes.length ? [`Đã cắt TXT thành ${scenes.length} cảnh.`] : ["File TXT không có dòng chữ."],
    };
  }
  if (options.mode === "headings") {
    const parsed = parseSrt(raw);
    return { ...parsed, kind: "srt" };
  }
  const cues = parseCues(raw);
  const lines = cuesToLines(cues);
  const scenes = options.mode === "sense" ? chunkSense(lines, duration) : chunkFixed(lines, duration);
  const warnings = [
    options.mode === "sense"
      ? `Đã cắt theo cụm nghĩa, mốc khoảng ${evenDuration(duration)} giây: ${scenes.length} cảnh.`
      : `Đã cắt cố định ${evenDuration(duration)} giây: ${scenes.length} cảnh.`,
  ];
  if (!cues.length) warnings.push("File không có cue SRT nào.");
  return { kind: "srt", cues, scenes, warnings };
}
