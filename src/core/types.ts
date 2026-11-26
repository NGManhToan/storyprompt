export type SceneStatus =
  | "pending"
  | "running"
  | "accepted"
  | "rejected"
  | "missing"
  | "edited"
  | "failed";

export type RejectionCode =
  | "castAbsent"
  | "castMissing"
  | "castInconsistent"
  | "unnamedCharacter"
  | "borrowedAction"
  | "overlayText"
  | "appearanceOverride"
  | "duplicateVisualKey"
  | "duplicateSceneId"
  | "unknownSceneId"
  | "wrongLanguage"
  | "incompleteEnding"
  | "wordCount"
  | "truncated"
  | "unparseable"
  | "missing"
  | "providerError";

export type Rejection = {
  code: RejectionCode;
  detail: string;
};

export type Cue = {
  index: number;
  start: string;
  end: string;
  text: string;
};

export type Scene = {
  sceneId: string;
  title: string;
  heading: string;
  source: string;
  start: string;
  end: string;
  cueIndexes: number[];
};

export type ParseResult = {
  cues: Cue[];
  scenes: Scene[];
  warnings: string[];
};

export type SceneDraft = {
  scene_id: string;
  title: string;
  environment: string;
  prompt: string;
  visible_cast: string[];
  source_anchor: string;
};

export type StoryBible = {
  characters: { name: string; note: string }[];
  locations: { name: string; lighting: string }[];
};

export type SceneTask = {
  sceneId: string;
  title: string;
  source: string;
  likelyPresent: string[];
  neighbors: { sceneId: string; title: string; source: string }[];
  feedback?: string;
};

export type ProviderLane = "gemini" | "groq" | "cloudflare" | "mock";

export type GenerateRequest = {
  kind: "bible" | "scenes";
  systemText: string;
  promptText: string;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
  sceneIds: string[];
  tasks: SceneTask[];
  estimatedTokens: number;
};

export type GenerateResponse = {
  text: string;
  finishReason: string;
  model: string;
  lane: ProviderLane;
  usage: {
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export type Provider = {
  lane: ProviderLane;
  model: string;
  available: boolean;
  generate: (req: GenerateRequest, signal?: AbortSignal) => Promise<GenerateResponse>;
};

export type SceneResult = {
  sceneId: string;
  status: SceneStatus;
  attempts: number;
  title: string;
  environment: string;
  prompt: string;
  visibleCast: string[];
  sourceAnchor: string;
  rejections: Rejection[];
  model?: string;
  lane?: ProviderLane;
};

export type RequestLog = {
  id: string;
  at: number;
  lane: string;
  model: string;
  kind: "bible" | "scenes";
  sceneIds: string[];
  attempt: number;
  finishReason: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: "ok" | "error" | "rate_limited";
  error?: string;
  rejections: { sceneId: string; reasons: string[] }[];
};

export type RunReport = {
  startedAt: number;
  finishedAt: number;
  wallTimeMs: number;
  sceneCount: number;
  accepted: number;
  edited: number;
  failed: number;
  missing: number;
  acceptedPct: number;
  usablePct: number;
  rejectionsByReason: Record<string, number>;
  tokens: { prompt: number; output: number; total: number };
  requests: number;
  rejectionEvents: number;
  models: Record<string, number>;
  lanes: Record<string, number>;
  bible: boolean;
  cancelled: boolean;
  fatalError?: string;
};

export type RunSettings = {
  batchSize: number;
  concurrency: number;
  maxAttempts: number;
  maxOutputTokens: number;
  bible: boolean;
  prefix: string;
  footer: string;
  temperature?: number;
};

export function emptyResult(scene: Scene): SceneResult {
  return {
    sceneId: scene.sceneId,
    status: "pending",
    attempts: 0,
    title: scene.title,
    environment: "",
    prompt: "",
    visibleCast: [],
    sourceAnchor: "",
    rejections: [],
  };
}

export function hashString(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h) ^ value.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean).length;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
