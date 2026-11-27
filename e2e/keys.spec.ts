import { expect, test } from "@playwright/test";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

test("quản lý khóa API: thêm, che, kiểm tra, tắt, xoá, giữ sau khi tải lại", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, gemini: true, groq: false, cloudflare: false, hints: { gemini: "…9z9z" } } }),
  );
  const tested: unknown[] = [];
  await page.route("**/api/test-key", async (route) => {
    tested.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, status: 200, message: "Key dùng được.", models: 7 } });
  });
  await page.goto("/");
  await page.getByTitle("Cài đặt").click();
  const keys = page.locator(".keys");
  await expect(keys).toBeVisible();

  // khóa server chỉ đọc
  const server = page.getByTestId("key-server-gemini");
  await expect(server).toContainText("Từ server (.env)");
  await expect(server).toContainText("9z9z");
  await server.getByRole("button", { name: "Kiểm tra" }).click();
  await expect(server).toContainText("Key dùng được");

  // thêm key Groq, có nhãn
  await keys.locator(".key-group", { hasText: "Groq" }).getByRole("button", { name: /Thêm key mới/ }).click();
  await page.locator(".key-form input[placeholder^='vd.']").fill("Groq phụ");
  await page.locator(".key-form input[type=password]").fill("gsk_abcdefghijklmnopqrstuvwxyz1234");
  await page.getByRole("button", { name: "Lưu key" }).click();
  const row = keys.locator(".key-row", { hasText: "gsk_…1234" });
  await expect(row).toBeVisible();
  await expect(row.locator("input.key-label")).toHaveValue("Groq phụ");
  await expect(keys).not.toContainText("abcdefghijklmnopqrstuvwxyz");

  // trùng key thì báo lỗi
  await keys.locator(".key-group", { hasText: "Groq" }).getByRole("button", { name: /Thêm key mới/ }).click();
  await page.locator(".key-form input[type=password]").fill("gsk_abcdefghijklmnopqrstuvwxyz1234");
  await page.getByRole("button", { name: "Lưu key" }).click();
  await expect(page.getByRole("alert")).toContainText("đã có");
  await page.getByRole("button", { name: "Huỷ" }).click();

  // Cloudflare cần account id
  await keys.locator(".key-group", { hasText: "Cloudflare" }).getByRole("button", { name: /Thêm key mới/ }).click();
  await page.locator(".key-form input[type=password]").fill("cfut_abcdefghijklmnopqrstuvwxyz");
  await page.getByRole("button", { name: "Lưu key" }).click();
  await expect(page.getByRole("alert")).toContainText("32 ký tự");
  await page.locator(".key-form label", { hasText: "Account ID" }).locator("input").fill(ACCOUNT);
  await page.getByRole("button", { name: "Lưu key" }).click();
  await expect(keys.locator(".key-row", { hasText: "cfut…wxyz" })).toBeVisible();

  // kiểm tra gửi đúng key qua server cục bộ
  await row.getByRole("button", { name: "Kiểm tra" }).click();
  await expect(row).toContainText("Key dùng được");
  expect(tested.at(-1)).toMatchObject({ provider: "groq", key: "gsk_abcdefghijklmnopqrstuvwxyz1234" });

  // tắt + tải lại vẫn còn
  await row.getByRole("checkbox").first().uncheck();
  await page.reload();
  await page.getByTitle("Cài đặt").click();
  const again = page.locator(".keys .key-row", { hasText: "gsk_…1234" });
  await expect(again.getByRole("checkbox").first()).not.toBeChecked();

  // xoá
  await again.getByRole("button", { name: /Xoá/ }).click();
  await expect(page.locator(".keys .key-row", { hasText: "gsk_…1234" })).toHaveCount(0);
});

test("key lưu trong localStorage v2 cũ được chuyển sang danh sách", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("storyprompt.settings.v2", JSON.stringify({ geminiKey: "AIzaOldKeyFromV2000000001234" }));
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true, gemini: false, groq: false, cloudflare: false } }));
  await page.goto("/");
  await page.getByTitle("Cài đặt").click();
  await expect(page.locator(".keys .key-row", { hasText: "AIza…1234" })).toBeVisible();
});
