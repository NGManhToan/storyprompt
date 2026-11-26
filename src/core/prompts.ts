import type { GenerateRequest, SceneDraft, SceneTask, StoryBible } from "./types.js";

export const SCENE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          scene_id: { type: "string" },
          title: { type: "string" },
          environment: { type: "string" },
          prompt: { type: "string" },
          visible_cast: { type: "array", items: { type: "string" } },
          source_anchor: { type: "string" },
        },
        required: ["scene_id", "title", "environment", "prompt", "visible_cast", "source_anchor"],
      },
    },
  },
  required: ["scenes"],
};

export const BIBLE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          note: { type: "string" },
        },
        required: ["name", "note"],
      },
    },
    locations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          lighting: { type: "string" },
        },
        required: ["name", "lighting"],
      },
    },
  },
  required: ["characters", "locations"],
};

export const SYSTEM_SCENES = `You are a storyboard artist writing still-image prompts for Google Flow.
Return JSON only, matching the schema. No markdown.
Write one object for every requested scene_id. Do not skip an id. Do not invent ids.
prompt: one English sentence of 28 to 42 words. Include a concrete physical action happening now, the place, the light, and the camera. End with a period.
Do not describe clothing, face, age, hair, body, skin, or colors of people. Reference images carry appearance. Use character names only.
Do not write dialogue, quotations, subtitles, captions, signs with readable words, watermarks, or title cards.
Do not use @tags or hex color codes.
visible_cast: only people whose bodies are inside the frame, doing the action. Exclude anyone who is only spoken about. Exclude voice-over and off-screen names.
environment: a short English location name.
title: a short English scene title.
source_anchor: an exact short quote copied from THIS scene's source that justifies the action. Never quote a READ-ONLY neighbor.
Neighbor blocks are continuity only. Never borrow their actions, props, or blocking.
Each prompt must be visually distinct from the others in this batch.
If a previous draft was rejected, repair only the named faults.`;

export function systemForScenes(bible: boolean): string {
  if (!bible) {
    return `${SYSTEM_SCENES}\nInvent the lighting from this scene's own source lines.`;
  }
  return `${SYSTEM_SCENES}\nA story bible is included. Reuse a few words of the matching location lighting inside the 28-42 word sentence. Do not add actions from other scenes.`;
}

export const SYSTEM_BIBLE = `You extract a story bible for image-prompt consistency.
Return JSON only.
characters: names only, plus a short note about when they are on camera. Never describe appearance, wardrobe, age, or body.
locations: distinct places and the lighting that should stay stable there.
Do not write image prompts.`;

export function estimateTokens(systemText: string, promptText: string, maxOutputTokens: number): number {
  return Math.ceil((systemText.length + promptText.length) / 4) + Math.ceil(maxOutputTokens * 0.25);
}

function bibleBlock(bible?: StoryBible | null): string {
  if (!bible) return "";
  const people = bible.characters
    .map((character) => `- ${character.name}: ${character.note}`)
    .join("\n");
  const places = bible.locations
    .map((location) => `- ${location.name}: ${location.lighting}`)
    .join("\n");
  return [
    "STORY BIBLE (consistency of place and light only. Do not import actions from other scenes. Do not describe appearance.)",
    "Characters:",
    people || "- (none)",
    "Locations:",
    places || "- (none)",
  ].join("\n");
}

