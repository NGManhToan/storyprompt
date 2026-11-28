import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractNames } from "../core/cast.js";
import { buildScenes, type ChunkMode } from "../core/chunk.js";
import { buildExport, type ExportKind } from "../core/exportKinds.js";
import { FLOW_STYLE_FOOTER } from "../core/flow.js";
import { runPipeline } from "../core/pipeline.js";
import type { RequestLog, RunReport, RunSettings, Scene, SceneResult } from "../core/types.js";
import { clamp, emptyResult } from "../core/types.js";
import { buildServerLanes, type BuiltLanes, type JobKey, type LaneSettings, type UsageStore } from "./jobLanes.js";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

/** Cài đặt ghi cùng job: KHÔNG chứa khóa API. */
export type JobSettings = RunSettings & {
  aspectRatio: string;
  arSuffix: boolean;
  extraNames: string;
  lane: NonNullable<LaneSettings["lane"]>;
  useGemini: boolean;
  useGroq: boolean;
  useCloudflare: boolean;
};

export type JobRecord = {
  id: string;
  fileName: string;
  mode: "live" | "mock";
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Tổng thời gian chạy (cộng dồn qua các lần chạy tiếp). */
  elapsedMs: number;
  label: string;
  error?: string;
  /** Tăng mỗi lần dữ liệu đổi: trình duyệt hỏi `?rev=` để khỏi tải lại khi chưa có gì mới. */
  rev: number;
  /** Lần ghi đĩa gần nhất (để tính thời gian chạy khi server tắt giữa chừng). */
  savedAt?: number;
  scenes: Scene[];
  knownNames: string[];
  masterScript?: string;
  results: SceneResult[];
  report?: RunReport;
  logs: RequestLog[];
  settings: JobSettings;
  laneLabels: string[];
  keySource: "server" | "browser" | "mixed" | "none";
};

export type JobSummary = {
  id: string;
  fileName: string;
  mode: "live" | "mock";
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs: number;
  label: string;
  error?: string;
  rev: number;
  sceneCount: number;
  accepted: number;
  failed: number;
  pending: number;
  requests?: number;
  tokens?: number;
  rateLimited?: number;
  laneLabels: string[];
  keySource: JobRecord["keySource"];
};

export type JobSpec = {
  fileName?: string;
  mode?: "live" | "mock";
  /** Hoặc gửi sẵn cảnh đã cắt, hoặc gửi nguyên văn SRT/TXT để server cắt. */
  scenes?: unknown;
  text?: string;
  chunk?: { mode?: ChunkMode; duration?: number; kind?: "srt" | "txt" };
  knownNames?: unknown;
  masterScript?: string;
  settings?: Record<string, unknown>;
  keys?: unknown;
  /** Kết quả đã đạt từ trước (chạy tiếp một bản lưu): chỉ nhận cảnh accepted/edited có prompt. */
  prior?: unknown;
};

