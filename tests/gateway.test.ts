import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COOKIE_NAME, createGateway, generatePassword } from "../src/server/gateway.js";

const PASSWORD = "test-password-123456";
let backend: Server;
let gw: ReturnType<typeof createGateway>;
let base = "";
let seenCookie: string | undefined;

beforeAll(async () => {
  backend = createServer((req, res) => {
    seenCookie = req.headers.cookie;
    if (req.url?.startsWith("/echo")) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => res.end(Buffer.concat(chunks)));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, url: req.url, flowRemote: req.socket.remoteAddress, host: req.headers.host }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  gw = createGateway({ password: PASSWORD, secret: "s".repeat(32), target: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, failDelayMs: 0 });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
});
afterAll(() => {
  gw.close();
  backend.close();
});

async function login(password: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/__login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ password }) });
}

describe("gateway", () => {
  it("chặn mọi đường dẫn khi chưa đăng nhập, kể cả /api/flow", async () => {
    for (const path of ["/api/jobs", "/api/flow/status", "/api/flow/jobs/x", "/", "/assets/a.js"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(401);
      expect(await res.text()).not.toContain("flowRemote");
    }
    const page = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('name="password"');
  });

  it("cookie giả hoặc hết hạn bị từ chối", async () => {
    for (const cookie of [`${COOKIE_NAME}=abc`, `${COOKIE_NAME}=9999999999999.AAAA`, `${COOKIE_NAME}=1.AAAA`]) {
      expect((await fetch(`${base}/api/flow/status`, { headers: { cookie } })).status).toBe(401);
    }
  });

  it("đăng nhập đúng: cookie HttpOnly + Secure + SameSite, vào được API và không lộ cookie cho backend", async () => {
    const res = await login(PASSWORD, { "x-forwarded-proto": "https" });
    expect(res.status).toBe(303);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    const cookie = set.split(";")[0];
    const api = await fetch(`${base}/api/flow/status?x=1`, { headers: { cookie: `${cookie}; theme=dark` } });
    expect(api.status).toBe(200);
    const body = (await api.json()) as { url: string; host: string };
    expect(body.url).toBe("/api/flow/status?x=1");
    expect(body.host).toBe(new URL(base).host);
    expect(seenCookie).toBe("theme=dark");
    const post = await fetch(`${base}/echo`, { method: "POST", headers: { cookie }, body: "x".repeat(300_000) });
    expect((await post.text()).length).toBe(300_000);
  });

  it("POST từ origin khác bị chặn dù có cookie", async () => {
    const cookie = ((await login(PASSWORD)).headers.get("set-cookie") ?? "").split(";")[0];
    const res = await fetch(`${base}/echo`, { method: "POST", headers: { cookie, origin: "https://evil.example" }, body: "hi" });
    expect(res.status).toBe(403);
  });

  it("sai mật khẩu bị chặn và khoá sau 5 lần; khoá theo từng địa chỉ", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await login("sai-mat-khau", { "cf-connecting-ip": "203.0.113.9" })).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses.slice(4)).toEqual([429, 429, 429]);
    // Đúng mật khẩu cũng bị khoá trong lúc đang khoá.
    expect((await login(PASSWORD, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(429);
    // Địa chỉ khác không bị ảnh hưởng.
    expect((await login(PASSWORD, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(303);
  });

  it("đổi địa chỉ IPv6 liên tục vẫn bị khoá bởi giới hạn chung", async () => {
    const gw2 = createGateway({ password: PASSWORD, secret: "s".repeat(32), target: base, failDelayMs: 0, maxGlobalFailures: 8 });
    await new Promise<void>((r) => gw2.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(gw2.address() as AddressInfo).port}/__login`;
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await fetch(url, { method: "POST", headers: { "cf-connecting-ip": `2a09:bac1:${(0x7a00 + i).toString(16)}:10::1`, "content-type": "application/x-www-form-urlencoded" }, body: "password=sai" })).status);
    expect(codes.slice(0, 7).every((c) => c === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
    expect((await fetch(url, { method: "POST", headers: { "cf-connecting-ip": "2a09:bac1:9999:10::1", "content-type": "application/x-www-form-urlencoded" }, body: `password=${PASSWORD}` })).status).toBe(429);
    gw2.close();
  });

  it("trình duyệt thật: header Referrer-Policy cho phép gửi Origin cùng nguồn khi POST", async () => {
    const res = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("đăng xuất xoá cookie", async () => {
    const res = await fetch(`${base}/__logout`, { method: "POST", redirect: "manual" });
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("tạo mật khẩu mạnh và từ chối mật khẩu yếu", () => {
    expect(generatePassword(20)).toMatch(/^[a-z2-9]{20}$/);
    expect(generatePassword()).not.toBe(generatePassword());
    expect(() => createGateway({ password: "short", secret: "s".repeat(32), target: "http://127.0.0.1:1" })).toThrow();
  });
});
