import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowSceneJob } from "../server/flow/imageJobs.js";

export type FlowStatus = {
  chrome: boolean;
  browserOpen: boolean;
  signedIn: boolean | null;
  url?: string;
  inProject?: boolean;
  config: { projectUrl: string; model: string; gapMinSec: number; gapMaxSec: number; aspect: string };
  quota: Record<"nb2" | "pro", { used: number; limit: number; left: number; resetAt?: number }>;
  models: { id: string; label: string }[];
  activeJob: string | null;
};

export type FlowJobSummary = {
  id: string;
  label: string;
  createdAt: number;
  status: "queued" | "running" | "waiting" | "paused" | "done" | "cancelled" | "interrupted";
  model: string;
  total: number;
  done: number;
  failed: number;
  pending: number;
  skipped: number;
  images: number;
  pauseReason?: string;
  pauseKind?: string;
  nextAt?: number;
  current?: string;
  elapsedMs: number;
  rev: number;
};

export type FlowJobFull = { id: string; label: string; model: string; modelLabel: string; scenes: FlowSceneJob[]; logs: { at: number; text: string }[] };

const RUNNING = new Set(["queued", "running", "waiting"]);
const keyFor = (project: string) => `storyprompt.flowJob.${project || "none"}`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Lỗi ${response.status}`);
  return body;
}

export function imageUrl(jobId: string, file: string, download = false) {
  return `/api/flow/img/${encodeURIComponent(jobId)}/${encodeURIComponent(file)}${download ? "?download=1" : ""}`;
}

/** Trạng thái nút "Tạo ảnh" (Flow chạy nền ở server; đóng tab vẫn chạy). */
export function useFlow(project: string) {
  const [status, setStatus] = useState<FlowStatus | null>(null);
  const [jobId, setJobId] = useState("");
  const [summary, setSummary] = useState<FlowJobSummary | null>(null);
  const [job, setJob] = useState<FlowJobFull | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rev = useRef(-1);

  useEffect(() => {
    try {
      setJobId(localStorage.getItem(keyFor(project)) ?? "");
    } catch {
      setJobId("");
    }
    setSummary(null);
    setJob(null);
    rev.current = -1;
  }, [project]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await call<FlowStatus>("/api/flow/status"));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, []);

  const fetchJob = useCallback(async (id: string) => {
    try {
      const body = await call<{ unchanged?: boolean; summary: FlowJobSummary; job?: FlowJobFull }>(`/api/flow/jobs/${id}?rev=${rev.current}`);
      setSummary(body.summary);
      if (!body.unchanged && body.job) {
        setJob(body.job);
        rev.current = body.summary.rev;
      }
    } catch (problem) {
      if (problem instanceof Error && /Không tìm thấy/.test(problem.message)) {
        setJobId("");
        setSummary(null);
        setJob(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    void fetchJob(jobId);
  }, [jobId, fetchJob]);

  // Job đang chạy ở server nhưng trình duyệt này chưa lưu id (tab mới, xoá dữ liệu, chạy từ API): nhận lại.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    if (jobId || !status?.activeJob) return;
    remember(status.activeJob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status?.activeJob]);

  const running = Boolean(summary && RUNNING.has(summary.status));
  useEffect(() => {
    if (!jobId || !running) return;
    const timer = window.setInterval(() => void fetchJob(jobId), 2500);
    return () => window.clearInterval(timer);
  }, [jobId, running, fetchJob]);

  function remember(id: string) {
    setJobId(id);
    rev.current = -1;
    try {
      if (id) localStorage.setItem(keyFor(project), id);
      else localStorage.removeItem(keyFor(project));
    } catch {
      /* bỏ qua */
    }
  }

  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      return undefined;
    } finally {
      setBusy(false);
      void refreshStatus();
    }
  }

  return {
    status,
    jobId,
    summary,
    job,
    error,
    busy,
    running,
    setError,
    refreshStatus,
    connect: () => act(() => call("/api/flow/connect", { method: "POST", body: "{}" })),
    useCurrent: () => act(() => call("/api/flow/use-current", { method: "POST", body: "{}" })),
    setConfig: (patch: Partial<FlowStatus["config"]>) => act(() => call("/api/flow/config", { method: "POST", body: JSON.stringify(patch) })),
    checkRefs: (names: string[]) => act(() => call<{ found: Record<string, boolean> }>("/api/flow/check-refs", { method: "POST", body: JSON.stringify({ names }) })),
    start: (label: string, model: string, scenes: { sceneId: string; prompt: string; references: string[] }[]) =>
      act(async () => {
        const body = await call<{ id: string }>("/api/flow/jobs", { method: "POST", body: JSON.stringify({ label, model, scenes }) });
        remember(body.id);
        await fetchJob(body.id);
        return body.id;
      }),
    cancel: () => (jobId ? act(() => call(`/api/flow/jobs/${jobId}/cancel`, { method: "POST", body: "{}" }).then(() => fetchJob(jobId))) : undefined),
    resume: (retryFailed = false) => (jobId ? act(() => call(`/api/flow/jobs/${jobId}/resume`, { method: "POST", body: JSON.stringify({ retryFailed }) }).then(() => fetchJob(jobId))) : undefined),
    regen: (sceneId: string, prompt?: string, references?: string[]) =>
      jobId ? act(() => call(`/api/flow/jobs/${jobId}/scenes/${encodeURIComponent(sceneId)}/regen`, { method: "POST", body: JSON.stringify({ prompt, references }) }).then(() => fetchJob(jobId))) : undefined,
    skip: (sceneId: string) => (jobId ? act(() => call(`/api/flow/jobs/${jobId}/scenes/${encodeURIComponent(sceneId)}/skip`, { method: "POST", body: "{}" }).then(() => fetchJob(jobId))) : undefined),
    forget: () => remember(""),
    sceneImages: (sceneId: string) => job?.scenes.find((scene) => scene.sceneId === sceneId) ?? null,
  };
}

export type FlowHook = ReturnType<typeof useFlow>;
