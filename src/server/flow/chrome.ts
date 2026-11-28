import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

/**
 * Chrome thật của máy (không phải Chromium của Playwright), chạy với một hồ sơ riêng
 * (.flow-profile/, gitignored). Server nối vào qua cổng gỡ lỗi chỉ nghe trên 127.0.0.1.
 *
 * Hai kiểu mở:
 * - "ẩn" (mặc định khi tạo ảnh): Chrome headless của chính Chrome (--headless=new), cùng hồ sơ
 *   đã đăng nhập, không có cửa sổ. Đã đo ngày 28/11/2026: Flow nhận đăng nhập, vẽ ảnh và tải lên bình thường.
 *   Đặt STORYPROMPT_FLOW_WINDOW=offscreen để dùng cửa sổ thường đặt ngoài màn hình, hoặc =visible để hiện hẳn.
 * - "hiện": chỉ khi bạn cần đăng nhập Google (một lần).
 * Không có plugin "ẩn danh", không giả dấu vân tay, không sửa user-agent: Google vẫn thấy
 * đây là trình duyệt được điều khiển (headless còn tự xưng "HeadlessChrome").
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

export type BrowserOptions = { profileDir: string; port?: number; hiddenMode?: HiddenMode };
export type HiddenMode = "headless" | "offscreen" | "visible";
export type LaunchMode = HiddenMode;

export function hiddenModeFromEnv(value = process.env.STORYPROMPT_FLOW_WINDOW): HiddenMode {
  return value === "offscreen" || value === "visible" ? value : "headless";
}

/** Tham số dòng lệnh Chrome cho từng kiểu mở (tách riêng để kiểm thử). */
export function chromeArgs(profileDir: string, port: number, mode: LaunchMode, url: string): string[] {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (mode === "headless") args.push("--headless=new", "--window-size=1600,1000");
  if (mode === "offscreen") {
    // Cửa sổ thường nhưng nằm ngoài màn hình; giữ trang chạy bình thường khi bị che.
    args.push("--window-position=-3000,-3000", "--window-size=1600,1000", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling");
  }
  args.push(url);
  return args;
}

export class FlowBrowser {
  readonly profileDir: string;
  readonly port: number;
  readonly hiddenMode: HiddenMode;
  private browser: Browser | null = null;
  private connecting: Promise<Browser> | null = null;

  constructor(options: BrowserOptions) {
    this.profileDir = options.profileDir;
    this.port = options.port ?? 9333;
    this.hiddenMode = options.hiddenMode ?? "headless";
  }

  private get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Chrome của hồ sơ Flow có đang chạy (cổng gỡ lỗi trả lời) không. */
  async reachable(): Promise<boolean> {
    return (await this.version()) !== null;
  }

  private async version(): Promise<{ "User-Agent"?: string } | null> {
    try {
      const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
      return response.ok ? ((await response.json()) as { "User-Agent"?: string }) : null;
    } catch {
      return null;
    }
  }

  /** Chrome đang chạy có cửa sổ người dùng thấy được không (headless/ngoài màn hình = không). */
  private launchedMode: LaunchMode | null = null;
  async runningMode(): Promise<LaunchMode | null> {
    const info = await this.version();
    if (!info) return null;
    if ((info["User-Agent"] ?? "").includes("HeadlessChrome")) return "headless";
    return this.launchedMode === "offscreen" ? "offscreen" : "visible";
  }

  /** Mở Chrome có cửa sổ (để bạn đăng nhập); đang chạy ẩn thì tắt rồi mở lại. */
  async open(url = FLOW_HOME): Promise<Browser> {
    return this.launch("visible", url);
  }

  /** Bảo đảm Chrome đang chạy ở kiểu ẩn (mặc định headless); đang hiện cửa sổ thì tắt rồi mở lại ẩn. */
  async ensureHidden(url = FLOW_HOME): Promise<Browser> {
    return this.launch(this.hiddenMode, url);
  }

  private async launch(mode: LaunchMode, url: string): Promise<Browser> {
    const current = await this.runningMode();
    if (current && current !== mode) await this.shutdown();
    if (!(await this.reachable())) {
      const exe = findChrome();
      if (!exe) throw new Error("Không tìm thấy Google Chrome trên máy. Cài Chrome hoặc đặt STORYPROMPT_CHROME.");
      mkdirSync(this.profileDir, { recursive: true });
      const child = spawn(exe, chromeArgs(this.profileDir, this.port, mode, url), { detached: true, stdio: "ignore" });
      child.unref();
      this.launchedMode = mode;
      const until = Date.now() + 25_000;
      while (!(await this.reachable())) {
        if (Date.now() > until) throw new Error("Chrome mở nhưng không nối được cổng gỡ lỗi.");
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    return this.connect();
  }

  /** Tắt hẳn Chrome của hồ sơ Flow (để đổi giữa ẩn/hiện; hồ sơ và đăng nhập vẫn giữ). */
  async shutdown() {
    try {
      const browser = await this.connect();
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close").catch(() => undefined);
    } catch {
      /* đã tắt */
    }
    this.browser = null;
    const until = Date.now() + 15_000;
    while ((await this.reachable()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 300));
    // Chờ Chrome nhả khoá hồ sơ.
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
    return page;
  }

  /** Chỉ ngắt kết nối Playwright; cửa sổ Chrome của bạn vẫn mở. */
  async detach() {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}
