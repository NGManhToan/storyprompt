import { inferPresence } from "./cast.js";
import { expectedOutput, outputBudget } from "./laneLimits.js";
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
          camera_angle: { type: "string" },
          shot_sequence: { type: "string" },
          visual_action: { type: "string" },
        },
        required: [
          "scene_id",
          "title",
          "environment",
          "prompt",
          "visible_cast",
          "source_anchor",
          "camera_angle",
          "shot_sequence",
          "visual_action",
        ],
      },
    },
  },
  required: ["scenes"],
};

/**
 * Schema riêng cho từng lô: đúng N hàng (minItems = maxItems = N) và scene_id chỉ được là các id của lô.
 * Gemini structured output hỗ trợ minItems/maxItems/enum (không hỗ trợ uniqueItems), nên trùng id vẫn phải lọc ở pipeline.
 */
/**
 * Gemini từ chối schema có quá nhiều trạng thái ("too many states for serving") khi lô lớn có cả enum id
 * lẫn minItems/maxItems (đo 27/11: lô 44 cảnh bị 400, lô 20 cảnh qua). Trên ngưỡng này bỏ các ràng buộc đó;
 * validator vẫn bắt id lạ, trùng và thiếu nên chất lượng prompt không đổi.
 */
export const STRICT_SCHEMA_MAX_IDS = 24;

