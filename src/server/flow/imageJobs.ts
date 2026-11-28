import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countGeneration, FLOW_MODELS, gapMs, modelInfo, normalizeProjectUrl, poolState, type FlowModel, type FlowUsage } from "../../core/flowImages.js";
import { FlowError, type FlowDriver } from "./driver.js";

export type ImageStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type FlowImageFile = { file: string; mime: string; width?: number; height?: number; bytes: number; createdAt: number; source?: string };
export type FlowSceneJob = {
  sceneId: string;
  prompt: string;
  references: string[];
  status: ImageStatus;
  images: FlowImageFile[];
  error?: string;
  ms?: number;
  attempts: number;
};
export type FlowJobStatus = "queued" | "running" | "waiting" | "paused" | "done" | "cancelled" | "interrupted";
export type FlowJob = {
  id: string;
  label: string;
  createdAt: number;
  status: FlowJobStatus;
  model: FlowModel;
  aspect: string;
  projectUrl: string;
  gapMinSec: number;
  gapMaxSec: number;
  scenes: FlowSceneJob[];
  pauseReason?: string;
  pauseKind?: string;
  /** Thông báo khi đang chạy (vd. đang nghỉ 30 phút vì Flow báo tạo quá nhanh). */
  notice?: string;
  /** Đã dùng lượt tự nghỉ-rồi-chạy-lại sau "tạo quá nhanh" trong lượt chạy này chưa. */
  cooldownUsed?: boolean;
  nextAt?: number;
  current?: string;
  elapsedMs: number;
  startedAt?: number;
  finishedAt?: number;
  logs: { at: number; text: string }[];
  rev: number;
};
export type FlowConfig = { projectUrl: string; model: FlowModel; gapMinSec: number; gapMaxSec: number; aspect: string };

export const DEFAULT_CONFIG: FlowConfig = { projectUrl: "", model: "nano-banana-2.1", gapMinSec: 30, gapMaxSec: 45, aspect: "16:9" };
/** Khi Flow báo tạo quá nhanh / 403: nghỉ chừng này rồi tự chạy lại MỘT lần. */
export const RATE_COOLDOWN_MS = 30 * 60_000;
/** Tên ảnh nhân vật hợp lệ (cũng là tên tệp trong flow-cache/refs/). */
export const REF_NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
const REF_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** Giãn cách tối thiểu cho phép chỉnh (giây): không cho chạy dồn dập. */
export const MIN_GAP_SEC = 30;
const RUNNING = new Set<FlowJobStatus>(["queued", "running", "waiting"]);
const ID_RE = /^fj-[a-z0-9-]{4,40}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,80}\.(png|jpg|jpeg|webp)$/;

