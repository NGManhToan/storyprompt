import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "../src/core/errors.js";
import { keysFromLegacy, maskKey, validateNewKey, type StoredKey } from "../src/core/keys.js";
import { buildSceneRequest } from "../src/core/prompts.js";
import { createRouter } from "../src/core/router.js";
import { createScheduler } from "../src/core/scheduler.js";
import type { GenerateResponse, Provider } from "../src/core/types.js";
import { testKey } from "../src/server/api.js";
import { buildLanes, buildSlots, laneCredentials, type ServerHealth } from "../src/ui/lanes.js";
import { defaultSettings, migrateSettings, type Settings } from "../src/ui/storage.js";

const SECRET = "AQ.fakeKeyForTestsOnly1234567890abcd";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

function key(partial: Partial<StoredKey> & Pick<StoredKey, "id" | "provider">): StoredKey {
  return { label: "", key: `${partial.id}-secret-value-0000`, enabled: true, ...partial };
}

function withKeys(keys: StoredKey[], extra: Partial<Settings> = {}): Settings {
  return { ...defaultSettings, keys, directBrowser: false, ...extra };
}

const noServer: ServerHealth = { ok: true, gemini: false, groq: false, cloudflare: false };

describe("quản lý khóa API", () => {
  it("che khóa: 4 ký tự đầu + 4 ký tự cuối, khóa ngắn che hết", () => {
    expect(maskKey("AIzaSyABCDEFGHIJKLMNOP1234")).toBe("AIza…1234");
    expect(maskKey("short")).toBe("••••••••");
    expect(maskKey("")).toBe("");
    expect(maskKey(SECRET)).not.toContain("fakeKeyForTests");
  });

  it("kiểm tra khi thêm: trống, khoảng trắng, trùng, account Cloudflare", () => {
    const existing = [key({ id: "a", provider: "groq", key: "gsk_same_key_000000" })];
    expect(validateNewKey({ provider: "gemini", key: "  " }, existing)).toMatch(/Chưa nhập/);
    expect(validateNewKey({ provider: "gemini", key: "ab cd" }, existing)).toMatch(/khoảng trắng/);
    expect(validateNewKey({ provider: "groq", key: "gsk_same_key_000000" }, existing)).toMatch(/đã có/);
    expect(validateNewKey({ provider: "gemini", key: "gsk_same_key_000000" }, existing)).toBeNull();
    expect(validateNewKey({ provider: "cloudflare", key: "tok_1234567890", account: "xyz" }, existing)).toMatch(/32 ký tự/);
    expect(validateNewKey({ provider: "cloudflare", key: "tok_1234567890", account: ACCOUNT }, existing)).toBeNull();
  });

  it("chuyển settings cũ (một ô khóa) thành danh sách và bỏ các ô cũ", () => {
    const migrated = migrateSettings({ geminiKey: "g-key-0000000000", groqKey: "q-key-0000000000", cfToken: "c-token-00000000", cfAccount: ACCOUNT, footer: "giữ lại" } as Partial<Settings>);
    expect(migrated.keys.map((item) => item.provider)).toEqual(["gemini", "groq", "cloudflare"]);
    expect(migrated.keys[2].account).toBe(ACCOUNT);
    expect(migrated.footer).toBe("giữ lại");
    expect("geminiKey" in migrated).toBe(false);
    expect(keysFromLegacy({})).toEqual([]);
    // settings v4 đã có keys thì giữ nguyên, không sinh thêm
    const kept = migrateSettings({ keys: [key({ id: "x", provider: "groq" })], geminiKey: "old" } as Partial<Settings>);
    expect(kept.keys).toHaveLength(1);
  });
});

describe("mặc định lane", () => {
  it("Groq tắt mặc định (Gemini chính, Cloudflare dự phòng)", () => {
    expect(defaultSettings.useGroq).toBe(false);
    const lanes = buildLanes(withKeys([key({ id: "q1", provider: "groq" }), key({ id: "g1", provider: "gemini" })]), noServer, "live");
    expect(lanes.map((lane) => lane.lane)).toEqual(["gemini"]);
    expect(migrateSettings({ useGroq: true } as Partial<Settings>).useGroq).toBe(false);
  });
});

