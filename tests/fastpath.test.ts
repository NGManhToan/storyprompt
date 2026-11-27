import { describe, expect, it } from "vitest";
import { geminiQuotaWindow, geminiRetryDelayMs, rateLimitCooldownMs } from "../src/core/providers/gemini";
import { cfReasoning } from "../src/core/providers/httpLanes";
import { relaxSceneSchema, sceneSchemaFor, STRICT_SCHEMA_MAX_IDS } from "../src/core/prompts";
import { ProviderError } from "../src/core/errors";

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(3, "0"));
const scenesOf = (schema: Record<string, unknown>) =>
  (schema as { properties: { scenes: Record<string, unknown> & { items: { properties: { scene_id: Record<string, unknown> } } } } }).properties.scenes;

describe("gemini 429 parsing", () => {
  it("reads RetryInfo retryDelay and the quota window", () => {
    const raw = '{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}';
    expect(geminiRetryDelayMs(raw)).toBe(23_000);
    expect(geminiQuotaWindow(raw)).toBe("minute");
    expect(geminiQuotaWindow('"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"')).toBe("day");
    expect(geminiRetryDelayMs("no hint")).toBeUndefined();
  });
  it("cools down by retry-after instead of a flat 5 minutes", () => {
    const e = new ProviderError("[quota/phút] 429", { status: 429, lane: "gemini", retryAfterMs: 23_000 });
    expect(rateLimitCooldownMs(e)).toBeLessThanOrEqual(24_000);
  });
});

describe("large-batch schema", () => {
  it("keeps strict enum/minItems for small batches", () => {
    const s = scenesOf(sceneSchemaFor(ids(20)));
    expect(s.minItems).toBe(20);
    expect(s.items.properties.scene_id.enum).toHaveLength(20);
  });
  it("relaxes above the threshold so Gemini does not reject 'too many states'", () => {
    const s = scenesOf(sceneSchemaFor(ids(STRICT_SCHEMA_MAX_IDS + 20)));
    expect(s.minItems).toBeUndefined();
    expect(s.maxItems).toBeUndefined();
    expect(s.items.properties.scene_id.enum).toBeUndefined();
  });
  it("relax is idempotent", () => {
    const a = relaxSceneSchema(sceneSchemaFor(ids(10)));
    expect(JSON.stringify(relaxSceneSchema(a))).toBe(JSON.stringify(a));
  });
});

describe("cloudflare reasoning off", () => {
  it("turns thinking off for qwen3/gemma-4 and lowers gpt-oss effort", () => {
    expect(cfReasoning("@cf/qwen/qwen3.8-27b")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(cfReasoning("@cf/google/gemma-4-26b-a4b-it")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(JSON.stringify(cfReasoning("@cf/openai/gpt-oss-120b"))).toContain("low");
  });
});
