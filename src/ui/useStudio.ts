import { useEffect, useMemo, useRef, useState } from "react";
import { extractNames, inferPresence, splitExtraNames } from "../core/cast.js";
import { buildScenes, type ChunkMode } from "../core/chunk.js";
import { FatalRunError } from "../core/errors.js";
import type { FlowOptions } from "../core/export.js";
import { toCopyText } from "../core/export.js";
import { buildExport, type ExportKind } from "../core/exportKinds.js";
import type { Checkpoint } from "../core/pipeline.js";
import { runPipeline } from "../core/pipeline.js";
import { createAbortableSleep, utcDay } from "../core/scheduler.js";
import { parseSrt } from "../core/srt.js";
import type { RequestLog, RunReport, Scene, SceneResult, StoryBible } from "../core/types.js";
import { emptyResult, hashString } from "../core/types.js";
import { pickAnchor } from "../core/providers/mock.js";
import { validateDraft, visualKey } from "../core/validators.js";
import { isUsable } from "../core/keys.js";
import type { JobSummary } from "../server/jobs.js";
import { buildLanes, buildSlots, type ServerHealth } from "./lanes.js";
import {
  loadCheckpoint,
  loadLaneUsage,
  loadSettings,
  loadTheme,
  loadUsage,
  saveCheckpoint,
  saveLaneUsage,
  saveSettings,
  saveTheme,
  saveUsage,
  type Settings,
} from "./storage.js";

export type Phase = "idle" | "ready" | "running" | "done" | "error";

const JOB_KEY = "storyprompt.job.v1";
const JOB_SEEN_KEY = "storyprompt.jobSeen.v1";
export type JobNotice = { id: string; tone: "ok" | "warn"; text: string; elapsedMs: number; canResume: boolean };

