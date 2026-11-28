import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./src/server/api.js";
import { fileUsage } from "./src/server/jobLanes.js";
import { JobManager } from "./src/server/jobs.js";
import { handleJobsApi, isJobsPath } from "./src/server/jobsApi.js";
import { loadEnvFiles } from "./src/server/env.js";
import { handleFlowApi, isFlowPath } from "./src/server/flow/api.js";
import { FlowBrowser } from "./src/server/flow/chrome.js";
import { PlaywrightFlowDriver } from "./src/server/flow/driver.js";
import { FlowImageManager } from "./src/server/flow/imageJobs.js";

const root = fileURLToPath(new URL(".", import.meta.url));
loadEnvFiles(root);
const dist = join(root, "dist");
// `--production` thay cho `NODE_ENV=production` để `npm start` chạy được trên Windows PowerShell/cmd.
if (process.argv.includes("--production")) process.env.NODE_ENV = "production";
const production = process.env.NODE_ENV === "production";
// Kết quả chạy nền lưu ở thư mục jobs/ (gitignored). Đổi chỗ bằng STORYPROMPT_JOBS_DIR.
const jobsDir = process.env.STORYPROMPT_JOBS_DIR || join(root, "jobs");
const jobs = new JobManager({ dir: jobsDir, usage: fileUsage(join(jobsDir, "usage.json")) });
// Job bị ngắt vì server khởi động lại và chỉ dùng khóa .env thì tự chạy tiếp.
for (const id of jobs.interruptedServerJobs()) {
  const resumed = jobs.resume(id, []);
  console.log(resumed.ok ? `[jobs] tự chạy tiếp ${id}` : `[jobs] không chạy tiếp được ${id}: ${resumed.error}`);
}
// Nút "Tạo ảnh": Chrome hồ sơ riêng .flow-profile/ (đăng nhập Google do bạn tự làm) + ảnh tạm ở flow-cache/ (cả hai gitignored).
const flowBrowser = new FlowBrowser({ profileDir: process.env.STORYPROMPT_FLOW_PROFILE || join(root, ".flow-profile"), port: Number(process.env.STORYPROMPT_FLOW_CDP_PORT) || 9333 });
const flowDriver = new PlaywrightFlowDriver(flowBrowser);
const flowImages = new FlowImageManager({ dir: process.env.STORYPROMPT_FLOW_CACHE || join(root, "flow-cache"), driver: flowDriver });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    jobs.flush();
    flowImages.flush();
    process.exit(0);
  });
}
const port = Number(process.env.PORT) || (production ? 8080 : 47222);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Payload quá lớn.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = normalize(decodeURIComponent(url.pathname));
  const relative = requested === "/" ? "index.html" : requested.replace(/^[/\\]+/, "");
  let file = join(dist, relative);
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("Chưa build. Chạy npm run build.");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? "/";
    if (url.startsWith("/api") && isFlowPath(url.split("?")[0])) {
      // Điều khiển tài khoản Google của bạn: chỉ nhận lệnh từ chính máy này, không từ máy khác trong wifi.
      const remote = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Tạo ảnh Flow chỉ dùng được trên chính máy chạy server." }));
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" ? undefined : await readBody(req, 4_000_000);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(", "));
      }
      const request = new Request(`http://${req.headers.host ?? "localhost"}${url}`, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined });
      const response = await handleFlowApi(request, flowImages, flowDriver);
      send(res, response);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (url.startsWith("/api")) {
      const body = req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" ? undefined : await readBody(req, isJobsPath(url.split("?")[0]) ? 12_000_000 : 2_000_000);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(", "));
      }
      const request = new Request(`http://${req.headers.host ?? "localhost"}${url}`, {
        method: req.method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
      });
      const response = isJobsPath(url.split("?")[0]) ? await handleJobsApi(request, jobs) : await handleApi(request);
      send(res, response);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (production) {
      await serveStatic(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("API dev đang chạy. Giao diện nằm ở cổng Vite.");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Lỗi server." }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`StoryPrompt API http://127.0.0.1:${port}`);
});
