import { EXPORT_KINDS, type ExportKind } from "../core/exportKinds.js";
import { toSummary, type JobManager, type JobSpec } from "./jobs.js";

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/** Chặn trang web lạ gọi API job (có thể dùng khóa .env hoặc đọc kết quả): chỉ cho cùng origin hoặc không có Origin (curl, test). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    const from = new URL(origin);
    // Vite dev proxy đổi Host nên cho phép thêm trang chạy trên localhost.
    return from.host === host || ["localhost", "127.0.0.1", "[::1]"].includes(from.hostname);
  } catch {
    return false;
  }
}

export function isJobsPath(path: string): boolean {
  return path === "/api/jobs" || path.startsWith("/api/jobs/");
}

/** Giữ kết quả chạy nền: tạo job, theo dõi, chạy tiếp, dừng, xuất. Không bao giờ trả khóa API. */
export async function handleJobsApi(request: Request, manager: JobManager): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api","jobs",id?,action?]
  if (!sameOrigin(request)) return json({ error: "Origin không được phép." }, 403);
  const id = parts[2];
  const action = parts[3];
  const method = request.method;

  if (!id) {
    if (method === "GET") return json({ jobs: manager.list() });
    if (method === "POST") {
      const body = (await request.json().catch(() => null)) as JobSpec | null;
      if (!body || typeof body !== "object") return json({ error: "Body JSON không hợp lệ." }, 400);
      const made = manager.create(body);
      if (!made.ok) return json({ error: made.error }, 400);
      return json({ id: made.id, job: manager.summary(made.id) }, 202);
    }
    return json({ error: "Method không hỗ trợ." }, 405);
  }

  const job = manager.get(id);
  if (!job) return json({ error: "Không tìm thấy job." }, 404);

  if (!action) {
    if (method === "GET") {
      const rev = Number(url.searchParams.get("rev"));
      const summary = toSummary(job, Date.now());
      const running = job.status === "running" || job.status === "queued";
      // Đang chạy thì thời gian trôi liên tục nên vẫn trả bản tóm tắt nhỏ.
      if (Number.isFinite(rev) && rev === job.rev) return json({ unchanged: true, summary });
      return json({
        summary,
        scenes: job.scenes,
        results: job.results,
        knownNames: job.knownNames,
        report: job.report,
        logs: job.logs.slice(-200),
        settings: job.settings,
        running,
      });
    }
    if (method === "DELETE") {
      return manager.remove(id) ? json({ ok: true }) : json({ error: "Job đang chạy, hãy dừng trước." }, 409);
    }
    return json({ error: "Method không hỗ trợ." }, 405);
  }

  if (action === "cancel" && method === "POST") return json({ ok: manager.cancel(id) });
  if (action === "resume" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { keys?: unknown; settings?: Record<string, unknown> };
    const result = manager.resume(id, body.keys, body.settings);
    return result.ok ? json({ ok: true, job: manager.summary(id) }, 202) : json({ error: result.error }, 400);
  }
  if (action === "export" && method === "GET") {
    const kind = (url.searchParams.get("kind") ?? "flowsheet") as ExportKind;
    if (!EXPORT_KINDS.includes(kind)) return json({ error: "Kiểu xuất không hợp lệ." }, 400);
    const file = manager.export(id, kind);
    if (!file) return json({ error: "Chưa có nội dung để xuất." }, 404);
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": `${file.mime}; charset=utf-8`,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "cache-control": "no-store",
      },
    });
  }
  return json({ error: "Không có route." }, 404);
}
