import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./src/server/api.js";
import { loadEnvFiles } from "./src/server/env.js";

const root = fileURLToPath(new URL(".", import.meta.url));
loadEnvFiles(root);
const dist = join(root, "dist");
// `--production` thay cho `NODE_ENV=production` để `npm start` chạy được trên Windows PowerShell/cmd.
if (process.argv.includes("--production")) process.env.NODE_ENV = "production";
const production = process.env.NODE_ENV === "production";
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
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new Error("Payload quá lớn.");
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
    if (url.startsWith("/api")) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
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
      const response = await handleApi(request);
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