const MAX_JOBS = 40;
const MAX_LOGS = 400;
const MAX_SCENES = 2_000;

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(n, min, max);
}
function str(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : fallback;
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function sanitizeSettings(raw: Record<string, unknown> = {}): JobSettings {
  return {
    batchSize: Math.round(num(raw.batchSize, 44, 1, 48)),
    concurrency: Math.round(num(raw.concurrency, 4, 1, 12)),
    maxAttempts: Math.round(num(raw.maxAttempts, 3, 1, 5)),
    maxOutputTokens: Math.round(num(raw.maxOutputTokens, 16384, 1024, 65536)),
    temperature: num(raw.temperature, 0.7, 0, 2),
    bible: bool(raw.bible, false),
    fullScript: bool(raw.fullScript, true),
    contextScenes: Math.round(num(raw.contextScenes, 4, 0, 10)),
    topic: str(raw.topic, "", 500),
    protagonist: str(raw.protagonist, "", 500),
    prefix: str(raw.prefix, "", 4_000),
    footer: str(raw.footer, FLOW_STYLE_FOOTER, 4_000),
    aspectRatio: str(raw.aspectRatio, "16:9", 12),
    arSuffix: bool(raw.arSuffix, false),
    extraNames: str(raw.extraNames, "", 1_000),
    lane: (["gemini", "groq", "cloudflare"].includes(String(raw.lane)) ? String(raw.lane) : "gemini") as JobSettings["lane"],
    // Mặc định chỉ Gemini + Cloudflare dự phòng; Groq tắt (số đo 27/11: Groq 0/2 cảnh đạt).
    useGemini: bool(raw.useGemini, true),
    useGroq: bool(raw.useGroq, false),
    useCloudflare: bool(raw.useCloudflare, true),
  };
}

function laneSettingsOf(raw: Record<string, unknown>, settings: JobSettings): LaneSettings {
  const n = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key] as number) && (raw[key] as number) > 0 ? (raw[key] as number) : undefined);
  const s = (key: string) => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim().slice(0, 200) : undefined);
  return {
    lane: settings.lane,
    useGemini: settings.useGemini,
    useGroq: settings.useGroq,
    useCloudflare: settings.useCloudflare,
    serverOff: Array.isArray(raw.serverOff) ? raw.serverOff.filter((item): item is string => typeof item === "string") : [],
    geminiModel: s("geminiModel"),
    geminiFallbacks: typeof raw.geminiFallbacks === "string" ? raw.geminiFallbacks.slice(0, 200) : undefined,
    groqModel: s("groqModel"),
    cfModel: s("cfModel"),
    rpm: n("rpm"),
    tpm: n("tpm"),
    rpd: n("rpd"),
    groqRpm: n("groqRpm"),
    groqTpm: n("groqTpm"),
    groqOtpm: n("groqOtpm"),
    groqRpd: n("groqRpd"),
    cfRpm: n("cfRpm"),
    cfNeuronStop: n("cfNeuronStop"),
  };
}

export function sanitizeKeys(raw: unknown): JobKey[] {
  if (!Array.isArray(raw)) return [];
  const out: JobKey[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.provider !== "gemini" && row.provider !== "groq" && row.provider !== "cloudflare") continue;
    if (typeof row.key !== "string" || !row.key.trim()) continue;
    out.push({
      id: typeof row.id === "string" ? row.id.slice(0, 40) : undefined,
      provider: row.provider,
      label: typeof row.label === "string" ? row.label.slice(0, 60) : "",
      key: row.key.trim().slice(0, 400),
      account: typeof row.account === "string" ? row.account.trim().slice(0, 64) : undefined,
      enabled: row.enabled !== false,
    });
  }
  return out;
}

function sanitizeScenes(raw: unknown): Scene[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_SCENES) return null;
  const out: Scene[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (typeof row.sceneId !== "string" || typeof row.source !== "string" || !row.sceneId) return null;
    out.push({
      sceneId: row.sceneId.slice(0, 16),
      title: str(row.title, "", 200),
      heading: str(row.heading, "", 200),
      source: row.source.slice(0, 20_000),
      start: str(row.start, "", 40),
      end: str(row.end, "", 40),
      cueIndexes: Array.isArray(row.cueIndexes) ? row.cueIndexes.filter((n): n is number => typeof n === "number") : [],
      timeRange: str(row.timeRange, "", 80),
      cutReason: str(row.cutReason, "", 120),
      durationSeconds: typeof row.durationSeconds === "number" ? row.durationSeconds : 0,
    } as Scene);
  }
  return out;
}

function sanitizePrior(raw: unknown, scenes: Scene[]): SceneResult[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(scenes.map((scene) => scene.sceneId));
  const out: SceneResult[] = [];
  for (const item of raw.slice(0, MAX_SCENES)) {
    if (!item || typeof item !== "object") continue;
    const row = item as SceneResult;
    if ((row.status !== "accepted" && row.status !== "edited") || typeof row.prompt !== "string" || !row.prompt.trim() || !ids.has(row.sceneId)) continue;
    out.push({ ...emptyResult(scenes.find((scene) => scene.sceneId === row.sceneId)!), ...row, rejections: Array.isArray(row.rejections) ? row.rejections : [], visibleCast: Array.isArray(row.visibleCast) ? row.visibleCast : [] });
  }
  return out;
}

