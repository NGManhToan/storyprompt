import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "../src/server/env.js";
import { createGateway, generatePassword } from "../src/server/gateway.js";
import { randomBytes } from "node:crypto";

/**
 * Mở StoryPrompt ra link công khai https://….trycloudflare.com (Cloudflare Quick Tunnel, miễn phí, link ĐỔI mỗi lần chạy lại).
 *   npm run share        (hoặc nhấp đúp share.cmd)
 * Link hiện tại ghi ở public-link.txt. Mật khẩu nằm ở .env (STORYPROMPT_ACCESS_PASSWORD), script này KHÔNG in nó ra.
 * Không đụng tới server 47230 hay Chrome của Flow: chỉ thêm một cổng đăng nhập ở 127.0.0.1:47231.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const envPath = join(root, ".env");

function ensureSecrets() {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const has = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*\\S`, "m").test(text);
  let add = "";
  if (!has("STORYPROMPT_ACCESS_PASSWORD")) add += `STORYPROMPT_ACCESS_PASSWORD=${generatePassword(20)}\n`;
  if (!has("STORYPROMPT_SESSION_SECRET")) add += `STORYPROMPT_SESSION_SECRET=${randomBytes(32).toString("hex")}\n`;
  if (add) {
    const lead = text && !text.endsWith("\n") ? "\n" : "";
    appendFileSync(envPath, `${lead}# Link công khai (npm run share). Không chia sẻ, không commit.\n${add}`);
    console.log("[share] Đã tạo mật khẩu truy cập mới trong .env (STORYPROMPT_ACCESS_PASSWORD).");
  }
}

ensureSecrets();
loadEnvFiles(root);

const target = process.env.STORYPROMPT_TARGET || "http://127.0.0.1:47230";
const gatewayPort = Number(process.env.STORYPROMPT_GATEWAY_PORT) || 47231;
const linkFile = join(root, "public-link.txt");

const gateway = createGateway({ password: process.env.STORYPROMPT_ACCESS_PASSWORD as string, secret: process.env.STORYPROMPT_SESSION_SECRET as string, target });
gateway.listen(gatewayPort, "127.0.0.1", () => console.log(`[share] Cổng đăng nhập http://127.0.0.1:${gatewayPort} → ${target}`));

function cloudflaredPath(): string {
  const candidates = [process.env.CLOUDFLARED_PATH, "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? "cloudflared";
}

let child: ChildProcess | undefined;
let stopping = false;
let delay = 3000;
function startTunnel() {
  writeFileSync(linkFile, "(đang tạo link…)\n");
  child = spawn(cloudflaredPath(), ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${gatewayPort}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const onData = (chunk: Buffer) => {
    const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString("utf8"));
    if (found) {
      writeFileSync(linkFile, `${found[0]}\n`);
      console.log(`[share] Link công khai: ${found[0]}`);
      delay = 3000;
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (error) => console.error(`[share] Không chạy được cloudflared: ${error.message}. Cài bằng: winget install Cloudflare.cloudflared`));
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`[share] cloudflared dừng (mã ${code}). Chạy lại sau ${delay / 1000}s, link sẽ ĐỔI.`);
    setTimeout(startTunnel, delay);
    delay = Math.min(delay * 2, 60_000);
  });
}
startTunnel();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    child?.kill();
    gateway.close();
    writeFileSync(linkFile, "(link đã tắt)\n");
    process.exit(0);
  });
}
