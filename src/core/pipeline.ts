import { extractNames, inferPresence } from "./cast.js";
import { isAbortError } from "./errors.js";
import {
  bibleDigest,
  buildBibleRequest,
  buildSceneRequest,
  parseBiblePayload,
  parseScenePayload,
  salvageScenes,
  sceneContextWindow,
  windowMasterScript,
} from "./prompts.js";
import { createRouter, type LaneSlot } from "./router.js";
import type { Scheduler } from "./scheduler.js";
import type {
  GenerateResponse,
  LaneTelemetry,
  Provider,
  Rejection,
  RequestLog,
  RunReport,
  RunSettings,
  RunTelemetry,
  Scene,
  SceneDraft,
  SceneResult,
  SceneTask,
  StoryBible,
} from "./types.js";
import { clamp, emptyResult } from "./types.js";
import { canonSceneId, repairEnding, validateDraft, visualKey } from "./validators.js";

export type Checkpoint = {
  id: string;
  fileName: string;
  savedAt: number;
  scenes: Scene[];
  knownNames: string[];
  bible?: StoryBible;
  results: SceneResult[];
  logs: RequestLog[];
  report?: RunReport;
  masterScript?: string;
  topic?: string;
  protagonist?: string;
};

export type ProgressEvent =
  | { type: "status"; label: string }
  | { type: "scene"; result: SceneResult }
  | { type: "log"; log: RequestLog }
  | { type: "bible"; bible: StoryBible }
  | { type: "checkpoint"; checkpoint: Checkpoint };

export type PipelineInput = {
  scenes: Scene[];
  knownNames?: string[];
  settings: RunSettings;
  /** Danh sách lane theo thứ tự ưu tiên. Dùng chung `scheduler` nếu không truyền `slots`. */
  lanes: Provider[];
  scheduler?: Scheduler;
  /** Lane kèm hạn mức riêng: hàng đợi chung chia lô sang lane nào đang rảnh. */
  slots?: LaneSlot[];
  bible?: StoryBible | null;
  prior?: SceneResult[];
  onlySceneIds?: string[];
  fileName?: string;
  projectId?: string;
  masterScript?: string;
  topic?: string;
  protagonist?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
};

export type RunOutput = {
  results: SceneResult[];
  logs: RequestLog[];
  bible?: StoryBible;
  report: RunReport;
  knownNames: string[];
};

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  if (!items.length) return;
  let cursor = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  async function loop() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => loop()));
}

