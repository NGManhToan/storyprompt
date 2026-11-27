import { composeFlowPrompt, referencesFor } from "./flow.js";
import type { Scene, SceneResult } from "./types.js";

export function wrapPrompt(body: string, prefix: string, footer: string): string {
  return [prefix.trim(), body.trim(), footer.trim()].filter(Boolean).join(" ");
}

export type FlowOptions = { prefix: string; footer: string; roster?: string[]; aspectRatio?: string };

export type FlowScene = { id: string; time: string; references: string[]; prompt: string };

function usable(result: SceneResult | undefined): result is SceneResult {
  return Boolean(result?.prompt) && (result!.status === "accepted" || result!.status === "edited");
}

export function flowScenes(scenes: Scene[], results: SceneResult[], options: FlowOptions): FlowScene[] {
  return scenes.flatMap((scene) => {
    const result = results.find((item) => item.sceneId === scene.sceneId);
    if (!usable(result)) return [];
    const cast = result.visibleCast ?? [];
    return [
      {
        id: scene.sceneId,
        time: scene.timeRange || (scene.start || scene.end ? `${scene.start} - ${scene.end}` : ""),
        references: referencesFor(cast, options.roster ?? []),
        prompt: composeFlowPrompt(result.prompt, cast, options.prefix, options.footer),
      },
    ];
  });
}

export function toFlowHandoff(scenes: Scene[], results: SceneResult[], options: FlowOptions) {
  return {
    format: "storyprompt-flow-v2",
    generator: "storyprompt-web",
    createdAt: new Date().toISOString(),
    aspectRatio: options.aspectRatio ?? "16:9",
    characters: options.roster ?? [],
    scenes: flowScenes(scenes, results, options),
  };
}

/** Chỉ prompt, mỗi cảnh một đoạn (dán thẳng vào Flow). */
export function toCopyText(scenes: Scene[], results: SceneResult[], options: FlowOptions): string {
  return flowScenes(scenes, results, options)
    .map((scene) => `[${scene.id}] ${scene.prompt}`)
    .join("\n\n");
}

/** Bản dán Flow có kèm danh sách ảnh tham chiếu cần gắn cho từng cảnh. */
export function toFlowSheet(scenes: Scene[], results: SceneResult[], options: FlowOptions): string {
  const rows = flowScenes(scenes, results, options);
  if (!rows.length) return "";
  const head = [
    "# StoryPrompt → Google Flow",
    `# Tỷ lệ khung (chọn trong Flow): ${options.aspectRatio ?? "16:9"}`,
    `# Ảnh nhân vật cần tải lên project, đặt tên đúng: ${(options.roster ?? []).join(", ") || "(chưa có)"}`,
    "# Mỗi cảnh: gắn đúng ảnh ở dòng 'Ảnh tham chiếu', rồi dán dòng prompt.",
  ].join("\n");
  const body = rows
    .map((row) =>
      [
        `=== Cảnh ${row.id}${row.time ? ` · ${row.time}` : ""}`,
        `Ảnh tham chiếu: ${row.references.length ? row.references.map((name) => `@${name}`).join(", ") : "(không có nhân vật)"}`,
        row.prompt,
      ].join("\n"),
    )
    .join("\n\n");
  return `${head}\n\n${body}\n`;
}

export function toNumberedText(scenes: Scene[], results: SceneResult[], options: FlowOptions): string {
  return flowScenes(scenes, results, options)
    .map((scene) => {
      const number = Number(scene.id.replace(/\D/g, "")) || scene.id;
      return `${number}_${scene.prompt}`;
    })
    .join("\n\n");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(scenes: Scene[], results: SceneResult[], options: FlowOptions): string {
  const header = ["Scene", "Time", "Cut", "Environment", "Shot", "Camera", "References", "Source", "Prompt"];
  const rows = scenes.map((scene) => {
    const result = results.find((item) => item.sceneId === scene.sceneId);
    const ok = usable(result);
    const cast = ok ? result.visibleCast ?? [] : [];
    const prompt = ok ? composeFlowPrompt(result.prompt, cast, options.prefix, options.footer) : "";
    return [
      scene.sceneId,
      csvCell(scene.timeRange || `${scene.start} - ${scene.end}`),
      csvCell(scene.cutReason || ""),
      csvCell(result?.environment || ""),
      csvCell(result?.shotSequence || ""),
      csvCell(result?.cameraAngle || ""),
      csvCell(referencesFor(cast, options.roster ?? []).join(", ")),
      csvCell(scene.source),
      csvCell(prompt),
    ].join(",");
  });
  return `\uFEFF${[header.join(","), ...rows].join("\n")}`;
}
