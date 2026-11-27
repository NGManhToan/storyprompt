/**
 * Benchmark pipeline trên máy local (không qua trình duyệt). Không in giá trị khóa.
 *   npm run bench -- --scenes 20 --lanes groq
 *   npm run bench -- --scenes 60 --lanes gemini,groq,cloudflare --file public/fixtures/voice-fin-001.srt
 *   npm run bench -- --mock --scenes 211
 * Kết quả ghi vào bench-results/<thời điểm>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractNames } from "../src/core/cast.js";
import { buildScenes, type ChunkMode } from "../src/core/chunk.js";
import { toFlowSheet } from "../src/core/export.js";
import { FLOW_STYLE_FOOTER } from "../src/core/flow.js";
import { cfNeurons, DEFAULT_LIMITS } from "../src/core/laneLimits.js";
import { runPipeline } from "../src/core/pipeline.js";
import { createMockProvider } from "../src/core/providers/mock.js";
import { geminiProvider, resolveGeminiModels } from "../src/core/providers/gemini.js";
import { generateCloudflare, generateGroq } from "../src/core/providers/httpLanes.js";
import type { LaneSlot } from "../src/core/router.js";
import { createScheduler } from "../src/core/scheduler.js";
import type { Provider } from "../src/core/types.js";
import { DEFAULT_CF_MODEL, DEFAULT_GROQ_MODEL } from "../src/server/api.js";
import { loadEnvFiles } from "../src/server/env.js";

const root = fileURLToPath(new URL("..", import.meta.url));
loadEnvFiles(root);

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "true";
}

const mock = arg("mock") === "true";
const count = Number(arg("scenes", "20"));
const file = arg("file", "public/fixtures/voice-fin-001.srt")!;
const wanted = (arg("lanes", "gemini,groq,cloudflare") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const batchSize = Number(arg("batch", "4"));
const concurrency = Number(arg("concurrency", "6"));

const mode = (arg("mode", "fixed") ?? "fixed") as ChunkMode;
const duration = Number(arg("duration", "8"));
const raw = readFileSync(resolve(root, file), "utf8");
const parsed = buildScenes(raw, { mode, duration, kind: "srt" });
let scenes = parsed.scenes;
while (scenes.length < count) {
  // Nhân bản cảnh để đủ số lượng (đổi id) khi file mẫu ngắn hơn.
  const extra = parsed.scenes.map((scene, index) => ({ ...scene, sceneId: String(scenes.length + index + 1).padStart(3, "0") }));
  scenes = [...scenes, ...extra];
}
scenes = scenes.slice(0, count);
const extraNames = (arg("names", "") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const knownNames = extractNames(scenes.map((scene) => scene.source).join("\n"), extraNames);

const env = process.env;
const present = {
  gemini: Boolean(env.GEMINI_API_KEY),
  groq: Boolean(env.GROQ_API_KEY),
  cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
};

const slots: LaneSlot[] = [];
if (mock) {
  for (const lane of ["gemini", "groq", "cloudflare"] as const) {
    const base = createMockProvider({ delayMs: 50 });
    slots.push({ provider: { ...base, lane, model: `mock-${lane}` }, scheduler: createScheduler({ rpm: 600, tpm: 5_000_000, rpd: 100_000 }) });
  }
} else {
  for (const lane of wanted) {
    if (lane === "gemini" && present.gemini) {
      const provider = geminiProvider({ apiKey: env.GEMINI_API_KEY!, models: resolveGeminiModels((env.GEMINI_MODELS ?? "").split(",")) });
      const l = DEFAULT_LIMITS.gemini;
      slots.push({ provider, scheduler: createScheduler({ rpm: Number(env.GEMINI_RPM) || l.rpm, tpm: l.tpm, rpd: l.rpd, tpmInputOnly: true }) });
    }
    if (lane === "groq" && present.groq) {
      const model = env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
      const provider: Provider = {
        lane: "groq",
        model,
        available: true,
        generate: (request, signal) => generateGroq({ apiKey: env.GROQ_API_KEY!, model, request, signal }),
      };
      const l = DEFAULT_LIMITS.groq;
      slots.push({ provider, scheduler: createScheduler({ rpm: l.rpm, tpm: l.tpm, otpm: l.otpm, rpd: l.rpd }) });
    }
    if (lane === "cloudflare" && present.cloudflare) {
      const model = env.CLOUDFLARE_MODEL || DEFAULT_CF_MODEL;
      const provider: Provider = {
        lane: "cloudflare",
        model,
        available: true,
        generate: (request, signal) =>
          generateCloudflare({ token: env.CLOUDFLARE_API_TOKEN!, accountId: env.CLOUDFLARE_ACCOUNT_ID!, model, request, signal }),
      };
      const l = DEFAULT_LIMITS.cloudflare;
      slots.push({
        provider,
        neurons: (input, output) => cfNeurons(model, input, output),
        scheduler: createScheduler({ rpm: l.rpm, tpm: l.tpm, rpd: l.rpd, neuronStop: Number(env.CF_NEURON_STOP) || l.neuronStop }),
      });
    }
  }
}

console.log(
  `[bench] scenes=${scenes.length}/${parsed.scenes.length} mode=${mode}/${duration}s file=${file.replace(/^.*[\\/]/, "")} mock=${mock} keys=${JSON.stringify(present)} lanes=${slots.map((slot) => `${slot.provider.lane}:${slot.provider.model}`).join(",") || "(none)"}`,
);
if (!slots.length) {
  console.log("[bench] Không có lane nào có khóa. Đặt GEMINI_API_KEY / GROQ_API_KEY / CLOUDFLARE_* trong .env.");
  process.exit(2);
}

// Chặn trước khi vượt hạn mức ngày của gói free (vd. Groq TPD 200K): dừng gọn khi tổng token chạm --stop-tokens.
const stopTokens = Number(arg("stop-tokens", "0"));
const controller = new AbortController();
let spent = 0;
let done = 0;
const output = await runPipeline({
  signal: controller.signal,
  scenes,
  knownNames,
  settings: { batchSize, concurrency, maxAttempts: 3, maxOutputTokens: 16384, bible: false, prefix: "", footer: "", fullScript: true, contextScenes: 4 },
  lanes: slots.map((slot) => slot.provider),
  slots,
  onProgress: (event) => {
    if (event.type === "scene" && event.result.status === "accepted") {
      done += 1;
      if (done % 10 === 0) console.log(`[bench] accepted ${done}/${scenes.length}`);
    }
    if (event.type === "log") {
      spent += event.log.totalTokens;
      if (stopTokens && spent >= stopTokens && !controller.signal.aborted) {
        console.log(`[bench] dừng: đã dùng ${spent} token (ngưỡng ${stopTokens}).`);
        controller.abort();
      }
    }
    if (event.type === "log" && event.log.status !== "ok") {
      console.log(`[bench] ${event.log.lane} ${event.log.status}: ${(event.log.error ?? "").slice(0, 160)}`);
    }
  },
});

const r = output.report;
const summary = {
  scenes: r.sceneCount,
  wallSeconds: Math.round(r.wallTimeMs / 100) / 10,
  accepted: r.accepted,
  acceptedPct: r.acceptedPct,
  failed: r.failed,
  requests: r.requests,
  tokens: r.tokens,
  rejectionsByReason: r.rejectionsByReason,
  telemetry: r.telemetry,
  fatalError: r.fatalError,
};
console.log(JSON.stringify(summary, null, 2));
const dir = join(root, "bench-results");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(
  join(dir, `${stamp}-${mock ? "mock" : slots.map((slot) => slot.provider.lane).join("+")}-${scenes.length}.json`),
  JSON.stringify({ summary, knownNames, logs: output.logs, results: output.results }, null, 2),
);
// Bản dán Flow (ảnh tham chiếu + prompt) để chấm bằng mắt.
writeFileSync(
  join(dir, `${stamp}-${mock ? "mock" : slots.map((slot) => slot.provider.lane).join("+")}-${scenes.length}.flow.txt`),
  toFlowSheet(scenes, output.results, { prefix: "", footer: FLOW_STYLE_FOOTER, roster: knownNames, aspectRatio: "16:9" }),
);
