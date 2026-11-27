import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const srt = `1
00:00:00,000 --> 00:00:08,000
Hello from the dropped street scene.

2
00:00:08,000 --> 00:00:16,000
Second beat stays on the wet pavement.
`;

function contrast(a: string, b: string) {
  const channel = (rgb: string) => rgb.match(/\d+/g)!.slice(0, 3).map((part) => {
    const value = Number(part) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const lum = (rgb: string) => {
    const [r, g, b] = channel(rgb);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

async function dropSrt(page: Page, name: string, body = srt) {
  await page.locator(".drop").evaluate((element, payload: { name: string; body: string }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([payload.body], payload.name, { type: "application/x-subrip" }));
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name, body });
  await expect(page.locator("#title")).toContainText("Cố định 8s");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("storyprompt.settings.v2", JSON.stringify({
      geminiKey: "test-key",
      directBrowser: false,
      lane: "gemini",
      maxAttempts: 1,
      batchSize: 4,
      concurrency: 1,
    }));
  });
});

test("empty drop, clipboard, edit survival, clear, style, nav, theme", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".empty-card")).toBeVisible();
  await dropSrt(page, "drop-one.srt");
  await expect(page.locator("#list .scene")).toHaveCount(2);

  await page.locator("#prompt").fill("A quiet street prompt that must survive the scene change.");
  await page.locator("#next").click();
  await expect(page.locator("#title")).toContainText("#002");
  await page.locator("#prev").click();
  await expect(page.locator("#prompt")).toHaveValue("A quiet street prompt that must survive the scene change.");

  await page.locator("#clear").click();
  await expect(page.getByText("Xóa nội dung prompt của cảnh này?")).toBeVisible();
  await page.getByRole("button", { name: "Giữ lại" }).click();
  await expect(page.locator("#prompt")).toHaveValue("A quiet street prompt that must survive the scene change.");
  await page.locator("#clear").click();
  await page.getByRole("button", { name: "Xóa", exact: true }).click();
  await expect(page.locator("#prompt")).toHaveValue("");

  await page.locator("#prompt").fill("Clipboard sentence for the street still.");
  await page.locator("#copy").click();
  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain("Clipboard sentence");

  await page.locator("#style").selectOption("webtoon");
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("storyprompt.settings.v4") || localStorage.getItem("storyprompt.settings.v3") || localStorage.getItem("storyprompt.settings.v2") || "")).toContain("webtoon");

  await page.getByRole("button", { name: "Báo cáo" }).click();
  await expect(page.getByRole("heading", { name: "Báo cáo" })).toBeVisible();
  await page.getByRole("button", { name: "Đóng ×" }).click();
  await page.getByTitle("Cài đặt").click();
  await expect(page.getByRole("heading", { name: "Cài đặt" })).toBeVisible();
  await page.getByRole("button", { name: "Đóng" }).click();
  await page.locator(".collapse").click();
  await expect(page.locator(".scenes")).toBeHidden();
  await page.locator(".collapse").click();
  await expect(page.locator(".scenes")).toBeVisible();

  await page.locator("#theme").click();
  await expect(page.locator("body")).toHaveClass(/dark/);
  const colors = await page.evaluate(() => {
    const title = getComputedStyle(document.querySelector("#title")!);
    const body = getComputedStyle(document.body);
    return { text: title.color, bg: body.backgroundColor, title: document.querySelector("#title")!.textContent };
  });
  expect(colors.title).toContain("#001");
  expect(contrast(colors.text, colors.bg)).toBeGreaterThan(4.5);
  await page.locator("#theme").click();
  await expect(page.locator("body")).not.toHaveClass(/dark/);
});

test("autosave states, reload restore, and dismiss", async ({ page }) => {
  await page.goto("/");
  await dropSrt(page, "save-one.srt");
  await page.locator("#prompt").fill("Saved prompt that must come back after reload.");
  await expect(page.locator(".saved")).toContainText(/Chưa lưu|Đang lưu/);
  await expect(page.locator(".saved")).toContainText("Đã lưu", { timeout: 8_000 });

  await page.reload();
  await dropSrt(page, "save-one.srt");
  await expect(page.locator(".restore")).toBeVisible();
  const banner = await page.evaluate(() => {
    const root = document.querySelector(".restore")!;
    const keep = root.querySelector(".primary")!;
    const drop = [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("Bỏ"))!;
    const rootStyle = getComputedStyle(root);
    return {
      keep: { fg: getComputedStyle(keep).color, bg: getComputedStyle(keep).backgroundColor },
      drop: { fg: getComputedStyle(drop).color, bg: getComputedStyle(drop).backgroundColor },
      card: rootStyle.backgroundColor,
    };
  });
  expect(contrast(banner.keep.fg, banner.keep.bg)).toBeGreaterThan(3);
  expect(contrast(banner.drop.fg, banner.drop.bg)).toBeGreaterThan(3);
  await page.getByRole("button", { name: "Tiếp tục" }).click();
  await expect(page.locator("#prompt")).toHaveValue("Saved prompt that must come back after reload.");

  await page.reload();
  await dropSrt(page, "save-one.srt");
  await expect(page.locator(".restore")).toBeVisible();
  await page.getByRole("button", { name: "Bỏ" }).click();
  await expect(page.locator(".restore")).toHaveCount(0);
  await expect(page.locator("#prompt")).toHaveValue("");
});