function renderTask(task: SceneTask): string {
  const neighbors = task.neighbors
    .map(
      (neighbor) =>
        `### SCENE ${neighbor.sceneId}\nSTATUS: READ-ONLY NEIGHBOR. Do not depict this action, prop, or blocking.\nTITLE: ${neighbor.title}\nSOURCE:\n${neighbor.source}`,
    )
    .join("\n\n");
  return [
    `### SCENE ${task.sceneId}`,
    "STATUS: WRITE THIS SCENE ONLY",
    `TITLE: ${task.title}`,
    `LIKELY ON CAMERA (hint, confirm against the source): ${task.likelyPresent.join(", ") || "(no person)"}`,
    "SOURCE:",
    task.source,
    task.feedback ? `PREVIOUS DRAFT REJECTED: ${task.feedback}` : "",
    neighbors ? `NEIGHBOR CONTEXT\n${neighbors}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSceneRequest(args: {
  tasks: SceneTask[];
  knownNames: string[];
  bible?: StoryBible | null;
  maxOutputTokens: number;
  temperature: number;
}): GenerateRequest {
  const systemText = systemForScenes(Boolean(args.bible));
  const promptText = [
    `ROSTER (names only, no appearance): ${args.knownNames.join(", ") || "(discover from the sources)"}`,
    bibleBlock(args.bible),
    "Write every scene marked WRITE. Skip nothing.",
    args.tasks.map(renderTask).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    kind: "scenes",
    systemText,
    promptText,
    responseSchema: SCENE_RESPONSE_SCHEMA,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
    sceneIds: args.tasks.map((task) => task.sceneId),
    tasks: args.tasks,
    estimatedTokens: estimateTokens(systemText, promptText, args.maxOutputTokens),
  };
}

export function buildBibleRequest(args: {
  digest: string;
  knownNames: string[];
  maxOutputTokens: number;
}): GenerateRequest {
  const systemText = SYSTEM_BIBLE;
  const promptText = [
    `ROSTER: ${args.knownNames.join(", ") || "(none yet)"}`,
    "SCENE DIGEST:",
    args.digest,
  ].join("\n\n");
  return {
    kind: "bible",
    systemText,
    promptText,
    responseSchema: BIBLE_RESPONSE_SCHEMA,
    maxOutputTokens: args.maxOutputTokens,
    temperature: 0.2,
    sceneIds: [],
    tasks: [],
    estimatedTokens: estimateTokens(systemText, promptText, args.maxOutputTokens),
  };
}

export function bibleDigest(scenes: { sceneId: string; title: string; source: string }[]): string {
  const blocks = scenes.map((scene) => {
    const action =
      scene.source
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !/^(?:cảnh|canh|scene|int\.|ext\.)/i.test(line) && !/:\s+\S/.test(line)) ??
      scene.title;
    return `[${scene.sceneId}] ${scene.title}\n${action}`;
  });
  let text = blocks.join("\n\n");
  if (text.length > 24_000) text = `${text.slice(0, 24_000)}\n…`;
  return text;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Phản hồi không phải JSON.");
  }
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,|/]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function parseScenePayload(text: string): SceneDraft[] {
  const data = extractJson(text) as { scenes?: unknown };
  if (!data || typeof data !== "object" || !Array.isArray(data.scenes)) {
    throw new Error("JSON thiếu mảng scenes.");
  }
  return data.scenes.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      scene_id: String(record.scene_id ?? record.sceneId ?? "").trim(),
      title: String(record.title ?? "").trim(),
      environment: String(record.environment ?? "").trim(),
      prompt: String(record.prompt ?? "").trim(),
      visible_cast: asStringArray(record.visible_cast ?? record.visibleCast),
      source_anchor: String(record.source_anchor ?? record.sourceAnchor ?? "").trim(),
    };
  });
}

export function parseBiblePayload(text: string): StoryBible {
  const data = extractJson(text) as { characters?: unknown; locations?: unknown };
  const characters = Array.isArray(data.characters)
    ? data.characters.map((row) => {
        const record = row as Record<string, unknown>;
        return { name: String(record.name ?? "").trim(), note: String(record.note ?? "").trim() };
      }).filter((row) => row.name)
    : [];
  const locations = Array.isArray(data.locations)
    ? data.locations.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          name: String(record.name ?? "").trim(),
          lighting: String(record.lighting ?? "").trim(),
        };
      }).filter((row) => row.name && row.lighting)
    : [];
  if (!locations.length) throw new Error("Story bible thiếu địa điểm và ánh sáng.");
  return { characters, locations };
}

export function buildGeminiBody(request: GenerateRequest): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text: request.promptText }] }],
    systemInstruction: { parts: [{ text: request.systemText }] },
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: request.responseSchema,
    },
  };
}
