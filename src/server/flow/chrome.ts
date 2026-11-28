import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

/**
 * Chrome thật của máy (không phải Chromium của Playwright), chạy với một hồ sơ riêng
 * (.flow-profile/, gitignored) để bạn tự đăng nhập Google trong cửa sổ đó.
 * Server nối vào qua cổng gỡ lỗi chỉ nghe trên 127.0.0.1. Không có plugin "ẩn danh",
 * không giả dấu vân tay: Google vẫn thấy đây là trình duyệt được điều khiển.
 */
export const FLOW_HOME = "https://flow.google.com/";

export function findChrome(): string | null {
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    process.env.STORYPROMPT_CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    local ? join(local, "Google/Chrome/Application/chrome.exe") : "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const item of candidates) if (item && existsSync(item)) return item;
  return null;
}

export type BrowserOptions = { profileDir: string; port?: number };

export class FlowBrowser {
  readonly profileDir: string;
  readonly port: number;
  private browser: Browser | null = null;
  private connecting: Promise<Browser> | null = null;

  constructor(options: BrowserOptions) {
    this.profileDir = options.profileDir;
    this.port = options.port ?? 9333;
  }

  private get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Cửa sổ Chrome của hồ sơ Flow có đang mở (cổng gỡ lỗi trả lời) không. */
  async reachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Mở Chrome (nếu chưa mở) với hồ sơ riêng, có cửa sổ, rồi nối vào. */
  async open(url = FLOW_HOME): Promise<Browser> {
    if (!(await this.reachable())) {
      const exe = findChrome();
      if (!exe) throw new Error("Không tìm thấy Google Chrome trên máy. Cài Chrome hoặc đặt STORYPROMPT_CHROME.");
      mkdirSync(this.profileDir, { recursive: true });
      const child = spawn(
        exe,
        [
          `--user-data-dir=${this.profileDir}`,
          `--remote-debugging-port=${this.port}`,
          "--remote-debugging-address=127.0.0.1",
          "--no-first-run",
          "--no-default-browser-check",
          url,
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      const until = Date.now() + 20_000;
      while (!(await this.reachable())) {
        if (Date.now() > until) throw new Error("Chrome mở nhưng không nối được cổng gỡ lỗi.");
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    return this.connect();
  }

  async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.connectOverCDP(this.endpoint, { timeout: 15_000 });
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = null;
      });
      this.browser = browser;
      return browser;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async context(): Promise<BrowserContext> {
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome không có ngữ cảnh mặc định.");
    return context;
  }

  /** Tab Flow đang mở; không có thì mở tab mới ở `url`. */
  async flowPage(url?: string): Promise<Page> {
    const context = await this.context();
    const pages = context.pages();
    let page = pages.find((item) => /^https:\/\/(flow\.google\.com|labs\.google)\//.test(item.url()));
    if (!page) {
      page = await context.newPage();
      await page.goto(url ?? FLOW_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } else if (url && !page.url().startsWith(url)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await page.bringToFront().catch(() => undefined);
    return page;
  }

  /** Chỉ ngắt kết nối Playwright; cửa sổ Chrome của bạn vẫn mở. */
  async detach() {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}