/** Bỏ enum/minItems/maxItems khỏi schema cảnh (dùng khi lô lớn hoặc khi nhà cung cấp kêu schema quá phức tạp). */
export function relaxSceneSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const base = schema as { properties?: { scenes?: { items?: { properties?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown> } } & Record<string, unknown>;
  const scenes = base.properties?.scenes;
  if (!scenes?.items?.properties) return schema;
  const { minItems: _min, maxItems: _max, ...rest } = scenes as Record<string, unknown>;
  return {
    ...base,
    properties: {
      ...base.properties,
      scenes: {
        ...rest,
        items: { ...scenes.items, properties: { ...scenes.items.properties, scene_id: { type: "string" } } },
      },
    },
  };
}

export function sceneSchemaFor(sceneIds: string[]): Record<string, unknown> {
  const base = SCENE_RESPONSE_SCHEMA as {
    properties: { scenes: { items: { properties: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown> };
  } & Record<string, unknown>;
  const items = base.properties.scenes.items;
  const ids = [...new Set(sceneIds)];
  if (ids.length > STRICT_SCHEMA_MAX_IDS) return relaxSceneSchema(base);
  return {
    ...base,
    properties: {
      scenes: {
        ...base.properties.scenes,
        ...(ids.length ? { minItems: ids.length, maxItems: ids.length } : {}),
        items: {
          ...items,
          properties: {
            ...items.properties,
            scene_id: ids.length ? { type: "string", enum: ids } : { type: "string" },
          },
        },
      },
    },
  };
}

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

export const AESTHETIC_FOOTER =
  "modern 2D webtoon comic style, crisp ink line art, cel-shaded, warm daylight, clean frame, no text, 16:9";

export const SYSTEM_SCENES = `You are an expert cinematic storyboard artist writing still-image prompts for Google Flow, in a long-form 2D minimalist graphic-novel video essay.
Return JSON only, matching the schema. No markdown.
Write one object for every requested scene_id. Do not skip an id. Do not invent ids.

CROSS-REFERENCE:
MASTER_SCRIPT is the spatial anchor for the whole story. Find where each scene sits in that script and keep the current physical location until the story moves or the narration requires a cutaway.
Neighbor blocks are read-only. Never borrow their actions, props, or blocking.

CUTAWAY:
When this scene's own source describes a named character doing something or living through an event, show that character. Do not leave the protagonist in frame during that line.
When a name is only mentioned and the line gives them no action to depict, they stay out of frame. Off-screen and voice-over speakers stay out of frame.
Anyone who is only heard, called, texted or emailed (the other end of a phone call, voicemail, message or video call) is NOT in frame: never name them in the prompt and never list them in visible_cast. Show the phone, the screen, or the character who is holding it instead. A named character who is shown doing something on their own side of a call (for example arguing into a phone at their own desk) may be shown.

VARIETY:
Never make the same prop the subject of two consecutive shots.
If several scenes stay in one room, rotate the camera: a point-of-view interaction with an object, a wide shot of the room and the daylight, a detail close-up, then a medium shot. Give one environment three or four angles before changing location.
Change location only when the script moves or a cutaway is required.

LOOK:
Flat 2D cartoon illustration that must match the character reference images (clean outlines, flat colors). Do not write the style footer yourself. Code appends it.
Describe only physical action, posture, objects and place. NEVER write emotion words or labels (dread, panic, worried, worry, fear, afraid, anxious, nervous, terror, horror, hysteria, despair, agony, frantic, stress, tense, sad, angry, shock, uneasy). Convey tension only through mechanical facts: what the hands and objects are doing.
Light must be plain and even: "soft daylight", "plain overhead light", "warm lamp light". NEVER write dramatic or cinematic lighting: no long/deep/dark/harsh shadows, no "casting shadows", harsh, flickering, moody, dramatic, ominous, eerie, gloomy, noir, cinematic, glaring, neon glow. If the SOURCE itself uses a banned word (for example "harsh fluorescent lights"), do not copy it — rewrite as "plain overhead light" or "soft daylight".
prompt: one English sentence of 28 to 42 words, in this order: camera framing, who (tagged) does what action now, the place implied by the line, then the light. End with a period.
No dialogue, quotations, subtitles, captions, readable signs, or title cards.

LOCKED NAMES:
Use the roster names only. Never describe skin, face, hair, age, body, clothes, or colors of people. Reference images carry appearance (Google Flow attaches one reference image per tagged name).
Tag every on-camera roster character with an at-sign exactly as spelled in the roster, e.g. "@Name", and use third-person verbs: "@Name presses the button", "@Name's hand holds the card". Never put an at-sign on anything that is not a roster name. Do not write hex color codes.
For a hand shot, write whose hand it is with the tag, e.g. "point-of-view shot of @Name's hand", and the action, with no color.
Never replace a roster character with "a hand", "a person", "someone" or "the protagonist".
If a protagonist name is configured, use that name for the narrator's body.

visible_cast: only bodies inside the frame.
environment: short English location.
title: short English scene title.
camera_angle: framing, such as medium shot, wide shot, point-of-view, or detail.
shot_sequence: which angle this is inside the current location, such as Shot 2/4.
visual_action: one short English clause of the action.
source_anchor: an exact short quote from THIS scene's source. Never quote a read-only neighbor.
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

export function estimateInputTokens(systemText: string, promptText: string): number {
  return Math.ceil((systemText.length + promptText.length) / 3.6);
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

const NEIGHBOR_CHARS = 220;

function brief(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit).replace(/\s+\S*$/, "")} …`;
}

function renderTask(task: SceneTask, knownNames: string[] = []): string {
  const offFrame = knownNames.length ? inferPresence(task.source, knownNames).mentionedOnly : [];
  // Cảnh bên cạnh chỉ gửi tóm tắt ngắn: đủ để giữ không gian, không đủ chi tiết để model chép hành động.
  const neighbors = task.neighbors
    .map(
      (neighbor) =>
        `### SCENE ${neighbor.sceneId}\nSTATUS: READ-ONLY NEIGHBOR. Do not depict this action, prop, or blocking.\nTITLE: ${neighbor.title}\nGIST: ${brief(neighbor.source, NEIGHBOR_CHARS)}`,
    )
    .join("\n\n");
  return [
    `### SCENE ${task.sceneId}`,
    "STATUS: WRITE THIS SCENE ONLY",
    `TITLE: ${task.title}`,
    `LIKELY ON CAMERA (hint, confirm against the source): ${task.likelyPresent.join(", ") || "(no person)"}`,
    offFrame.length ? `OFF-FRAME (only heard, called, messaged or mentioned; do NOT name or show): ${offFrame.join(", ")}` : "",
    "SOURCE (only this text belongs to this scene; source_anchor must be copied verbatim from it):",
    task.source,
    task.feedback ? `PREVIOUS DRAFT REJECTED: ${task.feedback}` : "",
    neighbors ? `NEIGHBOR CONTEXT\n${neighbors}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const MASTER_CAP = 20_000;
/** Cửa sổ ngữ cảnh mặc định mỗi lô (ký tự). Trước đây gửi tới 20.000 ký tự master script mỗi lô. */
export const CONTEXT_WINDOW_CAP = 3_600;

export function clipMasterScript(text: string): { text: string; trimmed: boolean } {
  const clean = text.trim();
  if (clean.length <= MASTER_CAP) return { text: clean, trimmed: false };
  return { text: `${clean.slice(0, MASTER_CAP)}\n[master script trimmed for this request]`, trimmed: true };
}

/**
 * Lấy đoạn master script quanh vị trí của lô thay vì gửi cả kịch bản.
 * Tìm theo đoạn đầu lời thoại của cảnh đầu lô; nếu không thấy thì lấy theo tỷ lệ vị trí.
 */
export function windowMasterScript(
  master: string,
  probe: string,
  position: number,
  cap = CONTEXT_WINDOW_CAP,
): string {
  const clean = master.trim();
  if (clean.length <= cap) return clean;
  const needle = probe.replace(/\s+/g, " ").trim().slice(0, 40);
  const flat = clean.replace(/\s+/g, " ");
  let at = needle.length >= 12 ? flat.indexOf(needle) : -1;
  if (at < 0) at = Math.round(Math.min(1, Math.max(0, position)) * flat.length);
  const start = Math.max(0, Math.min(flat.length - cap, at - Math.round(cap * 0.35)));
  const slice = flat.slice(start, start + cap);
  return `${start > 0 ? "… " : ""}${slice}${start + cap < flat.length ? " …" : ""}`;
}

/** Cửa sổ ngữ cảnh theo cảnh: ±k cảnh quanh lô, mỗi cảnh một dòng tóm tắt. */
export function sceneContextWindow(
  scenes: { sceneId: string; title: string; source: string }[],
  batchIds: string[],
  k: number,
  cap = CONTEXT_WINDOW_CAP,
): string {
  if (!scenes.length || !batchIds.length || k <= 0) return "";
  const first = scenes.findIndex((scene) => scene.sceneId === batchIds[0]);
  const last = scenes.findIndex((scene) => scene.sceneId === batchIds[batchIds.length - 1]);
  if (first < 0 || last < 0) return "";
  const ids = new Set(batchIds);
  const rows = scenes
    .slice(Math.max(0, first - k), Math.min(scenes.length, last + k + 1))
    .filter((scene) => !ids.has(scene.sceneId))
    .map((scene) => `[${scene.sceneId}] ${scene.title}: ${brief(scene.source, 160)}`);
  let text = rows.join("\n");
  if (text.length > cap) text = `${text.slice(0, cap)} …`;
  return text;
}

export function buildSceneRequest(args: {
  tasks: SceneTask[];
  knownNames: string[];
  bible?: StoryBible | null;
  maxOutputTokens: number;
  temperature: number;
  masterScript?: string;
  /** Cửa sổ ngữ cảnh đã cắt sẵn (ưu tiên hơn masterScript). */
  contextWindow?: string;
  topic?: string;
  protagonist?: string;
  preferFallbackModel?: boolean;
}): GenerateRequest {
  const systemText = systemForScenes(Boolean(args.bible));
  const master = args.masterScript?.trim() ? clipMasterScript(args.masterScript) : null;
  const context = args.contextWindow?.trim();
  const promptText = [
    args.topic?.trim() ? `VIDEO TOPIC: ${args.topic.trim()}` : "",
    `ROSTER (names only, no appearance): ${args.knownNames.join(", ") || "(discover from the sources)"}`,
    args.protagonist?.trim() ? `PROTAGONIST NAME (locked token, no appearance): ${args.protagonist.trim()}` : "",
    args.knownNames.some((name) => name.toLowerCase() === "you")
      ? 'NARRATOR: the narration is second person, and "You" is a roster character with a reference image. When this scene\'s source has "you" acting, show @You using exactly one of these shot forms: "First-person POV of @You\'s hand holding/pressing/opening ...", "Medium shot of @You looking at ...", or "Over-the-shoulder shot from behind @You ...". List "You" in visible_cast. Never replace @You with "a hand", "a person", "someone" or "the protagonist". Do not write any skin color or hex code: code adds the skin-color clause after "@You\'s hand". When the line is a cutaway to another named character\'s own action, show that character instead.'
      : "",
    context
      ? `STORY CONTEXT WINDOW (spatial anchor only. Do not depict actions from scenes you are not writing.):\n${context}`
      : master
        ? `MASTER_SCRIPT (spatial anchor only. Do not depict actions from scenes you are not writing.):\n${master.text}`
        : "",
    bibleBlock(args.bible),
    `Write exactly ${args.tasks.length} scene object(s), one per scene_id: ${args.tasks.map((task) => task.sceneId).join(", ")}. Never repeat a scene_id. Skip nothing.`,
    "Each prompt: 30-40 English words (hard limit 28-42) — count before answering. Never show readable text, letters, labels or UI words in the image.",
    args.tasks.map((task) => renderTask(task, args.knownNames)).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  const sceneIds = args.tasks.map((task) => task.sceneId);
  const maxOutputTokens = outputBudget(sceneIds.length, args.maxOutputTokens);
  const inputTokens = estimateInputTokens(systemText, promptText);
  const outputTokens = expectedOutput(sceneIds.length);
  return {
    kind: "scenes",
    systemText,
    promptText,
    responseSchema: sceneSchemaFor(sceneIds),
    maxOutputTokens,
    temperature: args.temperature,
    sceneIds,
    tasks: args.tasks,
    estimatedTokens: inputTokens + outputTokens,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    preferFallbackModel: args.preferFallbackModel,
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
    estimatedInputTokens: estimateInputTokens(systemText, promptText),
    estimatedOutputTokens: Math.ceil(args.maxOutputTokens * 0.5),
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
      camera_angle: String(record.camera_angle ?? record.cameraAngle ?? "").trim(),
      shot_sequence: String(record.shot_sequence ?? record.shotSequence ?? "").trim(),
      visual_action: String(record.visual_action ?? record.visualAction ?? "").trim(),
    };
  });
}

/** Lấy các object hoàn chỉnh trong mảng "scenes" của một JSON bị cắt giữa chừng. */
export function salvageScenes(text: string): SceneDraft[] {
  const start = text.indexOf("[", Math.max(0, text.indexOf('"scenes"')));
  if (start < 0) return [];
  const rows: string[] = [];
  let depth = 0;
  let begin = -1;
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) begin = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && begin >= 0) {
        rows.push(text.slice(begin, index + 1));
        begin = -1;
      }
    } else if (char === "]" && depth === 0) break;
  }
  const out: SceneDraft[] = [];
  for (const row of rows) {
    try {
      out.push(...parseScenePayload(`{"scenes":[${row}]}`));
    } catch {
      /* bỏ hàng hỏng */
    }
  }
  return out;
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

/** Gemini 4.x dùng thinkingLevel; AI Studio đặt LOW và bỏ maxOutputTokens/temperature cho mọi model. */
export function isThinkingGemini(model: string): boolean {
  return /^gemini-4/i.test(model.trim());
}

export function buildGeminiBody(request: GenerateRequest, model = ""): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseJsonSchema: request.responseSchema,
  };
  if (isThinkingGemini(model)) generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
  return {
    contents: [{ role: "user", parts: [{ text: request.promptText }] }],
    systemInstruction: { parts: [{ text: request.systemText }] },
    generationConfig,
  };
}
