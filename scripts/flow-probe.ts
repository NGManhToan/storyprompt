/**
 * Dò giao diện Flow thật (dùng khi phát triển): mở/nối Chrome hồ sơ .flow-profile,
 * in URL, tiêu đề và các phần tử chính; chụp màn hình vào flow-cache/probe-*.png.
 * Không in cookie hay token. Chạy: npx tsx scripts/flow-probe.ts [url]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlowBrowser } from "../src/server/flow/chrome.js";

const root = process.cwd();
const cache = join(root, "flow-cache");
mkdirSync(cache, { recursive: true });
const browser = new FlowBrowser({ profileDir: join(root, ".flow-profile") });
await browser.open(process.argv[2]);
const page = await browser.flowPage(process.argv[2]);
await page.waitForTimeout(4000);
const stamp = Date.now();
await page.screenshot({ path: join(cache, `probe-${stamp}.png`) });
const info = (await page.evaluate(`(() => {
  const pick = (sel) => [...document.querySelectorAll(sel)].slice(0, 30).map((el) => {
    const h = el;
    return { tag: el.tagName.toLowerCase(), cls: (h.className && typeof h.className === "string" ? h.className : "").slice(0, 80), text: (h.innerText || "").replace(/\\s+/g, " ").slice(0, 80), aria: el.getAttribute("aria-label") ?? "", icon: el.querySelector("mat-icon,i")?.textContent?.trim() ?? "" };
  });
  const customTags = [...new Set([...document.querySelectorAll("*")].map((el) => el.tagName.toLowerCase()).filter((t) => t.includes("-")))].slice(0, 120);
  return {
    url: location.href,
    title: document.title,
    customTags,
    buttons: pick("button"),
    editable: pick("[contenteditable='true'], textarea, input"),
    images: [...document.querySelectorAll("img[data-media-id], img")].slice(0, 20).map((img) => ({ media: img.getAttribute("data-media-id"), src: (img.getAttribute("src") || "").slice(0, 90), w: img.naturalWidth, alt: img.getAttribute("alt") })),
  };
})()`)) as { buttons: unknown[] } & Record<string, unknown>;
writeFileSync(join(cache, `probe-${stamp}.json`), JSON.stringify(info, null, 2));
console.log(JSON.stringify({ ...info, buttons: info.buttons.length, file: `flow-cache/probe-${stamp}.json` }, null, 2));
await browser.detach();