export function toSummary(job: JobRecord, now: number): JobSummary {
  const accepted = job.results.filter((row) => row.status === "accepted" || row.status === "edited").length;
  const failed = job.results.filter((row) => row.status === "failed" || row.status === "rejected").length;
  const running = job.status === "running" || job.status === "queued";
  const elapsedMs = running && job.startedAt ? job.elapsedMs + Math.max(0, now - job.startedAt) : job.elapsedMs;
  return {
    id: job.id,
    fileName: job.fileName,
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs,
    label: job.label,
    error: job.error,
    rev: job.rev,
    sceneCount: job.scenes.length,
    accepted,
    failed,
    pending: Math.max(0, job.scenes.length - accepted - failed),
    requests: job.report?.requests ?? job.logs.length,
    tokens: job.report?.tokens.total ?? job.logs.reduce((sum, log) => sum + log.totalTokens, 0),
    rateLimited: job.logs.filter((log) => log.status === "rate_limited").length,
    laneLabels: job.laneLabels,
    keySource: job.keySource,
  };
}

export type JobManagerOptions = {
  dir: string;
  env?: NodeJS.ProcessEnv;
  usage: UsageStore;
  now?: () => number;
  /** Cho test: thay cách dựng lane. */
  buildLanes?: (args: { settings: LaneSettings; keys: JobKey[]; mode: "live" | "mock" }) => BuiltLanes;
  /** Chờ ghi đĩa (ms). 0 = ghi ngay (test). */
  persistDelayMs?: number;
};

