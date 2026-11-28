import { expect, test } from "@playwright/test";

const srt = Array.from({ length: 10 }, (_, i) => {
  const t = (n: number) => `00:00:${String(n).padStart(2, "0")},000`;
  return `${i + 1}\n${t(i * 8)} --> ${t(i * 8 + 8)}\nLan đặt chén số ${i + 1} xuống bàn gỗ.\n`;
}).join("\n");

async function createMockJob(request: import("@playwright/test").APIRequestContext, fileName: string) {
  const res = await request.post("/api/jobs", { data: { fileName, text: srt, mode: "mock", settings: { batchSize: 10, concurrency: 1 } } });
  expect(res.status()).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

async function waitDone(request: import("@playwright/test").APIRequestContext, id: string) {
  await expect.poll(async () => ((await (await request.get(`/api/jobs/${id}`)).json()) as { summary: { status: string } }).summary.status, { timeout: 20_000 }).toBe("done");
}

test("job nền: đóng tab, mở lại vẫn thấy kết quả và thông báo 'Xong lượt chạy'", async ({ page, context, request }) => {
  const id = await createMockJob(request, "nen.srt");
  await waitDone(request, id);
  await page.addInitScript((jobId) => localStorage.setItem("storyprompt.job.v1", jobId), id);
  await page.goto("/");
  await expect(page.getByTestId("job-notice")).toContainText("Xong lượt chạy");
  await expect(page.locator("#list .scene")).toHaveCount(10);
  await page.close();

  // "Mở lại trình duyệt": tab mới, cùng localStorage → tự nối lại đúng job, không cần chạy lại.
  const again = await context.newPage();
  await again.goto("/");
  await expect(again.locator("#list .scene")).toHaveCount(10);
  await expect(again.getByTestId("job-notice")).toContainText("Xong lượt chạy");
  await again.getByRole("button", { name: "Đóng", exact: true }).first().click();
  await expect(again.getByTestId("job-notice")).toHaveCount(0);
  await again.reload();
  await expect(again.getByTestId("job-notice")).toHaveCount(0); // đã đóng thì không hiện lại
  await expect(again.locator("#list .scene")).toHaveCount(10);
  await request.delete(`/api/jobs/${id}`);
});

test("lịch sử chạy: liệt kê, mở lại, tải Flow/JSON", async ({ page, request }) => {
  const id = await createMockJob(request, "lich-su.srt");
  await waitDone(request, id);
  await page.goto("/");
  await page.getByTitle("Lịch sử chạy").click();
  const row = page.getByTestId("job-row").filter({ hasText: "lich-su.srt" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("10/10");
  const href = await row.getByRole("link", { name: /Flow/ }).getAttribute("href");
  expect(href).toBe(`/api/jobs/${id}/export?kind=flowsheet`);
  const flow = await request.get(href!);
  expect(flow.headers()["content-disposition"]).toContain("lich-su.flow.txt");
  expect(await flow.text()).toContain("Cảnh 001");
  await row.getByRole("button", { name: "Mở" }).click();
  await expect(page.locator("#list .scene")).toHaveCount(10);
  await request.delete(`/api/jobs/${id}`);
});
