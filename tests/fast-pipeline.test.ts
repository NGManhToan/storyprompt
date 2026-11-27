import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/core/errors.js";
import { cfNeurons } from "../src/core/laneLimits.js";
import { runPipeline } from "../src/core/pipeline.js";
import { buildGeminiBody, buildSceneRequest, salvageScenes, sceneSchemaFor, sceneContextWindow } from "../src/core/prompts.js";
import { createMockProvider, draftFromTask } from "../src/core/providers/mock.js";
import {
  createModelBreaker,
  generateGeminiRest,
  isRetiredModel,
  resolveGeminiModels,
} from "../src/core/providers/gemini.js";
import { buildGroqBody, generateGroq } from "../src/core/providers/httpLanes.js";
import { createRouter } from "../src/core/router.js";
import { createScheduler } from "../src/core/scheduler.js";
import type { GenerateRequest, GenerateResponse, Provider, Scene } from "../src/core/types.js";
import { repairEnding } from "../src/core/validators.js";

function clock(start = 1_700_000_000_000) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += Math.max(1, ms);
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function scene(id: string, source: string): Scene {
  return { sceneId: id, title: `Title ${id}`, heading: "", source, start: "", end: "", cueIndexes: [1] };
}

function request(ids: string[]): GenerateRequest {
  return buildSceneRequest({
    tasks: ids.map((id) => ({ sceneId: id, title: id, source: `Lan đặt chén ${id} xuống bàn.`, likelyPresent: ["Lan"], neighbors: [] })),
    knownNames: ["Lan"],
    maxOutputTokens: 8192,
    temperature: 0.5,
  });
}

describe("scheduler: OTPM và neuron", () => {
  it("giữ request khi output/phút vượt OTPM", async () => {
    const time = clock();
    const scheduler = createScheduler({ rpm: 30, tpm: 100_000, rpd: 1_000, otpm: 1_000, now: time.now, sleep: time.sleep });
    await scheduler.acquire({ input: 500, output: 700 });
    expect(scheduler.peek({ input: 500, output: 400 })).toBeGreaterThan(59_000);
    const before = time.now();
    await scheduler.acquire({ input: 500, output: 400 });
    expect(time.now() - before).toBeGreaterThanOrEqual(60_000);
  });

  it("dừng lane Cloudflare trước khi chạm 10.000 neuron", async () => {
    const time = clock();
    const scheduler = createScheduler({ rpm: 300, tpm: 10_000_000, rpd: 100_000, neuronStop: 9_000, neuronsUsed: 8_500, now: time.now, sleep: time.sleep });
    expect(scheduler.peek({ input: 1, output: 1, neurons: 400 })).toBe(0);
    const lease = await scheduler.acquire({ input: 1, output: 1, neurons: 400 });
    lease.reconcile(10, 5, 450);
    expect(scheduler.snapshot().neuronsUsed).toBe(8_950);
    expect(scheduler.peek({ input: 1, output: 1, neurons: 100 })).toBe(Infinity);
    await expect(scheduler.acquire({ input: 1, output: 1, neurons: 100 })).rejects.toMatchObject({ code: "budget" });
  });

  it("tính neuron theo bảng giá", () => {
    expect(Math.round(cfNeurons("@cf/qwen/qwen3.8-27b", 21_000, 16_600))).toBe(5_688);
  });

  it("TPM chỉ tính input khi bật tpmInputOnly (Gemini)", () => {
    const time = clock();
    const scheduler = createScheduler({ rpm: 15, tpm: 1_000, rpd: 500, tpmInputOnly: true, now: time.now, sleep: time.sleep });
    expect(scheduler.peek({ input: 900, output: 5_000 })).toBe(0);
  });
});