export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private controllers = new Map<string, AbortController>();
  private done = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dir: string;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly delay: number;

  constructor(private readonly options: JobManagerOptions) {
    this.dir = options.dir;
    this.now = options.now ?? (() => Date.now());
    this.env = options.env ?? process.env;
    this.delay = options.persistDelayMs ?? 800;
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /** Đọc lại job từ đĩa. Job đang chạy lúc server tắt → "interrupted" (trả về danh sách có thể tự chạy tiếp bằng khóa .env). */
  private load() {
    for (const name of readdirSync(this.dir)) {
      if (!/^job-[\w-]+\.json$/.test(name)) continue;
      try {
        const job = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as JobRecord;
        if (!job?.id || !Array.isArray(job.scenes)) continue;
        if (job.status === "running" || job.status === "queued") {
          job.elapsedMs += job.startedAt ? Math.max(0, (job.savedAt ?? job.startedAt) - job.startedAt) : 0;
          job.startedAt = undefined;
          job.status = "interrupted";
          job.label = "Server đã khởi động lại giữa chừng. Phần đã xong được giữ lại.";
          job.rev += 1;
          this.writeNow(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        /* bỏ qua file hỏng */
      }
    }
  }

  /** Job bị ngắt chỉ vì server khởi động lại và chỉ dùng khóa .env → có thể tự chạy tiếp mà không cần khóa từ trình duyệt. */
  interruptedServerJobs(): string[] {
    return [...this.jobs.values()].filter((job) => job.status === "interrupted" && job.keySource === "server").map((job) => job.id);
  }

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  private writeNow(job: JobRecord) {
    try {
      job.savedAt = this.now();
      const tmp = `${this.file(job.id)}.tmp`;
      writeFileSync(tmp, JSON.stringify(job));
      renameSync(tmp, this.file(job.id));
    } catch {
      /* ổ đĩa lỗi: job vẫn chạy trong bộ nhớ */
    }
  }

  private persist(job: JobRecord, immediate = false) {
    job.rev += 1;
    if (immediate || this.delay <= 0) {
      const timer = this.timers.get(job.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(job.id);
      this.writeNow(job);
      return;
    }
    if (this.timers.has(job.id)) return;
    this.timers.set(
      job.id,
      setTimeout(() => {
        this.timers.delete(job.id);
        this.writeNow(job);
      }, this.delay),
    );
  }

  private prune() {
    const rows = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    for (const job of rows.slice(MAX_JOBS)) {
      if (job.status === "running" || job.status === "queued") continue;
      this.jobs.delete(job.id);
      rmSync(this.file(job.id), { force: true });
    }
  }

  create(spec: JobSpec): { ok: true; id: string } | { ok: false; error: string } {
    const mode = spec.mode === "mock" ? "mock" : "live";
    const settings = sanitizeSettings(spec.settings ?? {});
    let scenes: Scene[] | null = null;
    if (spec.scenes !== undefined) scenes = sanitizeScenes(spec.scenes);
    else if (typeof spec.text === "string" && spec.text.trim()) {
      const kind = spec.chunk?.kind === "txt" || !spec.text.includes("-->") ? "txt" : "srt";
      const parsed = buildScenes(spec.text.slice(0, 2_000_000), {
        mode: kind === "txt" ? "fixed" : spec.chunk?.mode ?? "fixed",
        duration: num(spec.chunk?.duration, 8, 2, 120),
        kind,
      });
      scenes = parsed.scenes.slice(0, MAX_SCENES);
    }
    if (!scenes?.length) return { ok: false, error: "Thiếu cảnh: gửi `scenes` hoặc `text` (SRT/TXT) hợp lệ." };

    const keys = sanitizeKeys(spec.keys);
    const laneSettings = laneSettingsOf(spec.settings ?? {}, settings);
    const built = this.lanes(laneSettings, keys, mode);
    if (!built.slots.length) {
      return { ok: false, error: "Chưa có khóa nào dùng được: thêm khóa trong Cài đặt hoặc đặt GEMINI_API_KEY trong .env của server." };
    }
    const extra = settings.extraNames.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
    const names = Array.isArray(spec.knownNames)
      ? spec.knownNames.filter((item): item is string => typeof item === "string").slice(0, 60)
      : extractNames(scenes.map((scene) => scene.source).join("\n"), extra);

    const id = `job-${this.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const job: JobRecord = {
      id,
      fileName: str(spec.fileName, "storyprompt.srt", 200),
      mode,
      status: "queued",
      createdAt: this.now(),
      elapsedMs: 0,
      label: "Đang xếp hàng",
      rev: 0,
      scenes,
      knownNames: names,
      masterScript: typeof spec.masterScript === "string" ? spec.masterScript.slice(0, 200_000) : undefined,
      results: scenes.map(emptyResult),
      logs: [],
      settings,
      laneLabels: built.labels,
      keySource: built.keySource,
    };
    const prior = sanitizePrior(spec.prior, scenes);
    for (const row of prior) {
      const index = job.results.findIndex((item) => item.sceneId === row.sceneId);
      if (index >= 0) job.results[index] = row;
    }
    this.jobs.set(id, job);
    this.prune();
    this.persist(job, true);
    this.start(job, built, prior);
    return { ok: true, id };
  }

  private lanes(settings: LaneSettings, keys: JobKey[], mode: "live" | "mock"): BuiltLanes {
    return this.options.buildLanes
      ? this.options.buildLanes({ settings, keys, mode })
      : buildServerLanes({ settings, keys, env: this.env, usage: this.options.usage, mode });
  }

  private start(job: JobRecord, built: BuiltLanes, prior: SceneResult[]) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = "running";
    job.startedAt = this.now();
    job.finishedAt = undefined;
    job.error = undefined;
    job.label = "Đang chạy";
    this.persist(job, true);
    const settings = job.settings;
    const run = (async () => {
      try {
        const output = await runPipeline({
          scenes: job.scenes,
          knownNames: job.knownNames,
          settings,
          lanes: built.slots.map((slot) => slot.provider),
          slots: built.slots,
          prior,
          fileName: job.fileName,
          projectId: job.id,
          masterScript: job.masterScript,
          topic: settings.topic,
          protagonist: settings.protagonist,
          signal: controller.signal,
          now: this.now,
          onProgress: (event) => {
            if (event.type === "status") {
              job.label = event.label;
              this.persist(job);
            } else if (event.type === "scene") {
              const index = job.results.findIndex((row) => row.sceneId === event.result.sceneId);
              if (index >= 0) job.results[index] = event.result;
              this.persist(job);
            } else if (event.type === "log") {
              job.logs.push(event.log);
              if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
              this.persist(job);
            }
          },
        });
        job.results = output.results;
        job.report = output.report;
        job.knownNames = output.knownNames;
        const spent = Math.max(0, this.now() - (job.startedAt ?? this.now()));
        job.elapsedMs += spent;
        job.finishedAt = this.now();
        if (output.report.cancelled) {
          job.status = "cancelled";
          job.label = "Đã dừng. Phần đã xong được giữ lại.";
        } else if (output.report.fatalError) {
          job.status = "error";
          job.error = output.report.fatalError;
          job.label = "Lỗi giữa chừng. Phần đã xong được giữ lại.";
        } else {
          job.status = "done";
          job.label = "Xong lượt chạy";
        }
      } catch (error) {
        job.elapsedMs += Math.max(0, this.now() - (job.startedAt ?? this.now()));
        job.finishedAt = this.now();
        job.status = "error";
        job.error = (error instanceof Error ? error.message : "Lỗi không rõ").replace(/key=[^&\s]+/gi, "key=***").slice(0, 400);
        job.label = "Lỗi giữa chừng. Phần đã xong được giữ lại.";
      } finally {
        this.controllers.delete(job.id);
        job.startedAt = undefined;
        this.persist(job, true);
      }
    })();
    this.done.set(job.id, run);
  }

  /** Chờ job xong (dùng trong test). */
  async wait(id: string): Promise<void> {
    await this.done.get(id);
  }

  /** Chạy tiếp các cảnh chưa đạt của job (khóa gửi kèm, hoặc khóa .env nếu không gửi). */
  resume(id: string, keysRaw: unknown, settingsRaw?: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: "Không tìm thấy job." };
    if (job.status === "running" || job.status === "queued") return { ok: false, error: "Job đang chạy." };
    const keys = sanitizeKeys(keysRaw);
    const laneSettings = laneSettingsOf(settingsRaw ?? {}, job.settings);
    const built = this.lanes(laneSettings, keys, job.mode);
    if (!built.slots.length) return { ok: false, error: "Chưa có khóa nào dùng được để chạy tiếp." };
    // Cảnh chưa đạt chạy lại từ đầu (attempts = 0) nhưng giữ nguyên các cảnh đã đạt.
    const prior = job.results.map((row) =>
      row.status === "accepted" || row.status === "edited" ? row : { ...emptyResult(job.scenes.find((s) => s.sceneId === row.sceneId)!), },
    );
    job.results = prior;
    job.laneLabels = built.labels;
    job.keySource = built.keySource;
    this.start(job, built, prior);
    return { ok: true };
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status === "running" || job.status === "queued") return false;
    this.jobs.delete(id);
    rmSync(this.file(id), { force: true });
    return true;
  }

  list(): JobSummary[] {
    const now = this.now();
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((job) => toSummary(job, now));
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  summary(id: string): JobSummary | undefined {
    const job = this.jobs.get(id);
    return job ? toSummary(job, this.now()) : undefined;
  }

  export(id: string, kind: ExportKind): { filename: string; body: string; mime: string } | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return buildExport(kind, {
      fileName: job.fileName,
      scenes: job.scenes,
      results: job.results,
      options: {
        prefix: job.settings.prefix,
        footer: job.settings.footer,
        roster: job.knownNames,
        aspectRatio: job.settings.aspectRatio,
        arSuffix: job.settings.arSuffix,
      },
      names: job.knownNames,
      masterScript: job.masterScript,
      report: job.report,
      logs: job.logs,
    });
  }

  /** Ghi nốt mọi thứ ra đĩa (tắt server êm). */
  flush() {
    for (const job of this.jobs.values()) {
      const timer = this.timers.get(job.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(job.id);
      this.writeNow(job);
    }
  }
}