function createLock() {
  let tail = Promise.resolve();
  return function lock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function neighborsOf(scenes: Scene[], scene: Scene): SceneTask["neighbors"] {
  const index = scenes.findIndex((item) => item.sceneId === scene.sceneId);
  return [scenes[index - 1], scenes[index + 1]].filter((item): item is Scene => Boolean(item)).map((item) => ({
    sceneId: item.sceneId,
    title: item.title,
    source: item.source,
  }));
}

function rejectionLog(rows: { sceneId: string; rejections: Rejection[] }[]) {
  return rows
    .filter((row) => row.rejections.length)
    .map((row) => ({ sceneId: row.sceneId, reasons: row.rejections.map((item) => item.code) }));
}

export async function runPipeline(input: PipelineInput): Promise<RunOutput> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const scenes = input.scenes;
  const knownNames = input.knownNames?.length
    ? input.knownNames
    : extractNames(scenes.map((scene) => scene.source).join("\n"));
  const byId = new Map<string, SceneResult>();
  for (const scene of scenes) byId.set(scene.sceneId, emptyResult(scene));
  for (const prior of input.prior ?? []) {
    if (!byId.has(prior.sceneId)) continue;
    if (prior.status === "accepted" || prior.status === "edited" || prior.prompt || prior.attempts) {
      byId.set(prior.sceneId, prior);
    }
  }
  const only = input.onlySceneIds ? new Set(input.onlySceneIds) : null;
  const logs: RequestLog[] = [];
  let bible = input.bible ?? undefined;
  let fatal: string | undefined;
  let cancelled = false;
  const batchSize = clamp(input.settings.batchSize, 4, 8);
  const concurrency = clamp(input.settings.concurrency, 1, 12);
  const slots: LaneSlot[] =
    input.slots ??
    (input.scheduler ? input.lanes.map((provider) => ({ provider, scheduler: input.scheduler! })) : []);
  const router = createRouter({ slots, now, sleep, signal: input.signal, onLog: (log) => pushLog(log) });
  const maxAttempts = clamp(input.settings.maxAttempts, 1, 5);
  const lock = createLock();

  const resultsNow = () => scenes.map((scene) => byId.get(scene.sceneId)!);

  const checkpoint = (): Checkpoint => ({
    id: input.projectId ?? "project",
    fileName: input.fileName ?? "",
    savedAt: now(),
    scenes,
    knownNames,
    bible,
    results: resultsNow(),
    logs,
  });

  const emitScene = (result: SceneResult) => {
    byId.set(result.sceneId, result);
    input.onProgress?.({ type: "scene", result });
  };

  const pushLog = (log: RequestLog) => {
    logs.push(log);
    input.onProgress?.({ type: "log", log });
  };

  const seenKeys = () => {
    const map = new Map<string, string>();
    for (const row of byId.values()) {
      if ((row.status !== "accepted" && row.status !== "edited") || !row.prompt) continue;
      const key = visualKey(row.environment, row.prompt);
      if (key && !map.has(key)) map.set(key, row.sceneId);
    }
    return map;
  };

  const neighborPrompts = (task: SceneTask) => {
    const ids = new Set(task.neighbors.map((neighbor) => neighbor.sceneId));
    return [...byId.values()]
      .filter((row) => ids.has(row.sceneId) && row.prompt && (row.status === "accepted" || row.status === "edited"))
      .map((row) => ({ sceneId: row.sceneId, prompt: row.prompt }));
  };

  try {
    if (input.settings.bible && !bible) {
      input.onProgress?.({ type: "status", label: "Đang lập story bible" });
      const request = buildBibleRequest({
        digest: bibleDigest(scenes),
        knownNames,
        maxOutputTokens: Math.min(input.settings.maxOutputTokens, 4096),
      });
      const bibleCall = await router.call(request, 1);
      pushLog({
        id: crypto.randomUUID(),
        at: now(),
        lane: bibleCall.response.lane,
        model: bibleCall.response.model,
        kind: "bible",
        sceneIds: [],
        attempt: 1,
        finishReason: bibleCall.response.finishReason,
        promptTokens: bibleCall.response.usage.promptTokens,
        outputTokens: bibleCall.response.usage.outputTokens,
        totalTokens: bibleCall.response.usage.totalTokens,
        latencyMs: bibleCall.latencyMs,
        status: "ok",
        rejections: [],
      });
      bible = parseBiblePayload(bibleCall.response.text);
      input.onProgress?.({ type: "bible", bible });
    }
  } catch (error) {
    if (isAbortError(error)) cancelled = true;
    else fatal = error instanceof Error ? error.message : "Story bible thất bại.";
  }

  let attempt = 1;
  while (!fatal && !cancelled && attempt <= maxAttempts) {
    const queue = scenes.filter((scene) => {
      if (only && !only.has(scene.sceneId)) return false;
      const row = byId.get(scene.sceneId)!;
      if (row.status === "accepted" || row.status === "edited") return false;
      return row.attempts < maxAttempts;
    });
    if (!queue.length) break;
    const size = attempt === 1 ? batchSize : 1;
    await pool(chunk(queue, size), concurrency, async (batch) => {
      if (fatal || cancelled || input.signal?.aborted) {
        cancelled = cancelled || Boolean(input.signal?.aborted);
        return;
      }
      const tasks: SceneTask[] = batch.map((scene) => {
        const previous = byId.get(scene.sceneId)!;
        return {
          sceneId: scene.sceneId,
          title: scene.title,
          source: scene.source,
          likelyPresent: inferPresence(scene.source, knownNames).present,
          neighbors: neighborsOf(scenes, scene),
          feedback: previous.rejections.length
            ? previous.rejections.map((item) => `${item.code}: ${item.detail}`).join(" | ")
            : undefined,
        };
      });
      await lock(async () => {
        for (const scene of batch) {
          const previous = byId.get(scene.sceneId)!;
          emitScene({ ...previous, status: "running" });
        }
      });
      input.onProgress?.({
        type: "status",
        label: `Đang viết cảnh ${batch[0].sceneId}–${batch[batch.length - 1].sceneId} · lần ${attempt}`,
      });
      // Chỉ gửi cửa sổ ngữ cảnh quanh lô (trước đây: tới 20.000 ký tự master script cho MỖI lô).
      const batchIds = batch.map((scene) => scene.sceneId);
      const contextWindow =
        input.settings.fullScript === false
          ? ""
          : input.masterScript?.trim()
            ? windowMasterScript(
                input.masterScript,
                batch[0].source.split("\n").find((line) => line.trim().length > 12) ?? batch[0].source,
                scenes.findIndex((scene) => scene.sceneId === batchIds[0]) / Math.max(1, scenes.length),
              )
            : sceneContextWindow(scenes, batchIds, clamp(input.settings.contextScenes ?? 4, 0, 12));
      const request = buildSceneRequest({
        tasks,
        knownNames,
        bible,
        maxOutputTokens: input.settings.maxOutputTokens,
        temperature: attempt === 1 ? input.settings.temperature ?? 0.7 : 0.2,
        contextWindow,
        topic: input.topic || input.settings.topic,
        protagonist: input.protagonist || input.settings.protagonist,
      });
      let response: GenerateResponse;
      let latencyMs = 0;
      try {
        const called = await router.call(request, attempt);
        response = called.response;
        latencyMs = called.latencyMs;
      } catch (error) {
        if (isAbortError(error)) {
          cancelled = true;
          return;
        }
        const message = error instanceof Error ? error.message : "Lỗi nhà cung cấp.";
        if (error instanceof Error && error.name === "FatalRunError") fatal = message;
        await lock(async () => {
          const rejections: Rejection[] = [{ code: "providerError", detail: message }];
          for (const scene of batch) {
            const previous = byId.get(scene.sceneId)!;
            emitScene({
              ...previous,
              status: "rejected",
              attempts: previous.attempts + 1,
              rejections,
            });
          }
          const ids = batch.map((scene) => scene.sceneId).join();
          const last = logs[logs.length - 1];
          if (last && last.sceneIds.join() === ids && !last.rejections.length) {
            last.rejections = rejectionLog(batch.map((scene) => ({ sceneId: scene.sceneId, rejections })));
            last.status = fatal ? "error" : last.status;
            last.error = last.error ?? message;
          } else {
            pushLog({
              id: crypto.randomUUID(),
              at: now(),
              lane: input.lanes[0]?.lane ?? "mock",
              model: input.lanes[0]?.model ?? "unknown",
              kind: "scenes",
              sceneIds: batch.map((scene) => scene.sceneId),
              attempt,
              finishReason: "error",
              promptTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              latencyMs: 0,
              status: "error",
              error: message,
              rejections: rejectionLog(batch.map((scene) => ({ sceneId: scene.sceneId, rejections }))),
            });
          }
        });
        return;
      }

      await lock(async () => {
        let drafts: SceneDraft[] = [];
        let parseError = "";
        const truncated = /MAX_TOKENS|LENGTH/i.test(response.finishReason);
        try {
          drafts = parseScenePayload(response.text);
        } catch (error) {
          drafts = salvageScenes(response.text);
          if (!drafts.length) parseError = error instanceof Error ? error.message : "JSON lỗi.";
        }
        const knownIds = tasks.map((task) => task.sceneId);
        const buckets = new Map<string, SceneDraft[]>();
        let unknownRows = 0;
        let duplicateRows = 0;
        let autoFixedEndings = 0;
        let rowsAccepted = 0;
        for (const draft of drafts) {
          const id = canonSceneId(draft.scene_id, knownIds);
          if (!id) {
            unknownRows += 1;
            continue;
          }
          const list = buckets.get(id) ?? [];
          if (list.length) duplicateRows += 1;
          list.push({ ...draft, scene_id: id });
          buckets.set(id, list);
        }
        const batchRejections: { sceneId: string; rejections: Rejection[] }[] = [];
        for (const task of tasks) {
          const previous = byId.get(task.sceneId)!;
          const attempts = previous.attempts + 1;
          const rows = buckets.get(task.sceneId) ?? [];
          let rejections: Rejection[] = [];
          let draft: SceneDraft | undefined;
          if (!rows.length) {
            rejections = [
              {
                code: truncated ? "truncated" : parseError ? "unparseable" : "missing",
                detail: truncated
                  ? `Phản hồi bị cắt (finish_reason ${response.finishReason}).`
                  : parseError || "Model bỏ sót cảnh này.",
              },
            ];
          } else {
            // Trùng scene_id: giữ bản hợp lệ đầu tiên thay vì bỏ cả hai.
            let first: { draft: SceneDraft; rejections: Rejection[] } | null = null;
            for (const row of rows) {
              const repaired = repairEnding(row.prompt);
              const candidate = { ...row, prompt: repaired.prompt };
              const verdict = validateDraft(candidate, task, knownNames, neighborPrompts(task), seenKeys());
              if (verdict.ok) {
                draft = candidate;
                if (repaired.fixed) autoFixedEndings += 1;
                break;
              }
              first ??= { draft: candidate, rejections: verdict.rejections };
            }
            if (!draft && first) {
              draft = first.draft;
              rejections = first.rejections;
            }
          }
          const accepted = Boolean(draft) && rejections.length === 0;
          if (accepted) rowsAccepted += 1;
          emitScene({
            sceneId: task.sceneId,
            status: accepted ? "accepted" : "rejected",
            attempts,
            title: draft?.title || previous.title,
            environment: draft?.environment || "",
            prompt: draft?.prompt || "",
            visibleCast: draft?.visible_cast || [],
            sourceAnchor: draft?.source_anchor || "",
            cameraAngle: draft?.camera_angle || previous.cameraAngle,
            shotSequence: draft?.shot_sequence || previous.shotSequence,
            visualAction: draft?.visual_action || previous.visualAction,
            rejections,
            model: response.model,
            lane: response.lane,
          });
          batchRejections.push({ sceneId: task.sceneId, rejections });
        }
        pushLog({
          id: crypto.randomUUID(),
          at: now(),
          lane: response.lane,
          model: response.model,
          kind: "scenes",
          sceneIds: knownIds,
          attempt,
          finishReason: response.finishReason,
          promptTokens: response.usage.promptTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          latencyMs,
          status: "ok",
          rejections: rejectionLog(batchRejections),
          rowsReturned: drafts.length,
          rowsAccepted,
          duplicateRows,
          unknownRows,
          autoFixedEndings,
          truncated,
          neurons: response.neurons,
        });
        input.onProgress?.({ type: "checkpoint", checkpoint: checkpoint() });
      });
    });
    if (input.signal?.aborted) cancelled = true;
    attempt += 1;
  }

  for (const scene of scenes) {
    const row = byId.get(scene.sceneId)!;
    if (cancelled || fatal) {
      if (row.status === "running") emitScene({ ...row, status: "pending" });
      continue;
    }
    if (row.status === "rejected" || row.status === "missing" || row.status === "running") {
      emitScene({ ...row, status: "failed" });
    }
  }

  const results = resultsNow();
  const report = buildReport({
    results,
    logs,
    startedAt,
    finishedAt: now(),
    bible: Boolean(input.settings.bible),
    cancelled,
    fatalError: fatal,
  });
  const done = checkpoint();
  done.report = report;
  input.onProgress?.({ type: "checkpoint", checkpoint: done });
  return { results, logs, bible, report, knownNames };
}