const RUNNING = new Set(["running", "queued"]);

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} phút ${seconds} giây` : `${seconds} giây`;
}

function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function lsSet(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* bỏ qua */
  }
}

function projectId(fileName: string, text: string) {
  const slug = fileName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kich-ban";
  return `${hashString(text)}-${slug}`;
}

export function useStudio() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [theme, setTheme] = useState<"dark" | "light">(() => loadTheme());
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [fileName, setFileName] = useState("");
  const [project, setProject] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [results, setResults] = useState<SceneResult[]>([]);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [bible, setBible] = useState<StoryBible | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("Sẵn sàng");
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(Date.now());
  const [toast, setToast] = useState("");
  const [resumeOffer, setResumeOffer] = useState<Checkpoint | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "accepted" | "attention">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [fileKind, setFileKind] = useState<"srt" | "txt">("srt");
  const [chunkMode, setChunkMode] = useState<ChunkMode>("headings");
  const [duration, setDuration] = useState(8);
  const [masterScript, setMasterScript] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [usage, setUsage] = useState(() => loadUsage());
  const abortRef = useRef<AbortController | null>(null);
  // Chạy nền ở server: trình duyệt chỉ theo dõi.
  const [job, setJob] = useState<JobSummary | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [jobNotice, setJobNotice] = useState<JobNotice | null>(null);
  const jobRev = useRef(0);
  const jobAttached = useRef("");
  const [lastMode, setLastMode] = useState<"mock" | "live">("mock");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setHealth(body as ServerHealth | null))
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => setTick(Date.now()), 400);
    return () => window.clearInterval(timer);
  }, [phase]);

  // Mở lại trang: nối lại lượt chạy gần nhất (đang chạy hoặc đã xong) để nhận kết quả.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("fixture")) return;
    void (async () => {
      let id = lsGet(JOB_KEY);
      if (!id) {
        try {
          const response = await fetch("/api/jobs", { cache: "no-store" });
          const list = response.ok ? ((await response.json()) as { jobs: JobSummary[] }).jobs : [];
          // Chưa từng mở: chỉ tự nối nếu có lượt đang chạy.
          id = list.find((item) => RUNNING.has(item.status))?.id ?? "";
        } catch {
          id = "";
        }
      }
      if (id) await attachJob(id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!job || !RUNNING.has(job.status)) return;
    const id = job.id;
    const timer = window.setInterval(() => void fetchJob(id, false), 1500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  useEffect(() => {
    const restore = () => {
      if (!document.hidden && document.title.startsWith("✅")) document.title = "StoryPrompt";
    };
    document.addEventListener("visibilitychange", restore);
    return () => document.removeEventListener("visibilitychange", restore);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const doneCount = results.filter((row) => row.status === "accepted" || row.status === "edited" || row.status === "failed").length;

  const knownNames = useMemo(() => {
    const merged = [...names];
    for (const extra of splitExtraNames(settings.extraNames)) {
      if (!merged.some((item) => item.localeCompare(extra, "vi", { sensitivity: "accent" }) === 0)) merged.push(extra);
    }
    return merged;
  }, [names, settings.extraNames]);

  function applyParsed(name: string, text: string, mode: ChunkMode, seconds: number, kind: "srt" | "txt") {
    const parsed = buildScenes(text, {
      mode: kind === "txt" ? "fixed" : mode,
      duration: seconds,
      kind,
      txtMode: mode === "sense" ? "by_sentences" : "by_line",
    });
    if (!parsed.scenes.length) {
      setError(kind === "txt" ? "File TXT không có dòng chữ." : "Không tách được cảnh nào. Kiểm tra lại file.");
      setPhase("error");
      return;
    }
    const detected = extractNames(parsed.scenes.map((scene) => scene.source).join("\n"), splitExtraNames(settings.extraNames));
    // File mới: bỏ nối với lượt chạy nền cũ (lượt đó vẫn chạy ở server, mở lại từ Lịch sử).
    jobAttached.current = "";
    lsSet(JOB_KEY, "");
    setJob(null);
    setJobNotice(null);
    setFileName(name);
    setProject(projectId(name, text));
    setRawText(text);
    setFileKind(kind);
    setChunkMode(kind === "txt" ? mode : mode);
    setDuration(seconds);
    setWarnings(parsed.warnings);
    setScenes(parsed.scenes);
    setNames(detected);
    setResults(parsed.scenes.map(emptyResult));
    setLogs([]);
    setReport(null);
    setBible(null);
    setError("");
    setPhase("ready");
    setLabel(`${parsed.scenes.length} cảnh đã cắt`);
  }

  async function ingest(name: string, text: string) {
    const kind: "srt" | "txt" = /\.txt$/i.test(name) || !text.includes("-->") ? "txt" : "srt";
    const hasHeadings = kind === "srt" && parseSrt(text).scenes.some((scene) => scene.heading);
    const mode: ChunkMode = kind === "txt" ? "fixed" : hasHeadings ? "headings" : "fixed";
    applyParsed(name, text, mode, duration, kind);
    const saved = await loadCheckpoint(projectId(name, text));
    const usable = saved?.results.some((row) => row.status === "accepted" || row.status === "edited" || row.attempts > 0);
    setResumeOffer(usable ? saved : null);
  }

  function applyCheckpoint(saved: Checkpoint) {
    setScenes(saved.scenes);
    setNames(saved.knownNames);
    setResults(saved.results);
    setLogs(saved.logs);
    setBible(saved.bible ?? null);
    setReport(saved.report ?? null);
    if (saved.masterScript) setMasterScript(saved.masterScript);
    if (saved.topic) setSettings((current) => ({ ...current, topic: saved.topic || current.topic }));
    if (saved.protagonist) setSettings((current) => ({ ...current, protagonist: saved.protagonist || current.protagonist }));
    setPhase(saved.report ? "done" : "ready");
    setLabel("Đã mở bản lưu");
    setResumeOffer(null);
  }

  async function onFile(file: File) {
    const text = await file.text();
    await ingest(file.name, text);
  }

  async function loadSample() {
    const response = await fetch("/samples/nha-ben-song-20.srt");
    if (!response.ok) {
      setError("Không tải được file mẫu.");
      return;
    }
    await ingest("nha-ben-song-20.srt", await response.text());
  }

  function removeName(name: string) {
    setNames((current) => current.filter((item) => item !== name));
  }

  function addName(name: string) {
    const next = name.trim();
    if (!next) return;
    setNames((current) => (current.some((item) => item.localeCompare(next, "vi", { sensitivity: "accent" }) === 0) ? current : [...current, next]));
  }

  /** Gom cập nhật từ server vào state: cảnh bạn đã sửa tay (edited) không bị ghi đè. */
  function applyJob(payload: Record<string, unknown>, first: boolean) {
    const summary = payload.summary as JobSummary;
    setJob(summary);
    const running = RUNNING.has(summary.status);
    if (running) setStartedAt(Date.now() - summary.elapsedMs);
    if (!payload.unchanged) {
      jobRev.current = summary.rev;
      const serverResults = (payload.results as SceneResult[]) ?? [];
      if (first) {
        setScenes((payload.scenes as Scene[]) ?? []);
        setFileName(summary.fileName);
        setProject(summary.id);
        setRawText("");
        setWarnings([]);
        setBible(null);
        setResumeOffer(null);
        setResults(serverResults);
      } else {
        setResults((current) => serverResults.map((row) => (current.find((item) => item.sceneId === row.sceneId)?.status === "edited" ? current.find((item) => item.sceneId === row.sceneId)! : row)));
      }
      setLogs((payload.logs as RequestLog[]) ?? []);
      setReport((payload.report as RunReport | undefined) ?? null);
      setNames((payload.knownNames as string[]) ?? []);
    }
    setLastMode(summary.mode);
    setLabel(summary.label);
    if (running) {
      setPhase("running");
      return;
    }
    setPhase("done");
    setError(summary.status === "error" ? summary.error ?? "" : "");
    // Thông báo xong: hiện một lần cho mỗi lượt chạy (kể cả khi bạn mở lại tab sau đó).
    if (lsGet(JOB_SEEN_KEY) !== summary.id) {
      const text =
        summary.status === "done"
          ? `Xong lượt chạy · ${summary.accepted}/${summary.sceneCount} cảnh đạt · ${formatElapsed(summary.elapsedMs)}`
          : summary.status === "cancelled"
            ? `Đã dừng · ${summary.accepted}/${summary.sceneCount} cảnh đạt · ${formatElapsed(summary.elapsedMs)}`
            : summary.status === "interrupted"
              ? `Server đã khởi động lại giữa chừng · ${summary.accepted}/${summary.sceneCount} cảnh đã xong`
              : `Lượt chạy dừng vì lỗi · ${summary.accepted}/${summary.sceneCount} cảnh đạt${summary.error ? ` · ${summary.error.slice(0, 120)}` : ""}`;
      setJobNotice({ id: summary.id, tone: summary.status === "done" && summary.failed === 0 ? "ok" : "warn", text, elapsedMs: summary.elapsedMs, canResume: summary.status !== "done" || summary.failed > 0 });
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
          new Notification("StoryPrompt", { body: text });
        }
        if (document.hidden) document.title = `✅ ${text.slice(0, 60)}`;
      } catch {
        /* thông báo hệ thống không bắt buộc */
      }
    }
  }

  async function fetchJob(id: string, first: boolean): Promise<boolean> {
    try {
      const response = await fetch(`/api/jobs/${id}${first ? "" : `?rev=${jobRev.current}`}`, { cache: "no-store" });
      if (response.status === 404) return false;
      if (!response.ok) return true;
      applyJob((await response.json()) as Record<string, unknown>, first);
      return true;
    } catch {
      setLabel("Mất kết nối server, đang thử lại…");
      return true;
    }
  }

  async function attachJob(id: string) {
    jobAttached.current = id;
    jobRev.current = 0;
    lsSet(JOB_KEY, id);
    setHistoryOpen(false);
    const found = await fetchJob(id, true);
    if (!found) {
      lsSet(JOB_KEY, "");
      jobAttached.current = "";
      setToast("Không tìm thấy lượt chạy này nữa");
    }
  }

  async function refreshJobs() {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      if (response.ok) setJobs(((await response.json()) as { jobs: JobSummary[] }).jobs);
    } catch {
      /* bỏ qua */
    }
  }

  function jobKeys() {
    return settings.keys.filter(isUsable).map((item) => ({ id: item.id, provider: item.provider, label: item.label, key: item.key, account: item.account, enabled: true }));
  }

  function jobSettings() {
    // Khóa gửi riêng trong `keys` (chỉ nằm trong bộ nhớ server); phần còn lại là cài đặt chạy.
    const { keys: _keys, directBrowser: _direct, ...rest } = settings;
    return rest;
  }

  async function startJob(scope?: { fresh?: boolean; prior?: SceneResult[] }) {
    if (!scenes.length || phase === "running") return;
    setError("");
    setJobNotice(null);
    setLabel("Đang gửi lên server…");
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    } catch {
      /* bỏ qua */
    }
    try {
      const prior = scope?.fresh ? [] : scope?.prior ?? results;
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileName,
          mode: "live",
          scenes,
          knownNames,
          masterScript: masterScript || undefined,
          settings: jobSettings(),
          keys: jobKeys(),
          prior: prior.filter((row) => (row.status === "accepted" || row.status === "edited") && row.prompt),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !body.id) {
        setError(body.error || `Server từ chối (HTTP ${response.status}).`);
        if (/khóa|key/i.test(body.error ?? "")) setSettingsOpen(true);
        setPhase("ready");
        return;
      }
      setLastMode("live");
      setPhase("running");
      setStartedAt(Date.now());
      setLabel("Đã giao cho server chạy nền. Bạn có thể đóng tab.");
      setToast("Đang chạy nền ở server. Đóng tab cũng được.");
      await attachJob(body.id);
    } catch (caught) {
      setError(caught instanceof Error ? `Không gọi được server: ${caught.message}` : "Không gọi được server.");
      setPhase("ready");
    }
  }

  async function resumeJob(id: string) {
    setJobNotice(null);
    try {
      const response = await fetch(`/api/jobs/${id}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: jobKeys(), settings: jobSettings() }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error || `Server từ chối (HTTP ${response.status}).`);
        return;
      }
      setError("");
      await attachJob(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không chạy tiếp được.");
    }
  }

  async function cancelJob() {
    const id = jobAttached.current;
    if (!id) return;
    try {
      await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
    } catch {
      /* lần poll sau sẽ báo trạng thái */
    }
  }

  async function deleteJob(id: string) {
    try {
      const response = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      if (response.ok && jobAttached.current === id) {
        jobAttached.current = "";
        lsSet(JOB_KEY, "");
        setJob(null);
      }
    } catch {
      /* bỏ qua */
    }
    await refreshJobs();
  }

  function dismissNotice() {
    if (jobNotice) lsSet(JOB_SEEN_KEY, jobNotice.id);
    setJobNotice(null);
  }

  async function run(mode: "mock" | "live", scope?: { only?: string[]; fresh?: boolean; prior?: SceneResult[] }) {
    if (!scenes.length || phase === "running") return;
    // Chạy cả file với khóa thật → server chạy nền (đóng tab vẫn chạy). Mô phỏng và viết lại 1 cảnh vẫn chạy ngay trên trình duyệt.
    if (mode === "live" && !scope?.only) return startJob(scope);
    const lanes = buildLanes(settings, health, mode);
    if (!lanes.length) {
      setError("Chưa có khóa API. Dán khóa trong Cài đặt, hoặc bấm Chạy mô phỏng.");
      setSettingsOpen(true);
      setPhase(scenes.length ? "ready" : "error");
      return;
    }
    setLastMode(mode);
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setError("");
    setStartedAt(Date.now());
    setLabel(mode === "mock" ? "Đang mô phỏng pipeline" : "Đang gửi lô đầu");
    const sleep = createAbortableSleep(controller.signal);
    try {
      const output = await runPipeline({
        scenes,
        knownNames,
        settings,
        lanes,
        slots: buildSlots(settings, lanes, {
          mode,
          sleep,
          usage: loadLaneUsage,
          onUsage: (lane, next) => {
            saveLaneUsage(lane, next);
            if (lane === (lanes[0]?.usageKey ?? lanes[0]?.lane)) {
              const day = { dayKey: next.dayKey, count: next.count };
              saveUsage(day);
              setUsage(day);
            }
          },
        }),
        bible,
        prior: scope?.fresh ? [] : scope?.prior ?? results,
        onlySceneIds: scope?.only,
        fileName,
        projectId: project,
        masterScript,
        topic: settings.topic,
        protagonist: settings.protagonist,
        signal: controller.signal,
        sleep,
        onProgress: (event) => {
          if (event.type === "status") setLabel(event.label);
          if (event.type === "scene") {
            setResults((current) => {
              const next = current.length ? [...current] : scenes.map(emptyResult);
              const index = next.findIndex((row) => row.sceneId === event.result.sceneId);
              if (index >= 0) next[index] = event.result;
              return next;
            });
          }
          if (event.type === "log") setLogs((current) => [...current, event.log]);
          if (event.type === "bible") setBible(event.bible);
          if (event.type === "checkpoint") {
            void saveCheckpoint({
              ...event.checkpoint,
              masterScript,
              topic: settings.topic,
              protagonist: settings.protagonist,
            });
          }
        },
      });
      setResults(output.results);
      setLogs(output.logs);
      setReport(output.report);
      setBible(output.bible ?? null);
      setNames(output.knownNames);
      if (output.report.fatalError) {
        setError(output.report.fatalError);
        setPhase("error");
      } else {
        setPhase("done");
        setLabel(output.report.cancelled ? "Đã dừng. Bản lưu giữ phần đã xong." : "Xong lượt chạy");
      }
    } catch (caught) {
      const raw = caught instanceof FatalRunError || caught instanceof Error ? caught.message : "Lượt chạy dừng.";
      const message = /503|UNAVAILABLE|high demand/i.test(raw)
        ? "Mô hình đang quá tải (503). Thử lại sau vài giây. Quá tải không tự đổi model, để chất lượng không bị trượt."
        : /429|RESOURCE_EXHAUSTED|trần request/i.test(raw)
          ? "Đã chạm hạn mức. Đợi rồi bấm chạy tiếp. Phần đã đạt vẫn nằm trong bản lưu."
          : raw;
      if (controller.signal.aborted) {
        setPhase("done");
        setLabel("Đã dừng");
      } else {
        setError(message);
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  function stop() {
    if (abortRef.current) abortRef.current.abort();
    else void cancelJob();
  }

  async function saveEdit(sceneId: string, patch: { title: string; environment: string; prompt: string; cast: string }) {
    const scene = scenes.find((item) => item.sceneId === sceneId);
    const current = results.find((item) => item.sceneId === sceneId);
    if (!scene || !current) return false;
    const visibleCast = splitExtraNames(patch.cast);
    const index = scenes.findIndex((item) => item.sceneId === sceneId);
    const neighbors = [scenes[index - 1], scenes[index + 1]].filter((item): item is Scene => Boolean(item));
    const keys = new Map<string, string>();
    for (const row of results) {
      if (row.sceneId === sceneId || !row.prompt) continue;
      const key = visualKey(row.environment, row.prompt);
      if (key) keys.set(key, row.sceneId);
    }
    const verdict = validateDraft(
      {
        scene_id: sceneId,
        title: patch.title,
        environment: patch.environment,
        prompt: patch.prompt,
        visible_cast: visibleCast,
        source_anchor: current.sourceAnchor || pickAnchor(scene.source),
      },
      {
        sceneId,
        title: patch.title,
        source: scene.source,
        likelyPresent: inferPresence(scene.source, knownNames).present,
        neighbors: neighbors.map((item) => ({ sceneId: item.sceneId, title: item.title, source: item.source })),
      },
      knownNames,
      neighbors
        .map((item) => results.find((row) => row.sceneId === item.sceneId))
        .filter((row): row is SceneResult => Boolean(row?.prompt))
        .map((row) => ({ sceneId: row.sceneId, prompt: row.prompt })),
      keys,
    );
    const next: SceneResult = {
      ...current,
      title: patch.title,
      environment: patch.environment,
      prompt: patch.prompt,
      visibleCast,
      status: patch.prompt.trim() ? (verdict.ok ? "accepted" : "edited") : "pending",
      rejections: verdict.rejections,
    };
    const updated = results.map((row) => (row.sceneId === sceneId ? next : row));
    setResults(updated);
    setEditing(null);
    const stored = await saveCheckpoint({
      id: project,
      fileName,
      savedAt: Date.now(),
      scenes,
      knownNames,
      bible: bible ?? undefined,
      results: updated,
      logs,
      report: report ?? undefined,
    });
    setToast(stored ? (verdict.ok ? "Đã lưu cảnh" : "Đã lưu, còn cảnh báo") : "Không lưu được bản nháp");
    return stored;
  }

  function flowOptions(): FlowOptions {
    return { prefix: settings.prefix, footer: settings.footer, roster: knownNames, aspectRatio: settings.aspectRatio, arSuffix: settings.arSuffix };
  }

  async function copyAll() {
    const text = toCopyText(scenes, results, flowOptions());
    if (!text) {
      setToast("Chưa có prompt để chép");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setToast("Đã chép toàn bộ prompt");
    } catch {
      setToast("Trình duyệt chặn clipboard");
    }
  }

  function download(kind: ExportKind) {
    const file = buildExport(kind, { fileName, scenes, results, options: flowOptions(), names: knownNames, bible, masterScript, report, logs });
    if (!file) {
      setToast("Chưa có nội dung để tải");
      return;
    }
    const blob = new Blob([file.body], { type: file.mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  const elapsed = phase === "running" && startedAt ? tick - startedAt : job && jobAttached.current === job.id ? job.elapsedMs : report?.wallTimeMs ?? 0;

  return {
    settings,
    setSettings,
    theme,
    setTheme,
    health,
    fileName,
    warnings,
    scenes,
    names,
    knownNames,
    results,
    logs,
    report,
    bible,
    phase,
    error,
    label,
    elapsed,
    toast,
    resumeOffer,
    settingsOpen,
    setSettingsOpen,
    filter,
    setFilter,
    editing,
    setEditing,
    usage,
    dayKey: utcDay(Date.now()),
    lastMode,
    doneCount,
    rawText,
    fileKind,
    chunkMode,
    duration,
    masterScript,
    setMasterScript,
    guideOpen,
    setGuideOpen,
    recut: (mode: ChunkMode, seconds = duration) => {
      if (!rawText || !fileName) return;
      applyParsed(fileName, rawText, mode, seconds, fileKind);
      setToast(`Đã cắt lại: ${mode === "headings" ? "theo tiêu đề cảnh" : mode === "sense" ? "cụm nghĩa" : `${seconds}s`}`);
    },
    onFile,
    loadSample,
    removeName,
    addName,
    applyCheckpoint,
    dismissResume: () => setResumeOffer(null),
    run,
    stop,
    saveEdit,
    copyAll,
    download,
    project,
    job,
    jobs,
    jobNotice,
    dismissNotice,
    historyOpen,
    openHistory: () => {
      setHistoryOpen(true);
      void refreshJobs();
    },
    closeHistory: () => setHistoryOpen(false),
    refreshJobs,
    attachJob,
    resumeJob,
    deleteJob,
  };
}