describe("schema theo lô", () => {
  it("khóa số hàng và scene_id", () => {
    const schema = sceneSchemaFor(["001", "002", "003"]) as {
      properties: { scenes: { minItems: number; maxItems: number; items: { properties: { scene_id: { enum: string[] } } } } };
    };
    expect(schema.properties.scenes.minItems).toBe(3);
    expect(schema.properties.scenes.maxItems).toBe(3);
    expect(schema.properties.scenes.items.properties.scene_id.enum).toEqual(["001", "002", "003"]);
    const req = request(["004"]);
    expect(JSON.stringify(req.responseSchema)).toContain('"enum":["004"]');
    expect(req.maxOutputTokens).toBeLessThan(1_000);
  });

  it("Gemini 4 có thinkingLevel LOW, Flash-Lite thì không; không gửi maxOutputTokens", () => {
    const req = request(["001"]);
    const lite = buildGeminiBody(req, "gemini-3.1-flash-lite") as { generationConfig: Record<string, unknown> };
    const hydrogen = buildGeminiBody(req, "gemini-4-hydrogen") as { generationConfig: Record<string, unknown> };
    expect(lite.generationConfig.thinkingConfig).toBeUndefined();
    expect(hydrogen.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(lite.generationConfig.maxOutputTokens).toBeUndefined();
    expect(lite.generationConfig.responseJsonSchema).toBeTruthy();
  });

  it("Groq dùng json_schema và tắt reasoning của qwen", () => {
    const body = buildGroqBody("qwen/qwen3.8-27b", request(["001"]), true) as Record<string, any>;
    expect(body.response_format.type).toBe("json_schema");
    expect(body.reasoning_effort).toBe("none");
  });

  it("Groq hạ xuống json_object khi model không nhận json_schema", async () => {
    const formats: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      formats.push(body.response_format.type);
      if (body.response_format.type === "json_schema") {
        return new Response(JSON.stringify({ error: { message: "response_format json_schema is not supported" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{\"scenes\":[]}" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await generateGroq({ apiKey: "k", model: "test/no-schema", request: request(["001"]), fetchImpl });
    expect(formats).toEqual(["json_schema", "json_object"]);
    expect(out.usage.outputTokens).toBe(3);
  });

  it("cửa sổ ngữ cảnh chỉ lấy ±k cảnh quanh lô", () => {
    const scenes = Array.from({ length: 30 }, (_, i) => ({ sceneId: String(i + 1).padStart(3, "0"), title: `T${i + 1}`, source: `nguồn ${i + 1}` }));
    const text = sceneContextWindow(scenes, ["010", "011"], 2);
    expect(text).toContain("[008]");
    expect(text).toContain("[013]");
    expect(text).not.toContain("[007]");
    expect(text).not.toContain("[010]");
  });
});

describe("validator: bớt loại nhầm", () => {
  it("chỉ thêm dấu chấm khi câu không cụt", () => {
    expect(repairEnding("Lan sets the cup down by the window")).toEqual({ prompt: "Lan sets the cup down by the window.", fixed: true });
    expect(repairEnding("Lan sets the cup down and").fixed).toBe(false);
    expect(repairEnding("Lan sets the cup down,").fixed).toBe(false);
    expect(repairEnding("Lan waits...").fixed).toBe(false);
    expect(repairEnding("Done.").fixed).toBe(false);
  });

  it("cứu các hàng hoàn chỉnh trong JSON bị cắt", () => {
    const text = '{"scenes":[{"scene_id":"001","title":"a","environment":"e","prompt":"p.","visible_cast":[],"source_anchor":"x"},{"scene_id":"002","title":"b","prompt":"cut her';
    const rows = salvageScenes(text);
    expect(rows.map((row) => row.scene_id)).toEqual(["001"]);
  });

  it("trùng scene_id thì giữ bản hợp lệ đầu tiên; truncated chỉ khi finish_reason = length", async () => {
    const scenes = [
      scene("001", "Lan đặt ấm trà sắt xuống bàn gỗ. Mưa gõ vào kính đen.\nLAN: Nước sôi rồi."),
      scene("002", "Minh đứng ở ngưỡng cửa và gấp ô lại.\nMINH: Anh về rồi."),
    ];
    const names = ["Lan", "Minh"];
    let calls = 0;
    const provider: Provider = {
      lane: "mock",
      model: "dup",
      available: true,
      async generate(req): Promise<GenerateResponse> {
        calls += 1;
        const rows = req.tasks.map((task) => draftFromTask(task, names));
        // Hàng 1 lặp lại (bản sau hỏng), hàng 2 thiếu dấu chấm, finish_reason = stop.
        const broken = { ...rows[0], prompt: "xin chào" };
        const noDot = rows[1] ? { ...rows[1], prompt: rows[1].prompt.replace(/\.$/, "") } : undefined;
        const out = [rows[0], broken, ...(noDot ? [noDot] : [])];
        return { text: JSON.stringify({ scenes: out }), finishReason: "stop", model: "dup", lane: "mock", usage: { promptTokens: 10, outputTokens: 10, totalTokens: 20 } };
      },
    };
    const output = await runPipeline({
      scenes,
      knownNames: names,
      settings: { batchSize: 4, concurrency: 1, maxAttempts: 1, maxOutputTokens: 8192, bible: false, prefix: "", footer: "" },
      lanes: [provider],
      scheduler: createScheduler({ rpm: 100, tpm: 1_000_000, rpd: 100 }),
    });
    expect(calls).toBe(1);
    expect(output.results.map((row) => row.status)).toEqual(["accepted", "accepted"]);
    expect(output.report.rejectionsByReason.truncated).toBeUndefined();
    expect(output.report.telemetry?.duplicateRows).toBe(1);
    expect(output.report.telemetry?.autoFixedEndings).toBe(1);
    expect(output.report.telemetry?.rowsReturned).toBe(3);
  });
});

describe("Gemini chain kiểu AI Studio", () => {
  it("lọc model đã nghỉ hưu", () => {
    expect(isRetiredModel("gemini-3.5-flash-lite")).toBe(true);
    expect(isRetiredModel("gemini-flash-latest")).toBe(true);
    expect(resolveGeminiModels(["gemini-3.8-flash", "gemini-flash-latest"])).toEqual(["gemini-3.1-flash-lite", "gemini-4-hydrogen"]);
    expect(resolveGeminiModels(["gemini-3.1-flash-lite", "gemini-4-hydrogen"])).toEqual(["gemini-3.1-flash-lite", "gemini-4-hydrogen"]);
  });

  it("503 ở Flash-Lite → nghỉ 2 phút và chuyển sang gemini-4-hydrogen", async () => {
    const time = clock();
    const breaker = createModelBreaker(time.now);
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? "";
      seen.push(model);
      if (model === "gemini-3.1-flash-lite") {
        return new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "high demand" } }), { status: 503 });
      }
      const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"scenes":[]}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } })}\n\n`;
      return new Response(sse, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await generateGeminiRest({ apiKey: "k", models: ["gemini-3.1-flash-lite", "gemini-4-hydrogen"], request: request(["001"]), fetchImpl, breaker, now: time.now, sleep: time.sleep });
    expect(out.model).toBe("gemini-4-hydrogen");
    expect(seen).toEqual(["gemini-3.1-flash-lite", "gemini-4-hydrogen"]);
    expect(breaker.coolUntil("gemini-3.1-flash-lite") - time.now()).toBe(120_000);
  });

  it("cả chuỗi 429 → trả 429 kèm retryAfter để router chuyển lane", async () => {
    const time = clock();
    const breaker = createModelBreaker(time.now);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }), { status: 429 })) as unknown as typeof fetch;
    await expect(
      generateGeminiRest({ apiKey: "k", models: [], request: request(["001"]), fetchImpl, breaker, now: time.now, sleep: time.sleep }),
    ).rejects.toMatchObject({ status: 429 });
    expect(breaker.coolUntil("gemini-4-hydrogen") - time.now()).toBe(300_000);
  });

  it("403 dừng ngay, không thử model sau", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }), { status: 403 });
    }) as unknown as typeof fetch;
    await expect(
      generateGeminiRest({ apiKey: "k", models: [], request: request(["001"]), fetchImpl, breaker: createModelBreaker() }),
    ).rejects.toMatchObject({ status: 403 });
    expect(n).toBe(1);
  });
});

describe("router nhiều lane", () => {
  it("lane chính 429 thì lô sang lane phụ; lane khóa sai bị tắt", async () => {
    const time = clock();
    const logs: string[] = [];
    const mk = (lane: Provider["lane"], fail?: () => never): Provider => ({
      lane,
      model: lane,
      available: true,
      async generate(): Promise<GenerateResponse> {
        if (fail) fail();
        return { text: "{}", finishReason: "stop", model: lane, lane, usage: { promptTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    });
    const gemini = mk("gemini", () => {
      throw new ProviderError("quota", { status: 429, lane: "gemini" });
    });
    const groq = mk("groq", () => {
      throw new ProviderError("bad key", { status: 401, lane: "groq" });
    });
    const cf = mk("cloudflare");
    const sched = () => createScheduler({ rpm: 100, tpm: 1_000_000, rpd: 100, now: time.now, sleep: time.sleep });
    const router = createRouter({
      slots: [{ provider: gemini, scheduler: sched() }, { provider: groq, scheduler: sched() }, { provider: cf, scheduler: sched() }],
      now: time.now,
      sleep: time.sleep,
      onLog: (log) => logs.push(`${log.lane}:${log.status}`),
    });
    const first = await router.call(request(["001"]), 1);
    expect(first.response.lane).toBe("cloudflare");
    const second = await router.call(request(["002"]), 1);
    expect(second.response.lane).toBe("cloudflare");
    expect(logs).toEqual(["gemini:rate_limited", "groq:error"]);
    const state = router.state();
    expect(state.find((row) => row.lane === "groq")?.disabled).toBeTruthy();
    expect(state.find((row) => row.lane === "gemini")!.coolUntil - time.now()).toBeGreaterThan(290_000);
  });
});

/** Đồng hồ ảo theo sự kiện: các lane chạy song song trong thời gian ảo. */
function virtualClock(start = 1_700_000_000_000) {
  let time = start;
  let seq = 0;
  const timers: { at: number; seq: number; resolve: () => void }[] = [];
  return {
    now: () => time,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: time + Math.max(1, ms), seq: seq++, resolve });
      }),
    async run<T>(task: Promise<T>): Promise<T> {
      let done = false;
      let value: T | undefined;
      let failure: unknown;
      task.then((v) => { done = true; value = v; }, (e) => { done = true; failure = e; });
      while (!done) {
        for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
        if (done) break;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift();
        if (!next) continue;
        time = Math.max(time, next.at);
        next.resolve();
      }
      if (failure) throw failure;
      return value as T;
    },
  };
}

describe("mô phỏng 211 cảnh với hạn mức thật (đồng hồ ảo)", () => {
  it("chia lô qua 3 lane, nhận đủ 211 cảnh và báo thời gian mô phỏng", async () => {
    const time = virtualClock();
    const scenes = Array.from({ length: 211 }, (_, i) =>
      scene(String(i + 1).padStart(3, "0"), `Lan đặt chén số ${i + 1} xuống bàn gỗ trong bếp lúc ${i % 24} giờ.\nLAN: Phần ${i + 1} xong.`),
    );
    // Độ trễ mô phỏng theo log thực: Gemini ~6 s/lô, Groq ~3 s/lô, Cloudflare ~9 s/lô.
    const lane = (name: Provider["lane"], latency: number): Provider => {
      const base = createMockProvider();
      return {
        ...base,
        lane: name,
        model: name,
        async generate(req, signal) {
          await time.sleep(latency);
          const out = await base.generate(req, signal);
          return { ...out, lane: name, model: name, usage: { promptTokens: req.estimatedInputTokens ?? 0, outputTokens: req.tasks.length * 180, totalTokens: (req.estimatedInputTokens ?? 0) + req.tasks.length * 180 } };
        },
      };
    };
    const g = createScheduler({ rpm: 15, tpm: 250_000, rpd: 500, tpmInputOnly: true, now: time.now, sleep: time.sleep });
    const q = createScheduler({ rpm: 30, tpm: 8_000, rpd: 1_000, otpm: 1_000, now: time.now, sleep: time.sleep });
    const c = createScheduler({ rpm: 300, tpm: 1_000_000, rpd: 100_000, neuronStop: 9_000, now: time.now, sleep: time.sleep });
    const started = time.now();
    const output = await time.run(runPipeline({
      scenes,
      knownNames: ["Lan"],
      settings: { batchSize: 5, concurrency: 8, maxAttempts: 3, maxOutputTokens: 8192, bible: false, prefix: "", footer: "" },
      lanes: [],
      slots: [
        { provider: lane("gemini", 6_000), scheduler: g },
        { provider: lane("groq", 3_000), scheduler: q },
        { provider: lane("cloudflare", 9_000), scheduler: c, neurons: (i, o) => cfNeurons("@cf/qwen/qwen3.8-27b", i, o) },
      ],
      now: time.now,
      sleep: time.sleep,
    }));
    const simulatedMs = time.now() - started;
    expect(output.report.accepted).toBe(211);
    expect(Object.keys(output.report.telemetry!.byLane).sort()).toEqual(["cloudflare", "gemini", "groq"]);
    expect(output.report.telemetry!.neurons).toBeLessThanOrEqual(9_000);
    // eslint-disable-next-line no-console
    console.log(
      `[mock-211] simulated=${Math.round(simulatedMs / 1000)}s requests=${output.report.requests} lanes=${JSON.stringify(
        Object.fromEntries(Object.entries(output.report.telemetry!.byLane).map(([k, v]) => [k, v.ok])),
      )} neurons=${output.report.telemetry!.neurons}`,
    );
  });
});

describe("validator: false positive từ live Groq-20", () => {
  it("'no people present' không phải người không tên", async () => {
    const { hasUnnamedCharacter, retryFeedback } = await import("../src/core/validators.js");
    expect(hasUnnamedCharacter("A wide shot of an empty street with no people present.")).toBe(false);
    expect(hasUnnamedCharacter("Nobody walks the wet pavement.")).toBe(false);
    expect(hasUnnamedCharacter("A man crosses the wet pavement.")).toBe(true);
    const text = retryFeedback([{ code: "wordCount", detail: "Prompt có 24 từ. Cần 28–42 từ." }]);
    expect(text).toContain("[wordCount]");
    expect(text).toContain("24 words");
  });
});

describe("overlayText bắt chữ trên màn hình", () => {
  it("chặn 'showing the text … letters'", async () => {
    const { validateDraft } = await import("../src/core/validators.js");
    const task = { sceneId: "004", title: "t", source: "A crimson dialogue box flashes.", likelyPresent: [], neighbors: [] };
    const draft = {
      scene_id: "004", title: "t", environment: "desk", visible_cast: [], source_anchor: "A crimson dialogue box flashes.",
      prompt: "A solid crimson dialogue box flashes across the laptop display, showing the text Access Denied in sharp white letters while gray morning light falls across the scratched oak desk.",
    };
    const verdict = validateDraft(draft, task, [], [], new Map());
    expect(verdict.rejections.map((r) => r.code)).toContain("overlayText");
  });
});

describe("router: hết hạn mức ngày", () => {
  it("429 'tokens per day' tắt lane, lô sang lane khác ngay", async () => {
    const time = clock();
    let groqCalls = 0;
    const groq: Provider = {
      lane: "groq", model: "q", available: true,
      async generate(): Promise<GenerateResponse> {
        groqCalls += 1;
        throw new ProviderError("Rate limit reached on tokens per day (TPD)", { status: 429, lane: "groq", retryAfterMs: 424_000 });
      },
    };
    const cf: Provider = {
      lane: "cloudflare", model: "c", available: true,
      async generate(): Promise<GenerateResponse> {
        return { text: "{}", finishReason: "stop", model: "c", lane: "cloudflare", usage: { promptTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    };
    const sched = () => createScheduler({ rpm: 100, tpm: 1_000_000, rpd: 100, now: time.now, sleep: time.sleep });
    const router = createRouter({ slots: [{ provider: groq, scheduler: sched() }, { provider: cf, scheduler: sched() }], now: time.now, sleep: time.sleep, onLog: () => undefined });
    const start = time.now();
    expect((await router.call(request(["001"]), 1)).response.lane).toBe("cloudflare");
    expect((await router.call(request(["002"]), 1)).response.lane).toBe("cloudflare");
    expect(groqCalls).toBe(1);
    expect(time.now() - start).toBeLessThan(1_000);
    expect(router.state().find((row) => row.lane === "groq")?.exhausted).toBeTruthy();
  });
});