export function buildReport(args: {
  results: SceneResult[];
  logs: RequestLog[];
  startedAt: number;
  finishedAt: number;
  bible: boolean;
  cancelled: boolean;
  fatalError?: string;
}): RunReport {
  const sceneCount = args.results.length || 1;
  const accepted = args.results.filter((row) => row.status === "accepted").length;
  const edited = args.results.filter((row) => row.status === "edited").length;
  const failed = args.results.filter((row) => row.status === "failed" || row.status === "rejected").length;
  const missing = args.results.filter((row) => row.status === "missing" || row.status === "pending").length;
  const rejectionsByReason: Record<string, number> = {};
  for (const log of args.logs) {
    for (const row of log.rejections) {
      for (const reason of row.reasons) rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + 1;
    }
  }
  const tokens = args.logs.reduce(
    (sum, log) => ({
      prompt: sum.prompt + log.promptTokens,
      output: sum.output + log.outputTokens,
      total: sum.total + log.totalTokens,
    }),
    { prompt: 0, output: 0, total: 0 },
  );
  const models: Record<string, number> = {};
  const lanes: Record<string, number> = {};
  for (const log of args.logs) {
    if (log.status !== "ok") continue;
    models[log.model] = (models[log.model] ?? 0) + 1;
    lanes[log.lane] = (lanes[log.lane] ?? 0) + 1;
  }
  return {
    telemetry: buildTelemetry(args.logs, accepted),
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    wallTimeMs: Math.max(0, args.finishedAt - args.startedAt),
    sceneCount: args.results.length,
    accepted,
    edited,
    failed,
    missing,
    acceptedPct: args.results.length ? Math.round((accepted / sceneCount) * 1000) / 10 : 0,
    usablePct: args.results.length ? Math.round(((accepted + edited) / sceneCount) * 1000) / 10 : 0,
    rejectionsByReason,
    tokens: {
      prompt: Math.round(tokens.prompt),
      output: Math.round(tokens.output),
      total: Math.round(tokens.total),
    },
    requests: args.logs.length,
    rejectionEvents: Object.values(rejectionsByReason).reduce((sum, count) => sum + count, 0),
    models,
    lanes,
    bible: args.bible,
    cancelled: args.cancelled,
    fatalError: args.fatalError,
  };
}