describe("mỗi khóa là một lane riêng", () => {
  it("tạo một provider cho mỗi khóa dùng được, bỏ khóa tắt và Cloudflare thiếu account", () => {
    const settings = withKeys([
      key({ id: "g1", provider: "gemini" }),
      key({ id: "g2", provider: "gemini", label: "Gmail phụ" }),
      key({ id: "g3", provider: "gemini", enabled: false }),
      key({ id: "q1", provider: "groq" }),
      key({ id: "c1", provider: "cloudflare", account: ACCOUNT }),
      key({ id: "c2", provider: "cloudflare", account: "" }),
    ], { useGroq: true });
    const lanes = buildLanes(settings, noServer, "live");
    expect(lanes.map((lane) => `${lane.lane}:${lane.keyId}`)).toEqual(["gemini:g1", "gemini:g2", "groq:q1", "cloudflare:c1"]);
    expect(new Set(lanes.map((lane) => lane.usageKey)).size).toBe(4);
    expect(lanes[1].keyLabel).toBe("Gmail phụ");
  });

  it("khóa server (.env) là một entry chỉ đọc, tắt được theo nhà cung cấp", () => {
    const health: ServerHealth = { ok: true, gemini: true, groq: false, cloudflare: false };
    const settings = withKeys([key({ id: "g1", provider: "gemini" })]);
    expect(laneCredentials(settings, "gemini", health).map((cred) => cred.id)).toEqual(["g1", "server"]);
    expect(laneCredentials({ ...settings, serverOff: ["gemini"] }, "gemini", health).map((cred) => cred.id)).toEqual(["g1"]);
    expect(laneCredentials(settings, "groq", health)).toEqual([]);
    const server = laneCredentials(settings, "gemini", health)[1];
    expect(server).toMatchObject({ server: true, key: "" });
  });

  it("slot mỗi khóa có bộ đếm ngày riêng", () => {
    const settings = withKeys([key({ id: "g1", provider: "gemini" }), key({ id: "g2", provider: "gemini" })]);
    const lanes = buildLanes(settings, noServer, "live");
    const asked: string[] = [];
    buildSlots(settings, lanes, {
      mode: "live",
      usage: (name) => {
        asked.push(name);
        return { dayKey: "2026-11-27", count: name.endsWith("g1") ? 7 : 0, neurons: 0 };
      },
      onUsage: () => {},
    });
    expect(asked).toEqual(["gemini:g1", "gemini:g2"]);
  });

  it("429 trên key 1 thì lô sang key 2 cùng lane, breaker riêng cho từng key", async () => {
    let time = 1_700_000_000_000;
    const sleep = async (ms: number) => {
      time += Math.max(1, ms);
    };
    const calls: string[] = [];
    const logs: { key?: string; status: string }[] = [];
    const mk = (id: string, fail: boolean): Provider => ({
      lane: "gemini",
      model: "gemini",
      available: true,
      keyId: id,
      keyLabel: id,
      async generate(): Promise<GenerateResponse> {
        calls.push(id);
        if (fail) throw new ProviderError("RESOURCE_EXHAUSTED quota", { status: 429, lane: "gemini" });
        return { text: "{}", finishReason: "stop", model: "gemini", lane: "gemini", usage: { promptTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    });
    const sched = () => createScheduler({ rpm: 100, tpm: 1_000_000, rpd: 100, now: () => time, sleep });
    const router = createRouter({
      slots: [{ provider: mk("k1", true), scheduler: sched() }, { provider: mk("k2", false), scheduler: sched() }],
      now: () => time,
      sleep,
      onLog: (log) => logs.push({ key: log.key, status: log.status }),
    });
    const req = buildSceneRequest({ tasks: [{ sceneId: "001", title: "t", source: "Lan đặt chén xuống bàn.", likelyPresent: ["Lan"], neighbors: [] }], knownNames: ["Lan"], maxOutputTokens: 8192, temperature: 0.5 });
    await router.call(req, 1);
    await router.call(req, 1);
    // k1 chỉ bị gọi một lần (rồi nghỉ 5 phút); k2 nhận cả hai lô
    expect(calls).toEqual(["k1", "k2", "k2"]);
    expect(logs).toEqual([{ key: "k1", status: "rate_limited" }]);
    const state = router.state();
    expect(state.find((row) => row.key === "k1")!.coolUntil).toBeGreaterThan(time);
    expect(state.find((row) => row.key === "k2")!.coolUntil).toBe(0);
  });
});

describe("POST /api/test-key", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("Gemini dùng endpoint liệt kê model, gửi key bằng header và trả số model", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const result = await testKey({ provider: "gemini", key: SECRET }, (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ models: [{}, {}, {}] }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, models: 3 });
    expect(seen!.url).toContain("/v1beta/models");
    expect(seen!.url).not.toContain(SECRET);
    expect(seen!.headers["x-goog-api-key"]).toBe(SECRET);
  });

  it("key sai → 403, thông báo không chứa giá trị khóa", async () => {
    const result = await testKey({ provider: "groq", key: SECRET }, (async () =>
      new Response(JSON.stringify({ error: { message: `Invalid API Key ${SECRET}` } }), { status: 401 })) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/từ chối/);
    expect(result.message).not.toContain(SECRET);
  });

  it("Cloudflare cần account 32 hex; khóa server rỗng trong .env thì báo thiếu", async () => {
    const never = (async () => {
      throw new Error("không được gọi mạng");
    }) as unknown as typeof fetch;
    expect((await testKey({ provider: "cloudflare", key: "tok", account: "abc" }, never)).message).toMatch(/32 ký tự/);
    delete process.env.GROQ_API_KEY;
    expect((await testKey({ provider: "groq" }, never)).message).toMatch(/chưa có khóa/);
    expect((await testKey({ provider: "nope", key: "x" }, never)).message).toMatch(/không hợp lệ/);
  });

  it("khóa server lấy từ .env và gọi đúng endpoint Cloudflare theo account", async () => {
    process.env.CLOUDFLARE_API_TOKEN = SECRET;
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    let url = "";
    const result = await testKey({ provider: "cloudflare" }, (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ result: [{}] }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(url).toContain(`/accounts/${ACCOUNT}/ai/models/search`);
  });

  it("lỗi mạng cũng không làm lộ khóa", async () => {
    const result = await testKey({ provider: "gemini", key: SECRET }, (async () => {
      throw new Error(`fetch failed for ${SECRET}`);
    }) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(SECRET);
  });
});

describe("router: model suy luận trả rỗng vì hết max_tokens", () => {
  it("hai lần liên tiếp finish_reason=length không có hàng → tắt lane, lô sau sang lane khác", async () => {
    let time = 1_700_000_000_000;
    const sleep = async (ms: number) => {
      time += Math.max(1, ms);
    };
    const calls: string[] = [];
    const mk = (lane: Provider["lane"], empty: boolean): Provider => ({
      lane,
      model: lane,
      available: true,
      async generate(): Promise<GenerateResponse> {
        calls.push(lane);
        return empty
          ? { text: "", finishReason: "length", model: lane, lane, usage: { promptTokens: 2000, outputTokens: 976, totalTokens: 2976 } }
          : { text: '[{"scene_id":"001"}]', finishReason: "stop", model: lane, lane, usage: { promptTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    });
    const sched = () => createScheduler({ rpm: 100, tpm: 1_000_000, rpd: 100, now: () => time, sleep });
    const router = createRouter({
      slots: [{ provider: mk("cloudflare", true), scheduler: sched() }, { provider: mk("groq", false), scheduler: sched() }],
      now: () => time,
      sleep,
      onLog: () => {},
    });
    const req = buildSceneRequest({ tasks: [{ sceneId: "001", title: "t", source: "Lan đặt chén xuống bàn.", likelyPresent: ["Lan"], neighbors: [] }], knownNames: ["Lan"], maxOutputTokens: 8192, temperature: 0.5 });
    for (let i = 0; i < 5; i += 1) await router.call(req, 1);
    expect(calls.filter((lane) => lane === "cloudflare")).toHaveLength(2);
    expect(router.state().find((row) => row.lane === "cloudflare")!.disabled).toMatch(/max_tokens/);
  });
});

describe("Flow defaults", () => {
  it("pre-fills the five character names and swaps the legacy webtoon footer", () => {
    const migrated = migrateSettings({ extraNames: "", footer: "modern 2D webtoon comic style, crisp ink line art, cel-shaded, warm daylight, clean frame, no text, 16:9" } as Partial<Settings>);
    expect(migrated.extraNames).toBe("You, Derek, Chloe, Julian, Arthur");
    expect(migrated.footer).toBe(defaultSettings.footer);
    expect(migrated.aspectRatio).toBe("16:9");
    expect(migrateSettings({ extraNames: "Lan, Minh" } as Partial<Settings>).extraNames).toBe("Lan, Minh");
  });
});
