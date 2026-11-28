import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockProvider } from "../src/core/providers/mock.js";
import { createScheduler } from "../src/core/scheduler.js";
import { buildServerLanes, memoryUsage, type BuiltLanes } from "../src/server/jobLanes.js";
import { JobManager, sanitizeSettings } from "../src/server/jobs.js";
import { handleJobsApi } from "../src/server/jobsApi.js";

const SRT = Array.from({ length: 12 }, (_, i) => {
  const start = i * 8;
  const t = (n: number) => `00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")},000`;
  return `${i + 1}\n${t(start)} --> ${t(start + 8)}\nLan đặt chén ${i + 1} xuống bàn gỗ trong căn bếp nhỏ.\n`;
}).join("\n");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-jobs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mockLanes = (fail?: Record<string, "language" | "omit">): BuiltLanes => ({
  slots: [{ provider: createMockProvider({ delayMs: 1, fail }), scheduler: createScheduler({ rpm: 6_000, tpm: 50_000_000, rpd: 1_000_000 }) }],
  labels: ["mock"],
  keySource: "none",
});

function manager(extra: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) {
  return new JobManager({ dir, env: {}, usage: memoryUsage(), persistDelayMs: 0, buildLanes: () => mockLanes(), ...extra });
}

const call = (m: JobManager, path: string, init?: RequestInit) => handleJobsApi(new Request(`http://localhost:47230${path}`, init), m);

