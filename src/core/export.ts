import type { Scene, SceneResult } from "./types.js";

export function wrapPrompt(body: string, prefix: string, footer: string): string {
  return [prefix.trim(), body.trim(), footer.trim()].filter(Boolean).join(" ");
}

export function flowScenes(scenes: Scene[], results: SceneResult[], prefix: string, footer: string) {
  return scenes.flatMap((scene) => {
    const result = results.find((item) => item.sceneId === scene.sceneId);
    if (!result?.prompt) return [];
    if (result.status !== "accepted" && result.status !== "edited") return [];
    return [{ id: scene.sceneId, prompt: wrapPrompt(result.prompt, prefix, footer) }];
  });
}

export function toFlowHandoff(scenes: Scene[], results: SceneResult[], prefix: string, footer: string) {
  return {
    format: "storyprompt-flow-v1",
    generator: "storyprompt-web",
    createdAt: new Date().toISOString(),
    scenes: flowScenes(scenes, results, prefix, footer),
  };
}

export function toCopyText(scenes: Scene[], results: SceneResult[], prefix: string, footer: string): string {
  return flowScenes(scenes, results, prefix, footer)
    .map((scene) => `[${scene.id}] ${scene.prompt}`)
    .join("\n\n");
}

export function toNumberedText(scenes: Scene[], results: SceneResult[], prefix: string, footer: string): string {
  return flowScenes(scenes, results, prefix, footer)
    .map((scene) => {
      const number = Number(scene.id.replace(/\D/g, "")) || scene.id;
      return `${number}_${scene.prompt}`;
    })
    .join("\n\n");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(scenes: Scene[], results: SceneResult[], prefix: string, footer: string): string {
  const header = ["Scene", "Time", "Cut", "Environment", "Shot", "Camera", "Source", "Prompt"];
  const rows = scenes.map((scene) => {
    const result = results.find((item) => item.sceneId === scene.sceneId);
    const prompt = result?.prompt && (result.status === "accepted" || result.status === "edited") ? wrapPrompt(result.prompt, prefix, footer) : "";
    return [
      scene.sceneId,
      csvCell(scene.timeRange || `${scene.start} - ${scene.end}`),
      csvCell(scene.cutReason || ""),
      csvCell(result?.environment || ""),
      csvCell(result?.shotSequence || ""),
      csvCell(result?.cameraAngle || ""),
      csvCell(scene.source),
      csvCell(prompt),
    ].join(",");
  });
  return `\uFEFF${[header.join(","), ...rows].join("\n")}`;
}
