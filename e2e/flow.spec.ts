import { expect, test } from "@playwright/test";

const srt = Array.from({ length: 6 }, (_, i) => {
  const t = (n: number) => `00:00:${String(n).padStart(2, "0")},000`;
  return `${i + 1}\n${t(i * 8)} --> ${t(i * 8 + 8)}\nDerek đặt chén số ${i + 1} xuống bàn gỗ.\n`;
}).join("\n");

test("nút Tạo ảnh: mở bảng Flow, chưa kết nối thì chưa cho chạy, link lạ bị từ chối", async ({ page, request }) => {
  const res = await request.post("/api/jobs", { data: { fileName: "flow.srt", text: srt, mode: "mock", settings: { batchSize: 6, concurrency: 1 } } });
  expect(res.status()).toBe(202);
  const id = ((await res.json()) as { id: string }).id;
  await expect.poll(async () => ((await (await request.get(`/api/jobs/${id}`)).json()) as { summary: { status: string } }).summary.status, { timeout: 20_000 }).toBe("done");
  await page.addInitScript((jobId) => localStorage.setItem("storyprompt.job.v1", jobId), id);
  await page.goto("/");
  await expect(page.locator("#list .scene")).toHaveCount(6);
  await page.getByTestId("flow-open").click();
  const panel = page.getByRole("dialog", { name: "Tạo ảnh bằng Google Flow" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: /Kết nối Google Flow|Mở lại/ })).toBeVisible();
  const start = panel.getByRole("button", { name: /Tạo ảnh cho \d+ cảnh/ });
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();
  const bad = await request.post("/api/flow/config", { data: { projectUrl: "https://evil.example/project/x" } });
  expect(bad.status()).toBe(400);
  await request.delete(`/api/jobs/${id}`);
});
