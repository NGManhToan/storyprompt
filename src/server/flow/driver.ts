import type { Locator, Page } from "playwright-core";
import { classifyFlowError, matchRefTitle, modelInfo, splitMentions, type FlowErrorKind, type FlowModel } from "../../core/flowImages.js";
import { FLOW_HOME, type FlowBrowser } from "./chrome.js";

/**
 * Điều khiển giao diện web Google Flow (flow.google.com, Angular Material) như người dùng:
 * dán prompt, gắn @Tên bằng ô chọn của Flow, bấm tạo, chờ ảnh, lấy ảnh về.
 * Không gọi API nội bộ của Flow, không né reCAPTCHA, không giả dạng.
 *
 * Bộ chọn (selector) lấy từ ghi chép đo đạc của gflow-cli (MIT, github.com/ffroliva/gflow-cli,
 * tháng 9–11/2026); đã đối chiếu trên giao diện thật (tiếng Việt) ngày 28/11/2026 — các bộ chọn
 * và ligature không phụ thuộc ngôn ngữ. Flow đổi DOM thường xuyên.
 */
export const SEL = {
  composer: "[contenteditable='true']",
  settingsTrigger: ".settings-trigger-button",
  overlay: ".cdk-overlay-pane",
  radiogroup: "[role='radiogroup']",
  radio: "[role='radio']",
  menuItem: "[role='menuitem']",
  agentPressed: "button.agent-mode-chip[aria-pressed='true'], flow-agent-mode-switch button.switch[aria-pressed='true']",
  pickerOption: "button.asset-item",
  pickerTitle: ".asset-title",
  mentionChip: ".mention-chip",
  addMenu: "button.add-menu-trigger",
  imageTile: "flow-image-tile",
  pendingTile: "flow-pending-tile",
  alerts: "mat-snack-bar-container, .mat-mdc-snack-bar-container, .mdc-snackbar, [role='alert']",
  cookieReject: "button.glue-cookie-notification-bar__reject",
  promoClose: "flow-g1-promo-dialog button.close-button",
};

/** Hình (ligature Material Symbols) của các nút — không phụ thuộc ngôn ngữ giao diện. */
const LIG = { image: "image", submit: "arrow_forward", dropdown: "arrow_drop_down", upload: "upload" };

export const SIGN_IN_MESSAGE = "Chưa đăng nhập Google Flow (hoặc đã bị đăng xuất). Bấm \"Đăng nhập Google Flow\" trong bảng Tạo ảnh: một cửa sổ Chrome sẽ hiện ra để bạn đăng nhập (chỉ cần một lần), rồi bấm \"Chạy tiếp\".";
const ASPECT_LIG: Record<string, string> = {
  "16:9": "crop_16_9",
  "9:16": "crop_9_16",
  "1:1": "crop_square",
  "4:3": "crop_landscape",
  "3:4": "crop_portrait",
};