test("save failed when storage throws", async ({ page }) => {
  await page.goto("/");
  await dropSrt(page, "fail-save.srt");
  await page.evaluate(() => {
    indexedDB.open = () => {
      throw new Error("blocked");
    };
  });
  await page.locator("#prompt").fill("This edit should report a failed save.");
  await expect(page.locator(".saved")).toContainText("Lưu thất bại", { timeout: 8_000 });
});

test("image add, lightbox, remove, and failed rewrite keeps the prompt", async ({ page }) => {
  await page.route("**/api/generate", (route) => route.fulfill({ status: 504, contentType: "application/json", body: "{\"error\":\"timeout\"}" }));
  await page.goto("/");
  await dropSrt(page, "image-one.srt");
  await page.locator("#prompt").fill("Keep this prompt when the provider times out.");
  await expect(page.locator(".saved")).toContainText("Đã lưu", { timeout: 8_000 });
  await page.locator("input[accept='image/*']").setInputFiles("public/fixtures/still-1.jpg");
  await expect(page.locator(".gallery")).toBeVisible();
  await page.locator("#expand").click();
  await expect(page.locator("#lightbox")).toBeVisible();
  await page.locator("#close").click();
  await page.locator(".remove-still").click();
  await expect(page.locator(".gallery")).toBeHidden();

  await page.locator("input[accept='image/*']").setInputFiles(["public/fixtures/still-1.jpg", "public/fixtures/still-2.jpg"]);
  await page.locator("#imageNext").click();
  await expect(page.locator("#thumbList button.active")).toHaveCount(1);

  await page.locator(".head-actions .primary").click();
  await expect(page.locator("#prompt")).toHaveValue("Keep this prompt when the provider times out.", { timeout: 20_000 });
});

test("invalid generate body does not wipe the prompt", async ({ page }) => {
  await page.route("**/api/generate", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "not-json" }));
  await page.goto("/");
  await dropSrt(page, "bad-json.srt");
  await page.locator("#prompt").fill("Prompt that must remain after a broken response.");
  await expect(page.locator(".saved")).toContainText("Đã lưu", { timeout: 8_000 });
  await page.locator(".head-actions .primary").click();
  await expect(page.locator("#prompt")).toHaveValue("Prompt that must remain after a broken response.", { timeout: 20_000 });
});

test("visual fidelity and viewport shots", async ({ page }) => {
  // So khớp layout với app tham chiếu trên 47311 và ghi ảnh vào /opt/cursor — chỉ có trên CI Linux.
  if (process.platform === "win32") test.skip();
  await mkdir("/opt/cursor/artifacts", { recursive: true });
  const viewports = [
    [1920, 1080],
    [1440, 900],
    [1366, 768],
    [1280, 720],
    [1024, 576],
    [768, 1024],
    [390, 844],
  ] as const;
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto("/?fixture=1");
    await expect(page.locator("#title")).toContainText("Cố định 8s");
    await page.screenshot({ path: `/opt/cursor/artifacts/app-${width}x${height}-light.png` });
    await page.locator("#theme").click();
    await expect(page.locator("body")).toHaveClass(/dark/);
    await page.screenshot({ path: `/opt/cursor/artifacts/app-${width}x${height}-dark.png` });
    await page.locator("#theme").click();
  }

  await page.setViewportSize({ width: 1024, height: 576 });
  await page.goto("http://127.0.0.1:47311/");
  const reference = await page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    return {
      scenes: box(".scenes"),
      title: document.querySelector("#title")?.textContent,
      gallery: box(".gallery"),
      save: box("#save"),
      tabs: box(".tabs"),
    };
  });
  await page.goto("/?fixture=1");
  await expect(page.locator("#title")).toContainText("#001 Cố định 8s");
  const actual = await page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    const save = box("#save");
    return {
      scenes: box(".scenes"),
      title: document.querySelector("#title")?.textContent,
      gallery: box(".gallery"),
      save,
      tabs: box(".tabs"),
      gap: save ? Math.round(innerHeight - save.y - save.h) : 0,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  const sceneDelta = Math.abs((actual.scenes?.w || 0) - (reference.scenes?.w || 0));
  const galleryDelta = Math.abs((actual.gallery?.w || 0) - (reference.gallery?.w || 0));
  let score = 100;
  if (actual.title !== reference.title) score -= 15;
  if (sceneDelta > 24) score -= 12;
  if (galleryDelta > 40) score -= 12;
  if ((actual.tabs?.h || 0) > (reference.tabs?.h || 0) + 18) score -= 8;
  if (actual.gap < 12) score -= 10;
  if (actual.overflow > 1) score -= 8;
  await writeFile("/opt/cursor/artifacts/fidelity.json", JSON.stringify({ score, sceneDelta, galleryDelta, reference, actual }, null, 2));
  expect(score).toBeGreaterThanOrEqual(90);
});
