import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Đo thật: chỉ chạy khi đặt LIVE_JOB=đường-dẫn-SRT (dùng khóa trong .env của server, tốn hạn mức).
const file = process.env.LIVE_JOB;
test.skip(!file, "đặt LIVE_JOB=<file.srt> để đo job nền thật");
test.setTimeout(30 * 60_000);

test("đo job nền: bấm Chạy, đóng trình duyệt giữa chừng, mở lại nhận kết quả", async ({ browser, request }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  let page = await context.newPage();
  await page.goto("/");
  const started = Date.now();
  await page.locator("label.drop input[type=file]").setInputFiles(file!);
  await expect(page.locator("#list .scene").first()).toBeVisible();
  await page.getByRole("button", { name: "Chạy", exact: true }).click();
  await expect(page.getByTestId("job-running")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(Number(process.env.LIVE_CLOSE_AFTER_MS ?? 25_000));
  const closedAt = Date.now();
  await page.close(); // đóng tab giữa chừng
  await new Promise((resolve) => setTimeout(resolve, 15_000)); // ... "đi chỗ khác"
  page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("job-running").or(page.getByTestId("job-notice"))).toBeVisible({ timeout: 20_000 });
  const reattachedAfter = Date.now() - closedAt;
  await expect(page.getByTestId("job-notice")).toContainText("Xong lượt chạy", { timeout: 25 * 60_000 });
  const wall = Date.now() - started;
  const list = (await (await request.get("/api/jobs")).json()) as { jobs: Array<Record<string, unknown>> };
  const mine = list.jobs[0];
  console.log(`[LIVE_JOB] ${JSON.stringify({ wallMsFromClick: wall, reattachedAfterMs: reattachedAfter, ...mine, fileName: undefined })}`);
  const notice = await page.getByTestId("job-notice").innerText();
  console.log(`[LIVE_JOB] banner: ${notice.replace(/\s+/g, " ").slice(0, 200)}`);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /Tải Flow/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.flow\.txt$/);
  void readFile;
});