function emptyLane(): LaneTelemetry {
  return { requests: 0, ok: 0, errors: 0, rateLimited: 0, rowsReturned: 0, rowsAccepted: 0, outputTokens: 0, promptTokens: 0, neurons: 0 };
}

export function buildTelemetry(logs: RequestLog[], acceptedScenes: number): RunTelemetry {
  const byLane: Record<string, LaneTelemetry> = {};
  let rowsReturned = 0;
  let rowsAccepted = 0;
  let truncatedResponses = 0;
  let duplicateRows = 0;
  let unknownRows = 0;
  let autoFixedEndings = 0;
  let neurons = 0;
  let outputTokens = 0;
  for (const log of logs) {
    const lane = (byLane[log.lane] ??= emptyLane());
    lane.requests += 1;
    if (log.status === "ok") lane.ok += 1;
    else if (log.status === "rate_limited") lane.rateLimited += 1;
    else lane.errors += 1;
    lane.rowsReturned += log.rowsReturned ?? 0;
    lane.rowsAccepted += log.rowsAccepted ?? 0;
    lane.outputTokens += log.outputTokens;
    lane.promptTokens += log.promptTokens;
    lane.neurons += log.neurons ?? 0;
    rowsReturned += log.rowsReturned ?? 0;
    rowsAccepted += log.rowsAccepted ?? 0;
    if (log.truncated) truncatedResponses += 1;
    duplicateRows += log.duplicateRows ?? 0;
    unknownRows += log.unknownRows ?? 0;
    autoFixedEndings += log.autoFixedEndings ?? 0;
    neurons += log.neurons ?? 0;
    outputTokens += log.outputTokens;
  }
  for (const lane of Object.values(byLane)) lane.neurons = Math.round(lane.neurons);
  return {
    rowsReturned,
    rowsAccepted,
    rowAcceptancePct: rowsReturned ? Math.round((rowsAccepted / rowsReturned) * 1000) / 10 : 0,
    truncatedResponses,
    duplicateRows,
    unknownRows,
    autoFixedEndings,
    outputTokensPerAccepted: acceptedScenes ? Math.round(outputTokens / acceptedScenes) : 0,
    neurons: Math.round(neurons),
    byLane,
  };
}
