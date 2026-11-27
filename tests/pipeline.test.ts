import { describe, expect, it } from "vitest";
import { createMockProvider } from "../src/core/providers/mock.js";
import { runPipeline } from "../src/core/pipeline.js";
import { buildSceneRequest, SYSTEM_SCENES } from "../src/core/prompts.js";
import { createScheduler } from "../src/core/scheduler.js";
import type { Scene } from "../src/core/types.js";

const settings = {
  batchSize: 4,
  concurrency: 2,
  maxAttempts: 3,
  maxOutputTokens: 8192,
  bible: false,
  prefix: "Cinematic 16:9 still,",
  footer: "No rendered text. Character appearance comes only from the reference images.",
};

function fastScheduler() {
  return createScheduler({
    rpm: 1_000,
    tpm: 5_000_000,
    rpd: 10_000,
    sleep: async () => undefined,
    now: () => Date.now(),
  });
}

function scene(id: string, source: string): Scene {
  return { sceneId: id, title: `Title ${id}`, heading: "", source, start: "", end: "", cueIndexes: [1] };
}

describe("pipeline retry", () => {
  const scenes = [
    scene("001", "Lan đặt ấm trà sắt xuống bàn gỗ. Mưa gõ vào kính đen.\nLAN: Nước sôi rồi."),
    scene("002", "Minh đứng ở ngưỡng cửa và gấp ô lại.\nMINH: Anh về rồi."),
    scene("003", "Lan và Minh ngồi đối diện nhau bên bàn.\nLAN: Ông Hải để lại chìa khóa."),
    scene("004", "Minh cầm tấm ảnh trên tủ lạnh. Lan đứng cạnh bàn gỗ."),
  ];

  it("retries a wrong-language row and a missing row individually", async () => {
    const provider = createMockProvider({ fail: { "002": "language", "004": "omit" } });
    const prompts: string[] = [];
    const wrapped = {
      ...provider,
      generate: async (request: Parameters<typeof provider.generate>[0], signal?: AbortSignal) => {
        prompts.push(request.promptText);
        return provider.generate(request, signal);
      },
    };
    const output = await runPipeline({
      scenes,
      knownNames: ["Lan", "Minh", "Hải"],
      settings,
      lanes: [wrapped],
      scheduler: fastScheduler(),
    });
    expect(output.results.every((row) => row.status === "accepted")).toBe(true);
    expect(output.results.find((row) => row.sceneId === "002")?.attempts).toBe(2);
    expect(output.results.find((row) => row.sceneId === "004")?.attempts).toBe(2);
    expect(output.report.rejectionsByReason.wrongLanguage).toBeGreaterThanOrEqual(1);
    expect(output.report.rejectionsByReason.missing).toBeGreaterThanOrEqual(1);
    expect(prompts.some((prompt) => prompt.includes("wrongLanguage"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("READ-ONLY NEIGHBOR"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("STORY BIBLE"))).toBe(false);
  });

  it("stops a scene after the attempt cap", async () => {
    const provider = createMockProvider({ fail: { "001": "always-language" } });
    const output = await runPipeline({
      scenes: [scenes[0]],
      knownNames: ["Lan"],
      settings: { ...settings, maxAttempts: 2 },
      lanes: [provider],
      scheduler: fastScheduler(),
    });
    expect(output.results[0].status).toBe("failed");
    expect(output.results[0].attempts).toBe(2);
    expect(provider.calls.length).toBe(2);
  });

  it("resumes without rewriting accepted scenes", async () => {
    const provider = createMockProvider();
    const first = await runPipeline({
      scenes,
      knownNames: ["Lan", "Minh", "Hải"],
      settings,
      lanes: [provider],
      scheduler: fastScheduler(),
    });
    const callsAfterFirst = provider.calls.length;
    const second = await runPipeline({
      scenes,
      knownNames: ["Lan", "Minh", "Hải"],
      settings,
      lanes: [provider],
      scheduler: fastScheduler(),
      prior: first.results,
    });
    expect(provider.calls.length).toBe(callsAfterFirst);
    expect(second.results.every((row) => row.status === "accepted")).toBe(true);
  });

  it("backs off once on 429 and then accepts", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const provider = createMockProvider({ rateLimitOnce: true });
    const output = await runPipeline({
      scenes: [scenes[0]],
      knownNames: ["Lan"],
      settings,
      lanes: [provider],
      scheduler: createScheduler({
        rpm: 100,
        tpm: 1_000_000,
        rpd: 100,
        now: () => time,
        sleep: async (ms) => {
          sleeps.push(ms);
          time += ms;
        },
      }),
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    });
    expect(output.results[0].status).toBe("accepted");
    expect(sleeps).toContain(25);
    expect(output.logs.some((log) => log.status === "rate_limited")).toBe(true);
  });

  it("keeps the story bible behind the toggle", () => {
    expect(SYSTEM_SCENES).not.toMatch(/Derek|Chloe|#FFFFFF|@You/);
    const off = buildSceneRequest({
      tasks: [
        {
          sceneId: "001",
          title: "Bếp",
          source: scenes[0].source,
          likelyPresent: ["Lan"],
          neighbors: [],
        },
      ],
      knownNames: ["Lan"],
      maxOutputTokens: 8192,
      temperature: 0.4,
    });
    const on = buildSceneRequest({
      tasks: off.tasks,
      knownNames: ["Lan"],
      bible: {
        characters: [{ name: "Lan", note: "on camera in the kitchen" }],
        locations: [{ name: "Kitchen", lighting: "cool window light, one warm lamp" }],
      },
      maxOutputTokens: 8192,
      temperature: 0.4,
    });
    expect(off.promptText).not.toContain("STORY BIBLE");
    expect(off.systemText).not.toMatch(/story bible/i);
    expect(on.promptText).toContain("STORY BIBLE");
    expect(on.systemText).toMatch(/story bible/i);
    expect(on.responseSchema).toMatchObject({ required: ["scenes"] });
    expect(on.maxOutputTokens).toBeLessThan(8192);
    expect(on.maxOutputTokens).toBeGreaterThanOrEqual(256);
  });
});

describe("concurrency", () => {
  it("caps in-flight provider calls", async () => {
    let active = 0;
    let peak = 0;
    const scenes = Array.from({ length: 8 }, (_, index) =>
      scene(String(index + 1).padStart(3, "0"), `Lan đặt chén số ${index} xuống bàn gỗ trong bếp.\nLAN: Xong phần này.`),
    );
    const provider = createMockProvider();
    const gated = {
      ...provider,
      generate: async (request: Parameters<typeof provider.generate>[0]) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          return await provider.generate(request);
        } finally {
          active -= 1;
        }
      },
    };
    await runPipeline({
      scenes,
      knownNames: ["Lan"],
      settings: { ...settings, batchSize: 4, concurrency: 2 },
      lanes: [gated],
      scheduler: fastScheduler(),
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});