function extFor(mime: string) {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

export type ManagerOptions = {
  dir: string;
  driver: FlowDriver;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  cooldownMs?: number;
};

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export class FlowImageManager {
  readonly dir: string;
  private readonly driver: FlowDriver;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly cooldownMs: number;
  readonly refsDir: string;
  private readonly jobs = new Map<string, FlowJob>();
  private active: { id: string; controller: AbortController } | null = null;
  private readonly queue: string[] = [];
  config: FlowConfig;
  usage: FlowUsage;

  constructor(options: ManagerOptions) {
    this.dir = options.dir;
    this.driver = options.driver;
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.cooldownMs = options.cooldownMs ?? RATE_COOLDOWN_MS;
    this.refsDir = join(this.dir, "refs");
    mkdirSync(this.refsDir, { recursive: true });
    mkdirSync(join(this.dir, "jobs"), { recursive: true });
    mkdirSync(join(this.dir, "img"), { recursive: true });
    this.config = { ...DEFAULT_CONFIG, ...this.readJson<Partial<FlowConfig>>("config.json", {}) };
    // Mặc định cũ 60–120 giây → mặc định mới 30–45 giây (bạn đã chọn nhanh hơn, chấp nhận rủi ro).
    if (this.config.gapMinSec === 60 && this.config.gapMaxSec === 120) {
      this.config.gapMinSec = DEFAULT_CONFIG.gapMinSec;
      this.config.gapMaxSec = DEFAULT_CONFIG.gapMaxSec;
    }
    this.usage = this.readJson<FlowUsage>("usage.json", {});
    for (const name of readdirSync(join(this.dir, "jobs"))) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(readFileSync(join(this.dir, "jobs", name), "utf8")) as FlowJob;
        if (!ID_RE.test(job.id)) continue;
        // Server tắt giữa chừng: KHÔNG tự chạy lại (điều khiển trình duyệt chỉ khi bạn bấm).
        if (RUNNING.has(job.status)) {
          job.status = "interrupted";
          job.pauseReason = "Server khởi động lại giữa chừng. Bấm \"Chạy tiếp\" để làm nốt.";
          for (const scene of job.scenes) if (scene.status === "running") scene.status = "pending";
          job.current = undefined;
          job.nextAt = undefined;
        }
        this.jobs.set(job.id, job);
      } catch {
        /* bỏ file hỏng */
      }
    }
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(path: string, value: unknown) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, path);
  }

  private save(job: FlowJob) {
    job.rev += 1;
    this.writeJson(join(this.dir, "jobs", `${job.id}.json`), job);
  }

  setConfig(patch: Partial<FlowConfig>): { ok: true; config: FlowConfig } | { ok: false; error: string } {
    const next = { ...this.config };
    if (patch.projectUrl !== undefined) {
      if (patch.projectUrl === "") next.projectUrl = "";
      else {
        const url = normalizeProjectUrl(String(patch.projectUrl));
        if (!url) return { ok: false, error: "Link project Flow không hợp lệ (dạng https://flow.google.com/project/...)." };
        next.projectUrl = url;
      }
    }
    if (patch.model !== undefined) {
      if (!FLOW_MODELS.some((item) => item.id === patch.model)) return { ok: false, error: "Mô hình không hợp lệ." };
      next.model = patch.model;
    }
    if (patch.aspect !== undefined) next.aspect = ["16:9", "9:16", "1:1", "4:3", "3:4"].includes(patch.aspect) ? patch.aspect : "16:9";
    if (patch.gapMinSec !== undefined || patch.gapMaxSec !== undefined) {
      const lo = Math.max(MIN_GAP_SEC, Math.min(900, Number(patch.gapMinSec ?? next.gapMinSec) || DEFAULT_CONFIG.gapMinSec));
      const hi = Math.max(lo, Math.min(1800, Number(patch.gapMaxSec ?? next.gapMaxSec) || DEFAULT_CONFIG.gapMaxSec));
      next.gapMinSec = lo;
      next.gapMaxSec = hi;
    }
    this.config = next;
    this.writeJson(join(this.dir, "config.json"), next);
    return { ok: true, config: next };
  }

  quota() {
    const now = this.now();
    return { nb2: poolState(this.usage, "nb2", now), pro: poolState(this.usage, "pro", now) };
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((job) => this.summary(job));
  }

  summary(job: FlowJob) {
    const count = (status: ImageStatus) => job.scenes.filter((scene) => scene.status === status).length;
    return {
      id: job.id,
      label: job.label,
      createdAt: job.createdAt,
      status: job.status,
      model: job.model,
      total: job.scenes.length,
      done: count("done"),
      failed: count("failed"),
      pending: count("pending") + count("running"),
      skipped: count("skipped"),
      images: job.scenes.reduce((sum, scene) => sum + scene.images.length, 0),
      pauseReason: job.pauseReason,
      pauseKind: job.pauseKind,
      notice: job.notice,
      nextAt: job.nextAt,
      current: job.current,
      elapsedMs: job.elapsedMs + (job.startedAt && RUNNING.has(job.status) ? this.now() - job.startedAt : 0),
      rev: job.rev,
    };
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  activeId() {
    return this.active?.id ?? null;
  }

  /** Ảnh nhân vật đã có trên máy (flow-cache/refs/<Tên>.png|jpg|webp). */
  refFile(name: string): string | null {
    if (!REF_NAME_RE.test(name)) return null;
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const path = join(this.refsDir, `${name}.${ext}`);
      if (existsSync(path)) return path;
    }
    return null;
  }

  listRefs(): { name: string; file: string; bytes: number }[] {
    const out: { name: string; file: string; bytes: number }[] = [];
    for (const file of readdirSync(this.refsDir)) {
      const match = /^(.+)\.(png|jpe?g|webp)$/i.exec(file);
      if (!match || !REF_NAME_RE.test(match[1])) continue;
      out.push({ name: match[1], file, bytes: statSync(join(this.refsDir, file)).size });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  saveRef(name: string, mime: string, data: Buffer): { ok: true } | { ok: false; error: string } {
    if (!REF_NAME_RE.test(name)) return { ok: false, error: "Tên nhân vật không hợp lệ." };
    const ext = REF_EXT[mime.split(";")[0].trim().toLowerCase()];
    if (!ext) return { ok: false, error: "Chỉ nhận ảnh PNG, JPG hoặc WebP." };
    if (!data.length || data.length > 20 * 1024 * 1024) return { ok: false, error: "Ảnh trống hoặc lớn hơn 20 MB." };
    for (const old of ["png", "jpg", "jpeg", "webp"]) rmSync(join(this.refsDir, `${name}.${old}`), { force: true });
    writeFileSync(join(this.refsDir, `${name}.${ext}`), data);
    return { ok: true };
  }

  /**
   * Trước khi vẽ: mở Chrome ẩn, chọn project, kiểm tra ảnh nhân vật trong project và
   * tự tải lên ảnh còn thiếu từ máy. Trả về lỗi để dừng job, hoặc null nếu sẵn sàng.
   */
  private async preflight(job: FlowJob): Promise<{ kind: string; message: string } | null> {
    try {
      job.notice = "Đang mở Google Flow (chạy ẩn) và kiểm tra ảnh nhân vật…";
      this.save(job);
      const projectUrl = await this.driver.prepare(job.projectUrl || this.config.projectUrl || undefined);
      if (projectUrl !== job.projectUrl) {
        job.projectUrl = projectUrl;
        this.log(job, `Dùng project ${projectUrl}`);
      }
      if (projectUrl !== this.config.projectUrl) this.setConfig({ projectUrl });
      const names = [...new Set(job.scenes.filter((scene) => scene.status === "pending").flatMap((scene) => scene.references))];
      if (!names.length) return null;
      let found = await this.driver.checkReferences(projectUrl, names);
      const missing = names.filter((name) => !found[name]);
      const uploadable = missing.filter((name) => this.refFile(name));
      for (const name of uploadable) {
        job.notice = `Đang tải ảnh nhân vật ${name} lên Flow…`;
        this.save(job);
        await this.driver.uploadReference(projectUrl, this.refFile(name)!);
        this.log(job, `Đã tải ảnh ${name} lên project`);
      }
      if (uploadable.length) found = await this.driver.checkReferences(projectUrl, names);
      const still = names.filter((name) => !found[name]);
      if (still.length) {
        const noFile = still.filter((name) => !this.refFile(name));
        return {
          kind: "missing-ref",
          message: noFile.length
            ? `Thiếu ảnh nhân vật: ${noFile.join(", ")}. Chọn ảnh cho từng tên ở mục "Ảnh nhân vật" trong bảng Tạo ảnh, rồi bấm "Chạy tiếp".`
            : `Đã tải ảnh ${still.join(", ")} lên nhưng Flow chưa nhận. Bấm "Chạy tiếp" để thử lại.`,
        };
      }
      return null;
    } catch (error) {
      const kind = error instanceof FlowError ? error.kind : "unknown";
      return { kind, message: error instanceof Error ? error.message : String(error) };
    } finally {
      job.notice = undefined;
    }
  }

  create(input: { label?: unknown; scenes?: unknown; model?: unknown }): { ok: true; id: string } | { ok: false; error: string } {
    const rows = Array.isArray(input.scenes) ? input.scenes : [];
    const scenes: FlowSceneJob[] = [];
    const seen = new Set<string>();
    for (const row of rows.slice(0, 2000)) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const sceneId = typeof item.sceneId === "string" ? item.sceneId.slice(0, 40) : "";
      const prompt = typeof item.prompt === "string" ? item.prompt.trim().slice(0, 4000) : "";
      if (!sceneId || !prompt || seen.has(sceneId) || !/^[\w.-]+$/.test(sceneId)) continue;
      seen.add(sceneId);
      const references = Array.isArray(item.references) ? item.references.filter((name): name is string => typeof name === "string" && /^[\p{L}\p{N} _.-]{1,40}$/u.test(name)).slice(0, 10) : [];
      scenes.push({ sceneId, prompt, references, status: "pending", images: [], attempts: 0 });
    }
    if (!scenes.length) return { ok: false, error: "Không có cảnh nào có prompt để tạo ảnh." };
    const model = FLOW_MODELS.some((item) => item.id === input.model) ? (input.model as FlowModel) : this.config.model;
    const id = `fj-${this.now().toString(36)}-${Math.floor(this.random() * 1e6).toString(36)}`;
    const job: FlowJob = {
      id,
      label: typeof input.label === "string" ? input.label.slice(0, 120) : "Ảnh Flow",
      createdAt: this.now(),
      status: "queued",
      model,
      aspect: this.config.aspect,
      projectUrl: this.config.projectUrl,
      gapMinSec: this.config.gapMinSec,
      gapMaxSec: this.config.gapMaxSec,
      scenes,
      elapsedMs: 0,
      logs: [],
      rev: 0,
    };
    this.jobs.set(id, job);
    mkdirSync(join(this.dir, "img", id), { recursive: true });
    this.save(job);
    this.enqueue(id);
    return { ok: true, id };
  }

  private log(job: FlowJob, text: string) {
    job.logs.push({ at: this.now(), text });
    if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  }

  private enqueue(id: string) {
    if (!this.queue.includes(id) && this.active?.id !== id) this.queue.push(id);
    void this.pump();
  }

  private async pump() {
    if (this.active) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job) return void this.pump();
    const controller = new AbortController();
    this.active = { id, controller };
    try {
      await this.run(job, controller.signal);
    } catch (error) {
      this.pause(job, "unknown", error instanceof Error ? error.message : String(error));
    } finally {
      if (job.startedAt) job.elapsedMs += this.now() - job.startedAt;
      job.startedAt = undefined;
      job.current = undefined;
      job.nextAt = undefined;
      if (job.status === "running" || job.status === "waiting" || job.status === "queued") job.status = controller.signal.aborted ? "cancelled" : job.status;
      this.save(job);
      this.active = null;
      void this.pump();
    }
  }

  private pause(job: FlowJob, kind: string, reason: string) {
    job.status = "paused";
    job.pauseKind = kind;
    job.pauseReason = reason;
    this.log(job, `Tạm dừng: ${reason}`);
  }

  private async run(job: FlowJob, signal: AbortSignal) {
    job.status = "running";
    job.pauseReason = undefined;
    job.pauseKind = undefined;
    job.startedAt = this.now();
    this.log(job, "Bắt đầu");
    this.save(job);
    const blocked = await this.preflight(job);
    if (signal.aborted) {
      job.status = "cancelled";
      return;
    }
    if (blocked) {
      this.pause(job, blocked.kind, blocked.message);
      return;
    }
    let generic = 0;
    let first = true;
    while (!signal.aborted) {
      const scene = job.scenes.find((item) => item.status === "pending");
      if (!scene) break;
      const pool = modelInfo(job.model).pool;
      const quota = poolState(this.usage, pool, this.now());
      if (quota.left <= 0) {
        this.pause(job, "quota", `Hết hạn mức ${quota.limit} ảnh/ngày của ${modelInfo(job.model).menu} (theo số đếm của app). Mở lại sau ${quota.resetAt ? new Date(quota.resetAt).toLocaleString("vi-VN") : "24 giờ"}.`);
        return;
      }
      if (!first) {
        const wait = gapMs(job.gapMinSec, job.gapMaxSec, this.random);
        job.status = "waiting";
        job.nextAt = this.now() + wait;
        this.save(job);
        await this.sleepFn(wait, signal);
        if (signal.aborted) break;
      }
      first = false;
      job.status = "running";
      job.nextAt = undefined;
      job.current = scene.sceneId;
      scene.status = "running";
      scene.attempts += 1;
      this.save(job);
      const started = this.now();
      try {
        const images = await this.driver.generate({ prompt: scene.prompt, references: scene.references, model: job.model, aspect: job.aspect, projectUrl: job.projectUrl }, signal);
        const files: FlowImageFile[] = [];
        images.forEach((image, index) => {
          const file = `${scene.sceneId}-${scene.attempts}-${index + 1}.${extFor(image.mime)}`;
          writeFileSync(join(this.dir, "img", job.id, file), image.data);
          files.push({ file, mime: image.mime, width: image.width, height: image.height, bytes: image.data.length, createdAt: this.now(), source: image.source });
        });
        for (const old of scene.images) rmSync(join(this.dir, "img", job.id, old.file), { force: true });
        scene.images = files;
        scene.status = "done";
        scene.error = undefined;
        scene.ms = this.now() - started;
        this.usage = countGeneration(this.usage, pool, this.now(), Math.max(1, images.length));
        this.writeJson(join(this.dir, "usage.json"), this.usage);
        this.log(job, `Cảnh ${scene.sceneId}: ${images.length} ảnh, ${Math.round(scene.ms / 1000)} s`);
        generic = 0;
      } catch (error) {
        scene.ms = this.now() - started;
        const kind = error instanceof FlowError ? error.kind : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        if (signal.aborted) {
          scene.status = "pending";
          break;
        }
        if (kind === "policy") {
          scene.status = "failed";
          scene.error = message;
          this.log(job, `Cảnh ${scene.sceneId} bị chặn: ${message}`);
          continue;
        }
        if (kind === "timeout" || kind === "ui") {
          // Quá giờ có thể Flow vẫn tạo ảnh: đếm vào hạn mức cho chắc.
          if (kind === "timeout") {
            this.usage = countGeneration(this.usage, pool, this.now(), 1);
            this.writeJson(join(this.dir, "usage.json"), this.usage);
          }
          generic += 1;
          scene.status = generic >= 2 ? "pending" : "failed";
          scene.error = message;
          this.log(job, `Cảnh ${scene.sceneId} lỗi: ${message}`);
          if (generic >= 2) {
            this.pause(job, kind, `Hai cảnh liền lỗi. Lỗi cuối: ${message}`);
            return;
          }
          continue;
        }
        scene.status = "pending";
        scene.error = message;
        if (kind === "rate" && !job.cooldownUsed) {
          // Flow báo tạo quá nhanh / 403: nghỉ hẳn một lúc rồi tự chạy lại MỘT lần (không né, không đổi tài khoản).
          job.cooldownUsed = true;
          const minutes = Math.round(this.cooldownMs / 60_000);
          job.status = "waiting";
          job.nextAt = this.now() + this.cooldownMs;
          job.notice = `Flow báo tạo quá nhanh. App nghỉ ${minutes} phút rồi tự chạy lại một lần; nếu Flow vẫn báo thì dừng hẳn.`;
          this.log(job, `${message} → nghỉ ${minutes} phút`);
          this.save(job);
          await this.sleepFn(this.cooldownMs, signal);
          job.notice = undefined;
          job.nextAt = undefined;
          if (signal.aborted) break;
          first = true;
          continue;
        }
        // quota / auth / missing-ref / unknown, hoặc "quá nhanh" lần hai: dừng ngay, không thử lại.
        this.pause(job, kind, kind === "rate" ? `${message} (đã nghỉ một lần mà Flow vẫn báo; bấm "Chạy tiếp" sau vài giờ).` : message);
        return;
      } finally {
        job.current = undefined;
        this.save(job);
      }
    }
    if (signal.aborted) {
      job.status = "cancelled";
      this.log(job, "Đã dừng theo yêu cầu");
      return;
    }
    job.status = "done";
    job.finishedAt = this.now();
    this.log(job, "Xong");
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    const queued = this.queue.indexOf(id);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      job.status = "cancelled";
      this.save(job);
      return true;
    }
    if (this.active?.id === id) {
      this.active.controller.abort();
      return true;
    }
    return false;
  }

  resume(id: string, options: { retryFailed?: boolean } = {}): { ok: true } | { ok: false; error: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: "Không tìm thấy job ảnh." };
    if (RUNNING.has(job.status) || this.active?.id === id) return { ok: false, error: "Job đang chạy." };
    if (options.retryFailed) for (const scene of job.scenes) if (scene.status === "failed") scene.status = "pending";
    if (!job.scenes.some((scene) => scene.status === "pending")) return { ok: false, error: "Không còn cảnh nào cần tạo." };
    // Dùng project và cài đặt giãn cách hiện tại (bạn có thể đã đổi project).
    if (this.config.projectUrl) job.projectUrl = this.config.projectUrl;
    job.gapMinSec = this.config.gapMinSec;
    job.gapMaxSec = this.config.gapMaxSec;
    job.status = "queued";
    job.pauseReason = undefined;
    job.pauseKind = undefined;
    job.cooldownUsed = false;
    this.save(job);
    this.enqueue(id);
    return { ok: true };
  }

  /** Tạo lại một cảnh: đưa về hàng chờ; ảnh cũ giữ đến khi có ảnh mới. */
  regenerate(id: string, sceneId: string, prompt?: string, references?: string[]): { ok: true } | { ok: false; error: string } {
    const job = this.jobs.get(id);
    const scene = job?.scenes.find((item) => item.sceneId === sceneId);
    if (!job || !scene) return { ok: false, error: "Không tìm thấy cảnh." };
    if (scene.status === "running") return { ok: false, error: "Cảnh đang được tạo." };
    if (typeof prompt === "string" && prompt.trim()) scene.prompt = prompt.trim().slice(0, 4000);
    if (Array.isArray(references)) scene.references = references.filter((name) => typeof name === "string").slice(0, 10);
    scene.status = "pending";
    scene.error = undefined;
    if (RUNNING.has(job.status) || this.active?.id === id) {
      this.save(job);
      return { ok: true };
    }
    return this.resume(id);
  }

  skip(id: string, sceneId: string): boolean {
    const job = this.jobs.get(id);
    const scene = job?.scenes.find((item) => item.sceneId === sceneId);
    if (!job || !scene || scene.status === "running") return false;
    scene.status = "skipped";
    this.save(job);
    return true;
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || RUNNING.has(job.status) || this.active?.id === id) return false;
    this.jobs.delete(id);
    rmSync(join(this.dir, "jobs", `${id}.json`), { force: true });
    rmSync(join(this.dir, "img", id), { recursive: true, force: true });
    return true;
  }

  imagePath(id: string, file: string): string | null {
    if (!ID_RE.test(id) || !FILE_RE.test(file)) return null;
    const path = join(this.dir, "img", id, file);
    return existsSync(path) ? path : null;
  }

  flush() {
    for (const job of this.jobs.values()) this.writeJson(join(this.dir, "jobs", `${job.id}.json`), job);
  }
}
