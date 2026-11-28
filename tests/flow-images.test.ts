import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFlowError, countGeneration, gapMs, normalizeProjectUrl, poolState, splitMentions } from "../src/core/flowImages.js";
import { handleFlowApi } from "../src/server/flow/api.js";
import { FlowError, fullSizeSrc, type FlowDriver, type GenerateRequest } from "../src/server/flow/driver.js";
import { FlowImageManager } from "../src/server/flow/imageJobs.js";
import { buildZip, crc32 } from "../src/server/flow/zip.js";

const PROJECT = "https://flow.google.com/project/0f8e4c1a-1111-2222-3333-444455556666";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("tách @Tên", () => {
  it("giữ đúng thứ tự, tách cả @You's", () => {
    expect(splitMentions("@You's hand holds a card while @Derek waits. @you smiles", ["You", "Derek"])).toEqual([
      { mention: "You" },
      { text: "'s hand holds a card while " },
      { mention: "Derek" },
      { text: " waits. " },
      { mention: "You" },
      { text: " smiles" },
    ]);
  });
  it("không cắt tên dài hơn và bỏ qua tên không có ảnh", () => {
    expect(splitMentions("@Youth and @Chloe", ["You"])).toEqual([{ text: "@Youth and @Chloe" }]);
  });
});

describe("hạn mức", () => {
  it("đặt lại sau 24 giờ từ lần đầu", () => {
    const t0 = 1_000_000;
    let usage = countGeneration({}, "pro", t0);
    usage = countGeneration(usage, "pro", t0 + 1000, 1);
    expect(poolState(usage, "pro", t0 + 2000)).toMatchObject({ used: 2, limit: 20, left: 18 });
    expect(poolState(usage, "pro", t0 + 24 * 3600 * 1000)).toMatchObject({ used: 0, left: 20 });
    expect(poolState(usage, "nb2", t0)).toMatchObject({ limit: 400, left: 400 });
  });
  it("giãn cách nằm trong khoảng", () => {
    expect(gapMs(60, 120, () => 0)).toBe(60_000);
    expect(gapMs(60, 120, () => 1)).toBe(120_000);
  });
});