export class FlowError extends Error {
  constructor(
    readonly kind: FlowErrorKind | "ui" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

export type GenerateRequest = { prompt: string; references: string[]; model: FlowModel; aspect: string; projectUrl: string };
export type GeneratedImage = { data: Buffer; mime: string; width?: number; height?: number; mediaId?: string; source?: string };

export type FlowStatus = { browserOpen: boolean; signedIn: boolean | null; url?: string; inProject?: boolean; window?: "headless" | "offscreen" | "visible" | null };

export interface FlowDriver {
  status(): Promise<FlowStatus>;
  /** Mở Chrome CÓ cửa sổ để bạn đăng nhập Google (chỉ cần một lần). */
  open(url?: string): Promise<void>;
  currentProjectUrl(): Promise<string | null>;
  /**
   * Trước khi tạo ảnh: tự mở Chrome ẩn (cùng hồ sơ đã đăng nhập), kiểm tra đăng nhập,
   * và trả về project dùng được (project đã nhớ → project đang mở → project mới nhất → tạo mới).
   */
  prepare(projectUrl?: string): Promise<string>;
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<GeneratedImage[]>;
  checkReferences(projectUrl: string, names: string[]): Promise<Record<string, boolean>>;
  /** Tải một ảnh nhân vật từ máy lên project (tên tệp = tên nhân vật, vd. Derek.jpg). */
  uploadReference(projectUrl: string, file: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chạy đoạn JS trong trang (dạng chuỗi để trình biên dịch không chèn helper lạ). */
async function js<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return (await page.evaluate(`(${fn})(${JSON.stringify(arg ?? null)})`)) as T;
}

function lig(page: Page, name: string) {
  return page.locator("mat-icon").filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });
}

const TILES_JS = `(sel) => [...document.querySelectorAll(sel.tile)].map((t) => {
  const img = t.querySelector('img');
  return {
    id: img ? (img.getAttribute('data-media-id') || '') : '',
    src: img ? (img.currentSrc || img.src || '') : '',
    w: img ? img.naturalWidth : 0,
    h: img ? img.naturalHeight : 0,
    pending: !!t.querySelector(sel.pending),
    text: (t.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
  };
})`;

type Tile = { id: string; src: string; w: number; h: number; pending: boolean; text: string };

const ALERTS_JS = `(sel) => [...document.querySelectorAll(sel)].map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)`;

/** URL ảnh gốc: /asb/<id>=s512-rw là ảnh xem trước; "=s0" là kích thước gốc (theo gflow-cli). */
export function fullSizeSrc(src: string): string {
  if (/^https:\/\/flow-content\.google\/image\//.test(src)) return src;
  const at = src.lastIndexOf("=");
  if (at > 0 && src.includes("/asb/") && !src.includes("?") && /^[A-Za-z0-9-]+$/.test(src.slice(at + 1))) return `${src.slice(0, at)}=s0`;
  return src;
}

/**
 * Ô mới = các ô đứng TRƯỚC ô cũ đầu tiên (Flow xếp mới nhất lên đầu).
 * Lưới ảo của Flow chỉ vẽ một phần; khi thêm ảnh, ô cũ chưa từng vẽ có thể hiện ra ở cuối —
 * không được coi đó là ảnh mới (lỗi đo ngày 28/11/2026: cảnh 001 bị lấy kèm một ảnh cũ).
 */
export function newestTiles<T extends { id: string; src: string }>(tiles: T[], before: Set<string>): T[] {
  if (!before.size) return tiles;
  const firstOld = tiles.findIndex((tile) => before.has(tile.id || tile.src));
  if (firstOld < 0) return [];
  return tiles.slice(0, firstOld).filter((tile) => !before.has(tile.id || tile.src));
}

export class PlaywrightFlowDriver implements FlowDriver {
  private settingsKey = "";
  private settingsUrl = "";

  constructor(private readonly browser: FlowBrowser) {}

  async status(): Promise<FlowStatus> {
    if (!(await this.browser.reachable())) return { browserOpen: false, signedIn: null };
    try {
      const context = await this.browser.context();
      const page = context.pages().find((item) => /flow\.google\.com|labs\.google/.test(item.url()));
      if (!page) return { browserOpen: true, signedIn: null };
      const url = page.url();
      const signedIn = await this.signedIn(page);
      return { browserOpen: true, signedIn, url, inProject: /\/project\//.test(url), window: await this.browser.runningMode() };
    } catch {
      return { browserOpen: true, signedIn: null };
    }
  }

  private async signedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/accounts\.google\.com/.test(url) || /flow\.google\.com\/about/.test(url)) return false;
    // Trang dự án hoặc danh sách dự án chỉ hiện khi đã đăng nhập.
    return js<boolean>(page, `() => !!document.querySelector('flow-projects-page, flow-prompt-box, ${SEL.composer.replace(/'/g, "\\'")}')`);
  }

  async open(url?: string) {
    await this.browser.open(url ?? FLOW_HOME);
    await this.browser.flowPage(url);
    this.settingsKey = "";
  }

  async prepare(projectUrl?: string): Promise<string> {
    const running = await this.browser.runningMode();
    if (running === "visible") {
      // Cửa sổ đăng nhập đang mở: chỉ chuyển sang chạy ẩn khi đã đăng nhập xong.
      const page = await this.browser.flowPage(projectUrl || undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      if (!(await this.signedIn(page))) throw new FlowError("auth", SIGN_IN_MESSAGE);
    }
    await this.browser.ensureHidden(projectUrl || FLOW_HOME);
    this.settingsKey = "";
    const page = await this.browser.flowPage(projectUrl || undefined);
    await this.waitSignedIn(page);
    if (projectUrl) return projectUrl;
    const current = await this.currentProjectUrl();
    if (current) return current;
    if (!/flow\.google\.com\/?(\?|$)/.test(page.url())) await page.goto(FLOW_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator("flow-projects-page").first().waitFor({ state: "attached", timeout: 30_000 }).catch(() => undefined);
    await sleep(2500);
    const latest = await js<string>(page, `() => { const a = document.querySelector('flow-project-card a[href*="/project/"]'); return a ? a.href : ''; }`);
    if (latest) return latest.split(/[?#]/)[0];
    // Chưa có project nào: tạo mới bằng nút "Dự án mới".
    const add = page.locator("button.new-project-button").first();
    await add.click({ timeout: 8000 }).catch(() => {
      throw new FlowError("ui", "Không tìm thấy nút tạo project mới trong Flow.");
    });
    await page.waitForURL(/\/project\/[0-9a-f-]{20,}/i, { timeout: 30_000 }).catch(() => undefined);
    const made = await this.currentProjectUrl();
    if (!made) throw new FlowError("ui", "Không tạo được project mới trong Flow.");
    return made;
  }

  /** Trang Flow có thể chuyển hướng vài giây sau khi mở: chờ tới khi biết chắc đã/chưa đăng nhập. */
  private async waitSignedIn(page: Page) {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const url = page.url();
      if (/accounts\.google\.com|flow\.google\.com\/about/.test(url)) throw new FlowError("auth", SIGN_IN_MESSAGE);
      if (await this.signedIn(page).catch(() => false)) return;
      await sleep(1000);
    }
    throw new FlowError("auth", SIGN_IN_MESSAGE);
  }

  async uploadReference(projectUrl: string, file: string): Promise<void> {
    const page = await this.page(projectUrl);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.locator(SEL.addMenu).first().click({ timeout: 8000 });
    await sleep(1500);
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    // Mục "Tải nội dung nghe nhìn lên" có ligature "upload" (không phụ thuộc ngôn ngữ).
    const item = page.locator(`${SEL.overlay} mat-icon`).filter({ hasText: new RegExp(`^\\s*${LIG.upload}\\s*$`) }).first();
    try {
      await item.click({ timeout: 6000 });
      await (await chooser).setFiles(file);
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new FlowError("ui", "Không mở được mục tải ảnh lên của Flow.");
    }
    await sleep(6000);
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await sleep(300);
    }
  }

  async currentProjectUrl(): Promise<string | null> {
    if (!(await this.browser.reachable())) return null;
    const context = await this.browser.context();
    const page = context.pages().find((item) => /\/project\/[0-9a-f-]{20,}/i.test(item.url()));
    return page ? page.url().split(/[?#]/)[0] : null;
  }

  private async page(projectUrl: string): Promise<Page> {
    // Chrome bị tắt giữa chừng: tự mở lại ở chế độ ẩn với cùng hồ sơ.
    if (!(await this.browser.reachable())) {
      await this.browser.ensureHidden(projectUrl);
      this.settingsKey = "";
    }
    const page = await this.browser.flowPage(projectUrl);
    if (!page.url().startsWith(projectUrl)) {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      this.settingsKey = "";
    }
    if (page.url() !== this.settingsUrl) this.settingsKey = "";
    if (/accounts\.google\.com|flow\.google\.com\/about/.test(page.url())) throw new FlowError("auth", SIGN_IN_MESSAGE);
    await this.dismissNoise(page);
    const composer = page.locator(SEL.composer).first();
    try {
      await composer.waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      if (await page.locator(SEL.agentPressed).count()) {
        await page.locator(SEL.agentPressed).first().click({ timeout: 4000 }).catch(() => undefined);
        await composer.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
      }
      if (!(await composer.isVisible().catch(() => false))) throw new FlowError("ui", "Không thấy ô nhập prompt của Flow (giao diện có thể đã đổi).");
    }
    // Chế độ Agent ẩn bảng cài đặt; tắt đi để dùng ô prompt thường (chỉ bấm khi đang bật).
    if (await page.locator(SEL.agentPressed).count()) {
      await page.locator(SEL.agentPressed).first().click({ timeout: 4000 }).catch(() => undefined);
      await sleep(800);
    }
    return page;
  }

  private async dismissNoise(page: Page) {
    for (const selector of [SEL.cookieReject, SEL.promoClose]) {
      const item = page.locator(selector).first();
      if (await item.isVisible().catch(() => false)) await item.click({ timeout: 3000 }).catch(() => undefined);
    }
  }

  /** Chọn Ảnh + mô hình + tỷ lệ + x1 trong bảng cài đặt của ô prompt, đọc lại aria-checked. */
  private async applySettings(page: Page, model: FlowModel, aspect: string) {
    const key = `${model}|${aspect}`;
    if (this.settingsKey === key && this.settingsUrl === page.url()) return;
    const trigger = page.locator(SEL.settingsTrigger).first();
    try {
      await trigger.waitFor({ state: "visible", timeout: 8000 });
    } catch {
      throw new FlowError("ui", "Không thấy nút cài đặt của ô prompt Flow (giao diện có thể đã đổi hoặc đang bật Agent).");
    }
    await trigger.click({ timeout: 5000 });
    const pane = page.locator(SEL.overlay).filter({ has: page.locator(SEL.radiogroup) }).last();
    try {
      await pane.locator(SEL.radiogroup).first().waitFor({ state: "visible", timeout: 8000 });
      await this.pickRadio(page, pane.locator(SEL.radio).filter({ has: lig(page, LIG.image) }), "Ảnh");
      await this.pickModel(page, pane, model);
      const aspectLig = ASPECT_LIG[aspect] ?? ASPECT_LIG["16:9"];
      await this.pickRadio(page, pane.locator(SEL.radio).filter({ has: lig(page, aspectLig) }), `tỷ lệ ${aspect}`);
      await this.pickRadio(page, pane.locator(SEL.radio).filter({ hasText: /^\D*1\D*$/ }), "x1");
    } finally {
      for (let i = 0; i < 2; i++) {
        if (!(await page.locator(`${SEL.overlay}:visible`).filter({ has: page.locator(`${SEL.radiogroup}, ${SEL.menuItem}`) }).count())) break;
        await page.keyboard.press("Escape");
        await sleep(300);
      }
    }
    this.settingsKey = key;
    this.settingsUrl = page.url();
  }

  private async pickRadio(page: Page, matches: Locator, what: string) {
    const target = matches.first();
    if (!(await target.count())) throw new FlowError("ui", `Không thấy lựa chọn "${what}" trong cài đặt Flow.`);
    if ((await target.getAttribute("aria-checked")) === "true") return;
    await target.click({ timeout: 4000 });
    await sleep(250);
    if ((await matches.first().getAttribute("aria-checked")) !== "true") throw new FlowError("ui", `Bấm "${what}" nhưng Flow không nhận.`);
    void page;
  }

  private async pickModel(page: Page, pane: Locator, model: FlowModel) {
    const info = modelInfo(model);
    const matches = (text: string) => text.includes(info.menu) && !(info.exclude && text.includes(info.exclude));
    const button = pane.locator("button").filter({ has: lig(page, LIG.dropdown) }).first();
    try {
      await button.waitFor({ state: "visible", timeout: 4000 });
    } catch {
      throw new FlowError("ui", "Không thấy nút chọn mô hình ảnh trong cài đặt Flow.");
    }
    const current = ((await button.textContent()) ?? "").replace(LIG.dropdown, "").trim();
    if (matches(current)) return;
    await button.click({ timeout: 4000 });
    const items = page.locator(SEL.menuItem);
    await items.first().waitFor({ state: "visible", timeout: 5000 });
    const offered = (await items.allTextContents()).map((text) => text.trim());
    const hits = offered.map((text, index) => (matches(text) ? index : -1)).filter((index) => index >= 0);
    if (hits.length !== 1) {
      await page.keyboard.press("Escape");
      throw new FlowError("ui", `Không chọn được mô hình "${info.menu}" (Flow đang có: ${offered.join(", ") || "không đọc được"}).`);
    }
    await items.nth(hits[0]).click({ timeout: 4000 });
    await sleep(400);
  }

  private async clearComposer(page: Page) {
    await page.locator(SEL.composer).first().click({ timeout: 5000 });
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await sleep(400);
  }

  private async caretToEnd(page: Page) {
    await js(page, `(sel) => { const ce = document.querySelector(sel); if (!ce) return; ce.focus(); const r = document.createRange(); r.selectNodeContents(ce); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }`, SEL.composer);
  }

  private chipCount(page: Page) {
    return page.locator(SEL.mentionChip).count();
  }

  /** Gõ "@Tên" rồi chọn đúng ảnh có tên đó trong danh sách Flow gợi ý. */
  private async mention(page: Page, name: string) {
    const before = await this.chipCount(page);
    await this.caretToEnd(page);
    await page.keyboard.type("@", { delay: 120 });
    await sleep(2000);
    await page.keyboard.type(name, { delay: 90 });
    await sleep(2500);
    const titles = await js<string[]>(page, `(sel) => [...document.querySelectorAll(sel.option)].map((o) => ((o.querySelector(sel.title) || o).textContent || '').trim())`, { option: SEL.pickerOption, title: SEL.pickerTitle });
    const index = matchRefTitle(titles, name);
    if (index < 0) {
      await page.keyboard.press("Escape");
      throw new FlowError("missing-ref", `Project Flow không có ảnh tham chiếu tên "${name}"${titles.length ? ` (Flow gợi ý: ${titles.slice(0, 6).join(", ")})` : ""}.`);
    }
    for (let i = 0; i < index; i++) {
      await page.keyboard.press("ArrowDown");
      await sleep(i === index - 1 ? 3500 : 150);
    }
    await page.keyboard.press("Enter");
    await sleep(1800);
    if ((await this.chipCount(page)) <= before) throw new FlowError("ui", `Đã chọn "${name}" nhưng Flow không gắn ảnh tham chiếu vào prompt.`);
  }

  private async typePrompt(page: Page, prompt: string, references: string[]) {
    await this.clearComposer(page);
    for (const part of splitMentions(prompt.replace(/\s*\n+\s*/g, " "), references)) {
      if ("mention" in part) await this.mention(page, part.mention);
      else if (part.text) {
        await this.caretToEnd(page);
        await page.keyboard.insertText(part.text);
        await sleep(150);
      }
    }
  }

  private async submit(page: Page) {
    const button = page.locator("button").filter({ has: lig(page, LIG.submit) });
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const count = await button.count();
      for (let i = count - 1; i >= 0; i--) {
        const item = button.nth(i);
        if ((await item.isVisible().catch(() => false)) && (await item.isEnabled().catch(() => false))) {
          await item.click({ timeout: 4000 });
          return;
        }
      }
      await sleep(150);
    }
    throw new FlowError("ui", "Nút tạo (mũi tên) của Flow không bật lên sau khi dán prompt.");
  }

  /** Ảnh mới hiện ở đầu lưới; cuộn lên đầu để lưới ảo (cdk-virtual-scroll) không chèn ô cũ vào giữa. */
  private async scrollGridTop(page: Page) {
    await js(page, `() => { for (const el of document.querySelectorAll('cdk-virtual-scroll-viewport')) el.scrollTop = 0; }`).catch(() => undefined);
    await sleep(600);
  }

  private tiles(page: Page) {
    return js<Tile[]>(page, TILES_JS, { tile: SEL.imageTile, pending: SEL.pendingTile });
  }

  private async fetchImage(page: Page, src: string): Promise<GeneratedImage | null> {
    const urls = [...new Set([fullSizeSrc(src), src])].filter((url) => /^https:\/\//.test(url));
    for (const url of urls) {
      try {
        const response = await page.context().request.get(url, { timeout: 60_000 });
        const mime = response.headers()["content-type"] ?? "";
        if (response.ok() && mime.startsWith("image/")) return { data: Buffer.from(await response.body()), mime, source: url === src ? "tile" : "full" };
      } catch {
        /* thử cách sau */
      }
      try {
        const b64 = await js<{ mime: string; data: string } | null>(page, `async (url) => { const r = await fetch(url, { credentials: 'include' }); if (!r.ok) return null; const b = await r.blob(); const buf = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); return { mime: b.type, data: btoa(s) }; }`, url);
        if (b64?.mime.startsWith("image/")) return { data: Buffer.from(b64.data, "base64"), mime: b64.mime, source: url === src ? "tile" : "full" };
      } catch {
        /* thử URL sau */
      }
    }
    return null;
  }

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
    const page = await this.page(request.projectUrl);
    await this.applySettings(page, request.model, request.aspect);
    await this.scrollGridTop(page);
    const before = new Set((await this.tiles(page)).map((tile) => tile.id || tile.src).filter(Boolean));
    const alertsBefore = new Set(await js<string[]>(page, ALERTS_JS, SEL.alerts));
    await this.typePrompt(page, request.prompt, request.references);
    if (signal?.aborted) {
      await this.clearComposer(page).catch(() => undefined);
      throw new FlowError("unknown", "Đã dừng trước khi bấm tạo.");
    }
    await this.submit(page);
    const started = Date.now();
    let alertSeenAt = 0;
    let alertText = "";
    while (Date.now() - started < 180_000) {
      await sleep(2000);
      const fresh = newestTiles(await this.tiles(page), before);
      const ready = fresh.filter((tile) => !tile.pending && tile.src && tile.w > 0);
      if (ready.length && !fresh.some((tile) => tile.pending)) {
        const images: GeneratedImage[] = [];
        // Cài đặt luôn là x1: chỉ lấy ô mới nhất, không bao giờ lấy thêm ô cũ.
        for (const tile of ready.slice(0, 1)) {
          const image = await this.fetchImage(page, tile.src);
          if (image) images.push({ ...image, width: image.width ?? tile.w, height: image.height ?? tile.h, mediaId: tile.id || undefined });
        }
        if (images.length) return images;
        throw new FlowError("ui", "Flow đã tạo ảnh nhưng không tải được ảnh về.");
      }
      const alerts = (await js<string[]>(page, ALERTS_JS, SEL.alerts)).filter((text) => !alertsBefore.has(text));
      const failedTile = fresh.find((tile) => !tile.pending && !tile.src && tile.text);
      const message = alerts[0] || failedTile?.text || "";
      if (message) {
        if (!alertSeenAt) {
          alertSeenAt = Date.now();
          alertText = message;
        }
        const kind = classifyFlowError(message);
        // Lỗi đã biết thì dừng ngay; câu lạ thì chờ thêm 20 s xem ảnh có ra không.
        if (kind !== "unknown" || Date.now() - alertSeenAt > 20_000) throw new FlowError(kind, `Flow báo: ${alertText}`);
      }
      if (signal?.aborted && !fresh.length) throw new FlowError("unknown", "Đã dừng.");
    }
    throw new FlowError("timeout", "Quá 3 phút chưa thấy ảnh mới trong project Flow.");
  }

  async checkReferences(projectUrl: string, names: string[]): Promise<Record<string, boolean>> {
    const page = await this.page(projectUrl);
    const out: Record<string, boolean> = {};
    try {
      for (const name of names) {
        await this.clearComposer(page);
        await page.keyboard.type("@", { delay: 120 });
        await sleep(2000);
        await page.keyboard.type(name, { delay: 90 });
        await sleep(2500);
        const titles = await js<string[]>(page, `(sel) => [...document.querySelectorAll(sel.option)].map((o) => ((o.querySelector(sel.title) || o).textContent || '').trim())`, { option: SEL.pickerOption, title: SEL.pickerTitle });
        out[name] = matchRefTitle(titles, name) >= 0;
        await page.keyboard.press("Escape");
        await sleep(400);
      }
    } finally {
      await this.clearComposer(page).catch(() => undefined);
    }
    return out;
  }
}