describe("job chạy nền ở server", () => {
  it("tạo job từ SRT, chạy xong, lưu ra đĩa và còn nguyên sau khi server khởi động lại", async () => {
    const m = manager();
    const made = m.create({ fileName: "a.srt", text: SRT, settings: { batchSize: 12, concurrency: 2 } });
    expect(made.ok).toBe(true);
    const id = (made as { id: string }).id;
    await m.wait(id);
    const job = m.get(id)!;
    expect(job.status).toBe("done");
    expect(job.label).toBe("Xong lượt chạy");
    expect(job.results.filter((row) => row.status === "accepted").length).toBeGreaterThanOrEqual(11);
    expect(job.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(readdirSync(dir).some((name) => name === `${id}.json`)).toBe(true);

    const again = manager();
    const loaded = again.get(id)!;
    expect(loaded.status).toBe("done");
    expect(loaded.results).toHaveLength(job.results.length);
    expect(again.list()[0].id).toBe(id);
    expect(again.export(id, "flowsheet")?.body).toContain("=== Cảnh 001");
  });

  it("không bao giờ ghi khóa API ra đĩa hay trả về qua API", async () => {
    const seen: string[] = [];
    const secret = ["gs", "k_"].join("") + "FAKEFAKEFAKEFAKE1234567890abcd";
    const m = manager({
      buildLanes: ({ keys }) => {
        seen.push(...keys.map((item) => item.key));
        return mockLanes();
      },
    });
    const res = await call(m, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ text: SRT, keys: [{ provider: "groq", key: secret, enabled: true }], settings: { useGroq: true } }),
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(seen).toContain(secret); // khóa tới được lane dựng trong bộ nhớ…
    await m.wait(id);
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name), "utf8")).not.toContain(secret);
    const detail = await (await call(m, `/api/jobs/${id}`)).text();
    const list = await (await call(m, "/api/jobs")).text();
    expect(detail).not.toContain(secret);
    expect(list).not.toContain(secret);
  });

  it("API: tạo, theo dõi (rev), xuất Flow/JSON, xoá; từ chối Origin lạ và dữ liệu sai", async () => {
    const m = manager();
    expect((await call(m, "/api/jobs", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await call(m, "/api/jobs", { method: "POST", body: "không phải json" })).status).toBe(400);
    expect((await call(m, "/api/jobs", { method: "GET", headers: { origin: "https://evil.example" } })).status).toBe(403);

    const res = await call(m, "/api/jobs", { method: "POST", body: JSON.stringify({ fileName: "b.srt", text: SRT, settings: { batchSize: 12 } }) });
    const { id, job: first } = (await res.json()) as { id: string; job: { status: string } };
    expect(["running", "queued"]).toContain(first.status);
    await m.wait(id);

    const detail = (await (await call(m, `/api/jobs/${id}`)).json()) as { summary: { status: string; rev: number; accepted: number; sceneCount: number }; results: unknown[]; scenes: unknown[] };
    expect(detail.summary.status).toBe("done");
    expect(detail.summary.sceneCount).toBe(12);
    expect(detail.results).toHaveLength(12);
    const same = (await (await call(m, `/api/jobs/${id}?rev=${detail.summary.rev}`)).json()) as { unchanged?: boolean };
    expect(same.unchanged).toBe(true);

    const flow = await call(m, `/api/jobs/${id}/export?kind=flowsheet`);
    expect(flow.headers.get("content-disposition")).toContain("b.flow.txt");
    expect(await flow.text()).toContain("Ảnh tham chiếu:");
    expect((await call(m, `/api/jobs/${id}/export?kind=json`)).status).toBe(200);
    expect((await call(m, `/api/jobs/${id}/export?kind=xyz`)).status).toBe(400);
    expect((await call(m, "/api/jobs/job-khong-co")).status).toBe(404);

    expect(((await (await call(m, "/api/jobs")).json()) as { jobs: unknown[] }).jobs).toHaveLength(1);
    expect((await call(m, `/api/jobs/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await call(m, "/api/jobs")).json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("job đang chạy lúc server tắt → 'interrupted', giữ phần đã xong; job chỉ dùng khóa .env được liệt kê để tự chạy tiếp", async () => {
    const m = manager();
    const id = (m.create({ fileName: "c.srt", text: SRT }) as { id: string }).id;
    await m.wait(id);
    const file = join(dir, `${id}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.status = "running";
    record.startedAt = 1_000;
    record.savedAt = 4_000;
    record.elapsedMs = 500;
    record.keySource = "server";
    writeFileSync(file, JSON.stringify(record));
    const restarted = manager();
    const job = restarted.get(id)!;
    expect(job.status).toBe("interrupted");
    expect(job.elapsedMs).toBe(3_500);
    expect(job.results.some((row) => row.status === "accepted")).toBe(true);
    expect(restarted.interruptedServerJobs()).toEqual([id]);
  });

  it("chạy tiếp: giữ cảnh đã đạt, chạy lại cảnh chưa đạt", async () => {
    let builds = 0;
    const m = manager({ buildLanes: () => (builds++ === 0 ? mockLanes({ "003": "language", "005": "omit" }) : mockLanes()) });
    const id = (m.create({ fileName: "d.srt", text: SRT, settings: { maxAttempts: 1, batchSize: 12 } }) as { id: string }).id;
    await m.wait(id);
    const before = m.get(id)!;
    const failedBefore = before.results.filter((row) => row.status !== "accepted").map((row) => row.sceneId);
    expect(failedBefore.length).toBeGreaterThan(0);
    const keep = before.results.find((row) => row.status === "accepted")!;
    expect(m.resume(id, []).ok).toBe(true);
    await m.wait(id);
    const after = m.get(id)!;
    expect(after.status).toBe("done");
    expect(after.results.every((row) => row.status === "accepted")).toBe(true);
    expect(after.results.find((row) => row.sceneId === keep.sceneId)?.prompt).toBe(keep.prompt);
  });

  it("dừng job giữa chừng: trạng thái cancelled, giữ phần đã xong", async () => {
    const slow: BuiltLanes = {
      slots: [{ provider: createMockProvider({ delayMs: 400 }), scheduler: createScheduler({ rpm: 6_000, tpm: 50_000_000, rpd: 1_000_000 }) }],
      labels: ["mock"],
      keySource: "none",
    };
    const m = manager({ buildLanes: () => slow });
    const id = (m.create({ fileName: "e.srt", text: SRT, settings: { batchSize: 4, concurrency: 1 } }) as { id: string }).id;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.cancel(id)).toBe(true);
    await m.wait(id);
    expect(m.get(id)!.status).toBe("cancelled");
    expect(m.cancel(id)).toBe(false);
  });

  it("nhận kết quả đã đạt từ trước (prior) và bỏ qua dữ liệu lạ", async () => {
    const m = manager();
    const scenes = Array.from({ length: 3 }, (_, i) => ({ sceneId: `00${i + 1}`, title: "t", source: `Lan mở cửa ${i + 1}.`, start: "", end: "" }));
    const prior = [
      { sceneId: "001", status: "accepted", attempts: 1, title: "t", environment: "bếp", prompt: "Wide shot of the quiet kitchen with the wooden table and a single cup in soft daylight from the window.", visibleCast: [], rejections: [] },
      { sceneId: "999", status: "accepted", prompt: "x" },
      { sceneId: "002", status: "failed", prompt: "bỏ" },
    ];
    const id = (m.create({ scenes, prior, knownNames: ["Lan"] }) as { id: string }).id;
    expect(m.get(id)!.results[0].prompt).toContain("quiet kitchen");
    await m.wait(id);
    expect(m.get(id)!.results[0].prompt).toContain("quiet kitchen");
    expect(m.get(id)!.results).toHaveLength(3);
  });
});

describe("lane mặc định phía server", () => {
  const env = { GEMINI_API_KEY: "x".repeat(12), GROQ_API_KEY: "y".repeat(12), CLOUDFLARE_API_TOKEN: "z".repeat(12), CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) };

  it("mặc định: Gemini chính, Cloudflare dự phòng, Groq tắt", () => {
    const settings = sanitizeSettings({});
    expect(settings.useGroq).toBe(false);
    const built = buildServerLanes({ settings, keys: [], env, usage: memoryUsage() });
    expect(built.slots.map((slot) => `${slot.provider.lane}:${slot.backup ? "backup" : "primary"}`)).toEqual(["gemini:primary", "cloudflare:backup"]);
    expect(built.keySource).toBe("server");
    expect(JSON.stringify(built.labels)).not.toContain("xxxx");
  });

  it("bật Groq thì Groq cũng là dự phòng; không có khóa thì không có lane", () => {
    const withGroq = buildServerLanes({ settings: { ...sanitizeSettings({ useGroq: true }) }, keys: [], env, usage: memoryUsage() });
    expect(withGroq.slots.map((slot) => slot.provider.lane)).toEqual(["gemini", "groq", "cloudflare"]);
    expect(buildServerLanes({ settings: sanitizeSettings({}), keys: [], env: {}, usage: memoryUsage() }).slots).toHaveLength(0);
    const browser = buildServerLanes({ settings: sanitizeSettings({}), keys: [{ provider: "gemini", key: "k".repeat(20), enabled: true }], env: {}, usage: memoryUsage() });
    expect(browser.keySource).toBe("browser");
  });
});
