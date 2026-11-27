import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractNames } from "../src/core/cast.js";
import { toFlowHandoff } from "../src/core/export.js";
import { createMockProvider } from "../src/core/providers/mock.js";
import { runPipeline } from "../src/core/pipeline.js";
import { buildGeminiBody } from "../src/core/prompts.js";
import { createScheduler } from "../src/core/scheduler.js";
import { parseSrt } from "../src/core/srt.js";
import { countWords } from "../src/core/types.js";

describe("mocked 20-scene run", () => {
  it("returns a full accepted set and a measured report", async () => {
    const raw = readFileSync(new URL("../public/samples/nha-ben-song-20.srt", import.meta.url), "utf8");
    const parsed = parseSrt(raw);
    const knownNames = extractNames(parsed.scenes.map((scene) => scene.source).join("\n"));
    const provider = createMockProvider({ fail: { "003": "language", "005": "omit" } });
    const started = Date.now();
    const output = await runPipeline({
      scenes: parsed.scenes,
      knownNames,
      fileName: "nha-ben-song-20.srt",
      projectId: "sample-20",
      settings: {
        batchSize: 4,
        concurrency: 3,
        maxAttempts: 3,
        maxOutputTokens: 8192,
        bible: false,
        prefix: "Cinematic 16:9 still,",
        footer: "No rendered text. Character appearance comes only from the reference images.",
      },
      lanes: [provider],
      scheduler: createScheduler({ rpm: 600, tpm: 2_000_000, rpd: 2_000 }),
    });

    expect(parsed.scenes).toHaveLength(20);
    expect(output.results).toHaveLength(20);
    expect(output.results.every((row) => row.status === "accepted" && row.prompt)).toBe(true);
    for (const row of output.results) {
      expect(countWords(row.prompt)).toBeGreaterThanOrEqual(28);
      expect(countWords(row.prompt)).toBeLessThanOrEqual(42);
      expect(row.prompt).not.toMatch(/Derek|Chloe|#FFFFFF|@You/);
      expect(row.visibleCast).not.toContain("Hải");
    }
    expect(output.results.find((row) => row.sceneId === "018")?.visibleCast).toEqual(["Lan"]);
    expect(output.results.find((row) => row.sceneId === "003")?.visibleCast).toEqual(["Lan", "Minh"]);
    expect(output.report.accepted).toBe(20);
    expect(output.report.acceptedPct).toBe(100);
    expect(output.report.rejectionsByReason.wrongLanguage).toBeGreaterThanOrEqual(1);
    expect(output.report.rejectionsByReason.missing).toBeGreaterThanOrEqual(1);
    expect(output.report.tokens.total).toBeGreaterThan(0);
    expect(output.report.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(output.report.wallTimeMs).toBeLessThan(30_000);
    expect(output.report.requests).toBe(provider.calls.length);
    expect(provider.calls.filter((call) => call.kind === "scenes").length).toBe(6); // cảnh lỗi được gom lại 1 lô retry thay vì từng cảnh
    const widest = Math.max(...provider.calls.map((call) => call.sceneIds.length));
    expect(widest).toBeLessThanOrEqual(4);
    expect(provider.calls.some((call) => call.sceneIds.length === 20)).toBe(false);
    expect(Date.now() - started).toBeLessThan(30_000);

    const handoff = toFlowHandoff(parsed.scenes, output.results, {
      prefix: "Cinematic 16:9 still,",
      footer: "No rendered text. Character appearance comes only from the reference images.",
      roster: output.knownNames,
    });
    expect(handoff.format).toBe("storyprompt-flow-v2");
    expect(handoff.scenes.find((scene) => scene.id === "018")?.references).toEqual(["Lan"]);
    expect(handoff.scenes).toHaveLength(20);
    expect(handoff.scenes[0].prompt.startsWith("Cinematic 16:9 still,")).toBe(true);
    expect(handoff.scenes[0].prompt).toContain("reference images");

    const body = buildGeminiBody(provider.calls[0]);
    expect(JSON.stringify(body)).toContain("responseJsonSchema");
    expect(JSON.stringify(body)).toContain("minItems");
    expect(JSON.stringify(body)).not.toContain("maxOutputTokens");
    expect(JSON.stringify(body)).not.toMatch(/Derek|Chloe|#FFFFFF|@You/);
  });
});
