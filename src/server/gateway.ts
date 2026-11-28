import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Cổng đăng nhập đặt TRƯỚC server StoryPrompt (cổng 47230) để mở app ra Internet qua Cloudflare Tunnel.
 * - Mọi đường dẫn (kể cả /api/flow) đều phải có cookie phiên hợp lệ, trừ trang đăng nhập.
 * - Chỉ lắng nghe 127.0.0.1: chỉ cloudflared (hoặc chính máy này) nối vào được.
 * - Không bao giờ ghi mật khẩu, cookie hay khóa ra log.
 */
export interface GatewayOptions {
  password: string;
  secret: string;
  /** Server StoryPrompt phía sau, ví dụ http://127.0.0.1:47230 */
  target: string;
  /** Số lần sai tối đa của một địa chỉ trong cửa sổ. */
  maxFailures?: number;
  /** Tổng số lần sai tối đa của mọi địa chỉ trong cửa sổ (chặn dò mật khẩu bằng nhiều IP). */
  maxGlobalFailures?: number;
  windowMs?: number;
  sessionMs?: number;
  /** Độ trễ cố định sau mỗi lần sai. */
  failDelayMs?: number;
  now?: () => number;
}

export const COOKIE_NAME = "sp_session";
const MAX_BODY = 25_000_000;
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

const sha = (value: string) => createHash("sha256").update(value).digest();

