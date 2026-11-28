import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { FLOW_MODELS, modelInfo } from "../../core/flowImages.js";
import { findChrome } from "./chrome.js";
import type { FlowDriver } from "./driver.js";
import type { FlowImageManager } from "./imageJobs.js";
import { buildZip } from "./zip.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function isFlowPath(path: string): boolean {
  return path === "/api/flow" || path.startsWith("/api/flow/");
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    const from = new URL(origin);
    return from.host === host || ["localhost", "127.0.0.1", "[::1]"].includes(from.hostname);
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/**
 * API của nút "Tạo ảnh". Server chỉ nhận lệnh từ chính máy này (kiểm ở server.ts),
 * vì nó điều khiển tài khoản Google của bạn.
 */
export async function handleFlowApi(request: Request, manager: FlowImageManager, driver: FlowDriver): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Origin không được phép." }, 403);
  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // api, flow, ...
  const method = request.method;
  const body = async () => ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  if (parts[2] === "status" && method === "GET") {
    const status = await driver.status();
    return json({
      chrome: Boolean(findChrome()),
      ...status,
      config: manager.config,
      quota: manager.quota(),
      models: FLOW_MODELS.map((item) => ({ id: item.id, label: item.label })),
      activeJob: manager.activeId(),
    });
  }
  if (parts[2] === "connect" && method === "POST") {
    try {
      await driver.open(manager.config.projectUrl || undefined);
      return json({ ok: true, status: await driver.status() });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Không mở được Chrome." }, 500);
    }
  }
  if (parts[2] === "config" && method === "POST") {
    const result = manager.setConfig((await body()) as never);
    return result.ok ? json({ ok: true, config: result.config }) : json({ error: result.error }, 400);
  }
  if (parts[2] === "use-current" && method === "POST") {
    const current = await driver.currentProjectUrl();
    if (!current) return json({ error: "Cửa sổ Chrome của Flow chưa mở project nào. Mở (hoặc tạo) một project trong đó trước." }, 400);
    const result = manager.setConfig({ projectUrl: current });
    return result.ok ? json({ ok: true, config: result.config }) : json({ error: result.error }, 400);
  }
  if (parts[2] === "check-refs" && method === "POST") {
    if (manager.activeId()) return json({ error: "Đang tạo ảnh, kiểm tra sau." }, 409);
    if (!manager.config.projectUrl) return json({ error: "Chưa chọn project Flow." }, 400);
    const input = await body();
    const names = Array.isArray(input.names) ? input.names.filter((name): name is string => typeof name === "string").slice(0, 12) : [];
    try {
      return json({ ok: true, found: await driver.checkReferences(manager.config.projectUrl, names) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Không kiểm tra được." }, 500);
    }
  }

  if (parts[2] === "img" && method === "GET") {
    const path = manager.imagePath(parts[3] ?? "", parts[4] ?? "");
    if (!path) return json({ error: "Không có ảnh." }, 404);
    const headers: Record<string, string> = { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" };
    if (url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="${parts[4]}"`;
    return new Response(readFileSync(path), { status: 200, headers });
  }

  if (parts[2] !== "jobs") return json({ error: "Không có route." }, 404);
  const id = parts[3];
  if (!id) {
    if (method === "GET") return json({ jobs: manager.list(), quota: manager.quota() });
    if (method === "POST") {
      const made = manager.create(await body());
      return made.ok ? json({ id: made.id }, 202) : json({ error: made.error }, 400);
    }
    return json({ error: "Method không hỗ trợ." }, 405);
  }
  const job = manager.get(id);
  if (!job) return json({ error: "Không tìm thấy job ảnh." }, 404);
  const action = parts[4];
  if (!action) {
    if (method === "GET") {
      const rev = Number(url.searchParams.get("rev"));
      const summary = manager.summary(job);
      if (Number.isFinite(rev) && rev === job.rev) return json({ unchanged: true, summary, quota: manager.quota() });
      return json({ summary, quota: manager.quota(), job: { ...job, modelLabel: modelInfo(job.model).menu } });
    }
    if (method === "DELETE") return manager.remove(id) ? json({ ok: true }) : json({ error: "Job đang chạy, hãy dừng trước." }, 409);
    return json({ error: "Method không hỗ trợ." }, 405);
  }
  if (action === "cancel" && method === "POST") return json({ ok: manager.cancel(id) });
  if (action === "resume" && method === "POST") {
    const input = await body();
    const result = manager.resume(id, { retryFailed: input.retryFailed === true });
    return result.ok ? json({ ok: true }, 202) : json({ error: result.error }, 400);
  }
  if (action === "scenes" && parts[5] && method === "POST") {
    const input = await body();
    if (parts[6] === "regen") {
      const result = manager.regenerate(id, parts[5], typeof input.prompt === "string" ? input.prompt : undefined, Array.isArray(input.references) ? (input.references as string[]) : undefined);
      return result.ok ? json({ ok: true }, 202) : json({ error: result.error }, 400);
    }
    if (parts[6] === "skip") return json({ ok: manager.skip(id, parts[5]) });
  }
  if (action === "zip" && method === "GET") {
    const entries = job.scenes.flatMap((scene) =>
      scene.images.flatMap((image, index) => {
        const path = manager.imagePath(id, image.file);
        if (!path) return [];
        const ext = extname(image.file);
        const name = `scene-${scene.sceneId}${scene.images.length > 1 ? `-${index + 1}` : ""}${ext}`;
        return [{ name, data: readFileSync(path), date: new Date(image.createdAt) }];
      }),
    );
    if (!entries.length) return json({ error: "Chưa có ảnh nào." }, 404);
    const zip = buildZip(entries);
    const filename = `${job.label.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 60) || "flow"}-anh.zip`;
    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "cache-control": "no-store" },
    });
  }
  return json({ error: "Không có route." }, 404);
}
