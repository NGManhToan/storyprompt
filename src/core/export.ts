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