describe("phân loại lỗi và link", () => {
  it("nhận câu trong trợ giúp Flow", () => {
    expect(classifyFlowError("You're requesting generations too quickly")).toBe("rate");
    expect(classifyFlowError("Something new")).toBe("unknown");
  });
  it("chỉ nhận link project Flow", () => {
    expect(normalizeProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
    expect(normalizeProjectUrl("https://evil.example/project/0f8e4c1a-1111-2222-3333-444455556666")).toBeNull();
  });
  it("đổi ảnh xem trước /asb/ sang cỡ gốc", () => {
    expect(fullSizeSrc("https://flow.google.com/asb/abc_DEF=s512-rw")).toBe("https://flow.google.com/asb/abc_DEF=s0");
    expect(fullSizeSrc("https://flow-content.google/image/0f8e4c1a-1111-2222-3333-444455556666")).toBe("https://flow-content.google/image/0f8e4c1a-1111-2222-3333-444455556666");
  });
  it("zip đúng CRC", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    const zip = buildZip([{ name: "scene-001.png", data: PNG }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});

class FakeDriver implements FlowDriver {
  calls: GenerateRequest[] = [];
  failWith: FlowError[] = [];
  async status() {
    return { browserOpen: true, signedIn: true, url: PROJECT, inProject: true };
  }
  async open() {}
  async currentProjectUrl() {
    return PROJECT;
  }
  async checkReferences(_url: string, names: string[]) {
    return Object.fromEntries(names.map((name) => [name, name !== "Arthur"]));
  }
  async generate(request: GenerateRequest) {
    this.calls.push(request);
    const fail = this.failWith.shift();
    if (fail) throw fail;
    return [{ data: PNG, mime: "image/png", width: 1376, height: 768 }];
  }
}

const dirs: string[] = [];
function setup(driver = new FakeDriver()) {
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  dirs.push(dir);
  let clock = 1_700_000_000_000;
  const sleeps: number[] = [];
  const manager = new FlowImageManager({
    dir,
    driver,
    now: () => (clock += 10),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  manager.setConfig({ projectUrl: PROJECT });
  return { manager, driver, sleeps, dir };
}
async function settle(manager: FlowImageManager) {
  for (let i = 0; i < 200 && manager.activeId(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 5));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCENES = [
  { sceneId: "001", prompt: "@You opens the laptop.", references: ["You"] },
  { sceneId: "002", prompt: "@Derek points at the screen.", references: ["Derek"] },
  { sceneId: "003", prompt: "An empty office at night.", references: [] },
];

describe("job ảnh Flow", () => {
  it("tạo từng cảnh, nghỉ giữa hai ảnh, đếm hạn mức", async () => {
    const { manager, driver, sleeps } = setup();
    const made = manager.create({ label: "test", scenes: SCENES });
    expect(made.ok).toBe(true);
    await settle(manager);
    const job = manager.get((made as { id: string }).id)!;
    expect(job.status).toBe("done");
    expect(job.scenes.every((scene) => scene.images.length === 1)).toBe(true);
    expect(driver.calls.map((call) => call.model)).toEqual(["nano-banana-2.1", "nano-banana-2.1", "nano-banana-2.1"]);
    expect(sleeps).toEqual([90_000, 90_000]);
    expect(manager.quota().nb2.used).toBe(3);
  });

  it("Flow báo tạo quá nhanh thì dừng hẳn, không thử lại, chạy tiếp được", async () => {
    const driver = new FakeDriver();
    driver.failWith = [new FlowError("rate", "Flow báo: You're requesting generations too quickly")];
    const { manager } = setup(driver);
    const made = manager.create({ scenes: SCENES }) as { id: string };
    await settle(manager);
    const job = manager.get(made.id)!;
    expect(job.status).toBe("paused");
    expect(job.pauseKind).toBe("rate");
    expect(driver.calls).toHaveLength(1);
    expect(manager.resume(made.id).ok).toBe(true);
    await settle(manager);
    expect(manager.get(made.id)!.status).toBe("done");
  });

  it("dừng khi hết hạn mức Pro", async () => {
    const { manager } = setup();
    for (let i = 0; i < 20; i++) manager.usage = countGeneration(manager.usage, "pro", Date.now() + 1e12);
    const made = manager.create({ scenes: SCENES, model: "nano-banana-pro" }) as { id: string };
    await settle(manager);
    expect(manager.get(made.id)!.pauseKind).toBe("quota");
  });

  it("tạo lại một cảnh thay ảnh cũ; API zip và ảnh chỉ đọc file hợp lệ", async () => {
    const { manager, driver } = setup();
    const made = manager.create({ scenes: SCENES }) as { id: string };
    await settle(manager);
    expect(manager.regenerate(made.id, "002", "@Derek waves.").ok).toBe(true);
    await settle(manager);
    const scene = manager.get(made.id)!.scenes[1];
    expect(scene.images[0].file).toBe("002-2-1.png");
    expect(driver.calls.at(-1)?.prompt).toBe("@Derek waves.");
    const zip = await handleFlowApi(new Request(`http://localhost/api/flow/jobs/${made.id}/zip`), manager, driver);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const bad = await handleFlowApi(new Request(`http://localhost/api/flow/img/${made.id}/..%2F..%2Fsecret.png`), manager, driver);
    expect(bad.status).toBe(404);
    const refs = await handleFlowApi(new Request("http://localhost/api/flow/check-refs", { method: "POST", body: JSON.stringify({ names: ["You", "Arthur"] }) }), manager, driver);
    expect(await refs.json()).toMatchObject({ found: { You: true, Arthur: false } });
  });

  it("server khởi động lại: job đang chạy thành bị ngắt, không tự chạy", () => {
    const { manager, dir, driver } = setup();
    const made = manager.create({ scenes: SCENES }) as { id: string };
    manager.cancel(made.id);
    const job = manager.get(made.id)!;
    job.status = "running";
    manager.flush();
    const again = new FlowImageManager({ dir, driver });
    expect(again.get(made.id)!.status).toBe("interrupted");
    expect(again.activeId()).toBeNull();
  });
});
