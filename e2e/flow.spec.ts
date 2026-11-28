import { expect, test } from "@playwright/test";

const srt = Array.from({ length: 6 }, (_, i) => {
  const t = (n: number) => `00:00:${String(n).padStart(2, "0")},000`;
  return `${i + 1}\n${t(i * 8)} --> ${t(i * 8 + 8)}\nDerek đặt chén số ${i + 1} xuống bàn gỗ.\n`;
}).join("\n");

test("nút Tạo ảnh: một nút bấm, có ô chọn ảnh nhân vật, link lạ bị từ chối", async ({ page, request }) => {
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
  await expect(panel.getByRole("button", { name: /Đăng nhập Google Flow|cửa sổ đăng nhập/ })).toBeVisible();
  // Không cần mở Flow trước: nút Tạo ảnh bấm được ngay (server tự mở Chrome ẩn khi chạy). Không bấm ở đây.
  const start = panel.getByRole("button", { name: /Tạo ảnh cho \d+ cảnh/ });
  await expect(start).toBeVisible();
  await expect(start).toBeEnabled();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f70000000049454e44ae426082", "hex");
  const up = await request.post("/api/flow/refs/Derek", { headers: { "content-type": "image/png" }, data: png });
  expect(up.status()).toBe(200);
  expect(((await up.json()) as { refs: { name: string }[] }).refs.map((ref) => ref.name)).toContain("Derek");
  expect((await request.post("/api/flow/refs/Derek", { headers: { "content-type": "text/html" }, data: "<b>x</b>" })).status()).toBe(400);
  expect((await request.get("/api/flow/refs/Derek")).headers()["content-type"]).toBe("image/png");
  const bad = await request.post("/api/flow/config", { data: { projectUrl: "https://evil.example/project/x" } });
  expect(bad.status()).toBe(400);
  await request.delete(`/api/jobs/${id}`);
});
