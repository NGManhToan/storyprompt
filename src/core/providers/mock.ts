import { inferPresence } from "../cast.js";
import { ProviderError } from "../errors.js";
import type { GenerateRequest, GenerateResponse, Provider, SceneTask } from "../types.js";
import { countWords } from "../types.js";

const MOTIONS = [
  "lowering the iron teapot onto the scarred wooden table as rain threads the dark kitchen glass",
  "shaking a closed umbrella and stepping across the wet stone threshold into the shelter",
  "sliding a porcelain cup across the wooden table while steam curls slowly upward",
  "lifting an old photograph from the fridge door and studying it beside the counter",
  "hanging an oil lantern on the porch post and turning toward the rainy river",
  "pulling a wooden oar through the morning water as the bow cuts the pale mist",
  "choosing white chrysanthemums and tucking the stems carefully into a woven basket",
  "walking the wet dirt path and pointing toward a low roof past the trees",
  "testing the locked wooden door and waiting while the iron handle stays shut",
  "lifting a clay flowerpot and taking the hidden iron key from beneath it",
  "entering a dusty living room as a blade of sunlight crosses the bare floor",
  "drawing the old window open as dust drifts through the bright morning sunlight",
  "lifting a sealed envelope from the writing desk and leaving its wax seal untouched",
  "sitting on the wooden floor and keeping the sealed envelope closed in one hand",
  "lighting the wood stove and rinsing two bowls under a weak stream of water",
  "sitting with bowls of soup as an oil lamp burns low at the center of the table",
  "standing apart on the dock planks and stepping backward without reaching out",
  "standing alone under the yellow lamp and watching the dark river bend away",
  "walking back with a repaired lantern and turning toward its small warm glow",
  "sitting on the old porch step as the repaired lantern rests in the blue hour",
];

const PAD = ["still", "quiet", "clear", "steady", "measured", "grounded"];

export type MockFail = "language" | "omit" | "always-language";

function fit(text: string): string {
  const words = text.replace(/[.!?]/g, "").split(/\s+/).filter(Boolean);
  let index = 0;
  while (words.length < 30) {
    words.push(PAD[index % PAD.length]);
    index += 1;
  }
  while (words.length > 40) words.pop();
  return `${words.join(" ")}.`;
}

export function pickAnchor(source: string): string {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const action = lines.find(
    (line) => !/^(?:cảnh|canh|scene|sc|int\.|ext\.|i\/e\.|int\/ext\.)/i.test(line) && !/^[\p{L}].{0,48}:\s+\S/u.test(line),
  );
  return (action ?? lines[lines.length - 1] ?? source).trim().slice(0, 160);
}

export function draftFromTask(task: SceneTask, knownNames: string[]) {
  const present = inferPresence(task.source, knownNames).present;
  const number = Number(task.sceneId.match(/\d+/)?.[0] ?? "1");
  const motion = MOTIONS[(Math.max(number, 1) - 1) % MOTIONS.length];
  const marker = `beat${String(Math.max(number, 1)).padStart(3, "0")}`;
  const who =
    present.length === 0
      ? ""
      : present.length === 1
        ? present[0]
        : `${present.slice(0, -1).join(", ")} and ${present[present.length - 1]}`;
  const body = who ? `${who} ${motion}` : `The quiet room showing ${motion}`;
  const angleCycle = ["First-person POV", "Detail close-up", "Medium shot", "Wide shot"];
  const anglePhrase = [
    "point of view at eye level with shallow focus and a practical lamp",
    "detail close up at eye level with shallow focus and a practical lamp",
    "medium shot at eye level with shallow focus and a practical lamp",
    "wide shot at eye level with shallow focus and a practical lamp",
  ];
  const angleIndex = (Math.max(number, 1) - 1) % angleCycle.length;
  const angle = angleCycle[angleIndex];
  const prompt = fit(`${body}, ${anglePhrase[angleIndex]}`);
  return {
    scene_id: task.sceneId,
    title: task.title?.trim() || `Scene ${task.sceneId}`,
    environment: `Set ${marker}`,
    prompt,
    visible_cast: present,
    source_anchor: pickAnchor(task.source),
    camera_angle: angle,
    shot_sequence: `Shot ${((Math.max(number, 1) - 1) % 4) + 1}/4`,
    visual_action: motion.split(" ").slice(0, 6).join(" "),
  };
}

function usageFor(request: GenerateRequest) {
  const promptTokens = Math.max(32, Math.round(request.promptText.length / 4));
  const outputTokens = request.kind === "bible" ? 180 : 80 * Math.max(1, request.tasks.length);
  return { promptTokens, outputTokens, totalTokens: promptTokens + outputTokens };
}

export function createMockProvider(options?: {
  fail?: Record<string, MockFail>;
  delayMs?: number;
  rateLimitOnce?: boolean;
}): Provider & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  const seen = new Map<string, number>();
  let rateLimited = false;
  return {
    lane: "mock",
    model: "mock-storyprompt",
    available: true,
    calls,
    async generate(request) {
      calls.push(request);
      if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options?.rateLimitOnce && !rateLimited) {
        rateLimited = true;
        throw new ProviderError("mock 429", { status: 429, lane: "mock", retryAfterMs: 25 });
      }
      if (request.kind === "bible") {
        const names = (request.promptText.match(/ROSTER:\s*([^\n]+)/)?.[1] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name && !name.startsWith("("));
        const payload = {
          characters: names.map((name) => ({ name, note: "on camera only when the source shows them in the frame" })),
          locations: [{ name: "River house", lighting: "cool moonlight with one warm practical lamp" }],
        };
        return {
          text: JSON.stringify(payload),
          finishReason: "STOP",
          model: "mock-storyprompt",
          lane: "mock",
          usage: usageFor(request),
        } satisfies GenerateResponse;
      }
      const scenes = [];
      for (const task of request.tasks) {
        const count = (seen.get(task.sceneId) ?? 0) + 1;
        seen.set(task.sceneId, count);
        const mode = options?.fail?.[task.sceneId];
        if (mode === "omit" && count === 1) continue;
        if (mode === "always-language" || (mode === "language" && count === 1)) {
          scenes.push({
            scene_id: task.sceneId,
            title: `Cảnh ${task.sceneId}`,
            environment: "bếp",
            prompt: "Lan đứng trong bếp nhìn mưa rơi ngoài cửa kính và giữ im lặng rất lâu.",
            visible_cast: inferPresence(task.source, []).present,
            source_anchor: pickAnchor(task.source),
          });
          continue;
        }
        const names = inferPresence(
          task.source,
          request.promptText.includes("ROSTER")
            ? (request.promptText.match(/ROSTER \(names only, no appearance\): ([^\n]+)/)?.[1] ?? "")
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean)
            : [],
        ).present;
        const draft = draftFromTask(task, names);
        if (countWords(draft.prompt) < 28) draft.prompt = fit(`${draft.prompt} still quiet clear`);
        scenes.push(draft);
      }
      return {
        text: JSON.stringify({ scenes }),
        finishReason: "STOP",
        model: "mock-storyprompt",
        lane: "mock",
        usage: usageFor(request),
      };
    },
  };
}