export function loginPage(error = "", next = "/"): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>StoryPrompt – Đăng nhập</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f6f1;color:#171b17;font:16px/1.5 system-ui,Arial,sans-serif;padding:16px}
form{background:#fcfaf6;border:1px solid #eae7df;border-radius:16px;padding:24px;width:100%;max-width:380px;box-shadow:0 3px 10px #403b2915}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#777b72;font-size:14px}
input{width:100%;font:inherit;padding:14px;border:1px solid #d8d5cb;border-radius:12px;background:#fff;margin-bottom:12px}
button{width:100%;font:inherit;font-weight:600;padding:14px;border:0;border-radius:12px;background:#527b40;color:#fff;cursor:pointer;min-height:48px}
.err{background:#fdecea;color:#8a1f17;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:14px}</style></head>
<body><form method="post" action="/__login"><h1>StoryPrompt</h1><p>Nhập mật khẩu để vào.</p>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<input type="password" name="password" autocomplete="current-password" placeholder="Mật khẩu" required autofocus><input type="hidden" name="next" value="${esc(next)}"><button type="submit">Đăng nhập</button></form></body></html>`;
}

export function createGateway(options: GatewayOptions): Server & { stats: () => { failures: number } } {
  if (options.password.length < 12) throw new Error("Mật khẩu truy cập phải dài ít nhất 12 ký tự.");
  if (options.secret.length < 16) throw new Error("Khóa phiên phải dài ít nhất 16 ký tự.");
  const now = options.now ?? Date.now;
  const maxFailures = options.maxFailures ?? 5;
  const maxGlobal = options.maxGlobalFailures ?? 20;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const sessionMs = options.sessionMs ?? 30 * 24 * 3600_000;
  const failDelay = options.failDelayMs ?? 400;
  const target = new URL(options.target);
  const passwordHash = sha(options.password);
  // Đổi mật khẩu hoặc khóa thì mọi phiên cũ hết hiệu lực.
  const signKey = createHmac("sha256", options.secret).update(options.password).digest();
  const failures = new Map<string, number[]>();
  let globalFailures: number[] = [];

  const sign = (exp: string) => createHmac("sha256", signKey).update(exp).digest("base64url");
  const makeCookie = () => {
    const exp = String(now() + sessionMs);
    return `${exp}.${sign(exp)}`;
  };
  const validCookie = (value: string | undefined): boolean => {
    if (!value) return false;
    const dot = value.indexOf(".");
    if (dot < 1) return false;
    const exp = value.slice(0, dot);
    if (!/^\d{10,16}$/.test(exp) || Number(exp) < now()) return false;
    const a = Buffer.from(value.slice(dot + 1));
    const b = Buffer.from(sign(exp));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cookieOf = (req: IncomingMessage): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
    }
    return undefined;
  };
  // Cloudflare có thể đổi địa chỉ IPv6 của cùng một người giữa các request, nên gom IPv6 theo /48 để khoá không bị né dễ dàng.
  // Chốt chặn thật sự là giới hạn chung maxGlobalFailures.
  const clientOf = (req: IncomingMessage) => {
    const header = req.headers["cf-connecting-ip"];
    const ip = (typeof header === "string" && header) || req.socket.remoteAddress || "unknown";
    return ip.includes(":") ? ip.split(":").slice(0, 3).join(":") : ip;
  };
  const isHttps = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https" || String(req.headers["cf-visitor"] ?? "").includes("https");
  const prune = (list: number[]) => list.filter((t) => t > now() - windowMs);
  const blockedFor = (client: string): number => {
    const own = prune(failures.get(client) ?? []);
    failures.set(client, own);
    globalFailures = prune(globalFailures);
    if (own.length >= maxFailures) return own[0] + windowMs - now();
    if (globalFailures.length >= maxGlobal) return globalFailures[0] + windowMs - now();
    return 0;
  };
  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return !origin;
    try {
      return new URL(origin).host === (req.headers["x-forwarded-host"] ?? req.headers.host);
    } catch {
      return false;
    }
  };
  const baseHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin" };
  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...baseHeaders, "content-type": "application/json; charset=utf-8", ...extra });
    res.end(JSON.stringify(body));
  };
  const html = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...baseHeaders, "content-type": "text/html; charset=utf-8", ...extra });
    res.end(body);
  };
  const readSmall = async (req: IncomingMessage, limit = 4096): Promise<string> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error("too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const safeNext = (value: unknown) => (typeof value === "string" && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) && !value.startsWith("/__") ? value : "/");
  const setCookie = (req: IncomingMessage, value: string, maxAgeS: number) =>
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isHttps(req) ? "; Secure" : ""}`;

  async function login(req: IncomingMessage, res: ServerResponse) {
    const client = clientOf(req);
    const wait = blockedFor(client);
    if (wait > 0) return html(res, 429, loginPage(`Sai quá nhiều lần. Thử lại sau ${Math.ceil(wait / 60000)} phút.`), { "retry-after": String(Math.ceil(wait / 1000)) });
    if (!sameOrigin(req)) return html(res, 403, loginPage("Yêu cầu không hợp lệ."));
    let password = "";
    let next = "/";
    try {
      const raw = await readSmall(req);
      if ((req.headers["content-type"] ?? "").includes("json")) {
        const data = JSON.parse(raw) as { password?: unknown; next?: unknown };
        password = typeof data.password === "string" ? data.password : "";
        next = safeNext(data.next);
      } else {
        const form = new URLSearchParams(raw);
        password = form.get("password") ?? "";
        next = safeNext(form.get("next"));
      }
    } catch {
      return html(res, 400, loginPage("Yêu cầu không hợp lệ."));
    }
    if (timingSafeEqual(sha(password), passwordHash)) {
      failures.delete(client);
      const wantsJson = (req.headers["content-type"] ?? "").includes("json");
      const headers = { "set-cookie": setCookie(req, makeCookie(), Math.floor(sessionMs / 1000)) };
      if (wantsJson) return json(res, 200, { ok: true }, headers);
      res.writeHead(303, { ...baseHeaders, location: next, ...headers });
      return res.end();
    }
    failures.set(client, [...prune(failures.get(client) ?? []), now()]);
    globalFailures.push(now());
    await new Promise((r) => setTimeout(r, failDelay));
    const left = blockedFor(client);
    if ((req.headers["content-type"] ?? "").includes("json")) return json(res, left > 0 ? 429 : 401, { error: left > 0 ? "Sai quá nhiều lần." : "Sai mật khẩu." });
    return html(res, left > 0 ? 429 : 401, loginPage(left > 0 ? `Sai quá nhiều lần. Thử lại sau ${Math.ceil(left / 60000)} phút.` : "Sai mật khẩu.", next));
  }

  function proxy(req: IncomingMessage, res: ServerResponse) {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP.has(key) || key === "cookie" || key.startsWith("cf-") || key.startsWith("x-forwarded")) continue;
      headers[key] = value;
    }
    // Giữ lại các cookie khác nếu có, bỏ riêng cookie phiên để backend không bao giờ thấy.
    const rest = (req.headers.cookie ?? "").split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith(`${COOKIE_NAME}=`));
    if (rest.length) headers.cookie = rest.join("; ");
    // Giữ nguyên Host gốc: server phía sau so Origin với Host để chặn trang lạ gọi API.
    headers.host = req.headers.host ?? target.host;
    let size = 0;
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(up.headers)) if (value !== undefined && !HOP.has(key)) out[key] = value;
      out["x-content-type-options"] = "nosniff";
      out["x-frame-options"] = "DENY";
      out["referrer-policy"] = "same-origin";
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) json(res, 502, { error: "Server StoryPrompt (cổng 47230) chưa chạy." });
      else res.destroy();
    });
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        upstream.destroy();
        if (!res.headersSent) json(res, 413, { error: "Payload quá lớn." });
      }
    });
    req.pipe(upstream);
    res.on("close", () => upstream.destroy());
  }

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/__login" && req.method === "POST") return await login(req, res);
      if (path === "/__logout" && req.method === "POST") {
        if (!sameOrigin(req)) return json(res, 403, { error: "Yêu cầu không hợp lệ." });
        res.writeHead(303, { ...baseHeaders, location: "/", "set-cookie": setCookie(req, "", 0) });
        return res.end();
      }
      if (!validCookie(cookieOf(req))) {
        if (path.startsWith("/api")) return json(res, 401, { error: "Chưa đăng nhập." });
        const wantsPage = req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
        if (!wantsPage) return json(res, 401, { error: "Chưa đăng nhập." });
        return html(res, 401, loginPage("", safeNext(req.url)));
      }
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json(res, 403, { error: "Yêu cầu không hợp lệ." });
      proxy(req, res);
    } catch {
      if (!res.headersSent) json(res, 500, { error: "Lỗi cổng." });
      else res.destroy();
    }
  });
  return Object.assign(server, { stats: () => ({ failures: globalFailures.length }) });
}

export function generatePassword(length = 20): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // 31 ký tự, bỏ ký tự dễ nhầm
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) if (bytes[i] < 248) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
