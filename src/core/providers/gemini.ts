import { parseRetryAfter, ProviderError } from "../errors.js";
import { relaxSceneSchema } from "../prompts.js";
import { buildGeminiBody } from "../prompts.js";
import type { GenerateRequest, GenerateResponse, ProviderLane } from "../types.js";

/**
 * Chuỗi model giống app AI Studio "Kịch bản fin" (server.ts):
 * ACTIVE_TEXT_MODELS = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'].
 */
export const ACTIVE_GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-4-hydrogen"];

/** Model đã nghỉ hưu hoặc hay 503/404 — lọc ra như AI Studio. */
export const RETIRED_MODEL_PATTERNS = [
  /^gemini-1\./,
  /^gemini-2\./,
  /^gemini-pro$/,
  /^gemini-3-flash/,
  /^gemini-3\.[568]-flash$/,
  /^gemini-3\.5-flash-lite$/,
  /^gemini-flash-(lite-)?latest$/,
];

export const COOLDOWN_MS = {
  rateLimited: 5 * 60_000,
  unavailable: 2 * 60_000,
  missing: 60 * 60_000,
};

export const FIRST_TOKEN_MS = { first: 12_000, later: 25_000 };
const UNARY_TIMEOUT_MS = 25_000;
const STREAM_TOTAL_MS = 120_000;

export function isRetiredModel(model: string): boolean {
  const name = model.trim().replace(/^models\//, "");
  return RETIRED_MODEL_PATTERNS.some((pattern) => pattern.test(name));
}

export function resolveGeminiModels(requested: string[]): string[] {
  const cleaned = [...new Set(requested.map((model) => model.trim().replace(/^models\//, "")).filter(Boolean))].filter(
    (model) => !isRetiredModel(model),
  );
  return cleaned.length ? cleaned : [...ACTIVE_GEMINI_MODELS];
}

export function backoffMs(round: number, random: () => number = Math.random): number {
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, round - 1)) + Math.floor(random() * 400);
}

/** Ngắt mạch theo model, dùng chung trong một tiến trình (server) hoặc một tab (trình duyệt). */
export type ModelBreaker = {
  coolUntil: (model: string) => number;
  mark: (model: string, ms: number) => void;
  clear: (model: string) => void;
};

export function createModelBreaker(now: () => number = () => Date.now()): ModelBreaker {
  const map = new Map<string, number>();
  return {
    coolUntil: (model) => {
      const until = map.get(model) ?? 0;
      if (until && until <= now()) map.delete(model);
      return map.get(model) ?? 0;
    },
    mark: (model, ms) => map.set(model, Math.max(map.get(model) ?? 0, now() + ms)),
    clear: (model) => map.delete(model),
  };
}

const sharedBreaker = createModelBreaker();

type GeminiPart = { text?: string; thought?: boolean };
type GeminiChunk = {
  candidates?: { finishReason?: string; content?: { parts?: GeminiPart[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
};

/** Thời gian chờ Google gợi ý trong lỗi 429: RetryInfo.retryDelay ("23s") hoặc câu "Please retry in 23.4s". */
export function geminiRetryDelayMs(raw: string): number | undefined {
  const detail = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(raw);
  if (detail) return Math.ceil(Number(detail[1]) * 1000);
  const sentence = /retry in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(raw);
  if (sentence) return Math.ceil(Number(sentence[1]) * (sentence[2].toLowerCase() === "ms" ? 1 : 1000));
  return undefined;
}

/** Hạn mức bị chạm là theo phút hay theo ngày (QuotaFailure.quotaId, vd. GenerateRequestsPerMinutePerProjectPerModel-FreeTier). */
export function geminiQuotaWindow(raw: string): "minute" | "day" | undefined {
  if (/PerDay/i.test(raw)) return "day";
  if (/PerMinute/i.test(raw)) return "minute";
  return undefined;
}

async function readError(response: Response): Promise<ProviderError> {
  let retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  let message = `gemini HTTP ${response.status}`;
  const raw = await response.text().catch(() => "");
  try {
    const body = JSON.parse(raw) as { error?: { message?: string; status?: string } | string };
    if (typeof body.error === "string") message = body.error;
    else if (body.error?.message) message = `${body.error.status ?? ""} ${body.error.message}`.trim();
  } catch {
    if (raw) message = `${message} ${raw}`.trim();
  }
  if (response.status === 429) {
    retryAfterMs = retryAfterMs ?? geminiRetryDelayMs(raw);
    const window = geminiQuotaWindow(raw);
    // Đặt nhãn ở đầu để không bị cắt mất khi rút gọn thông báo.
    if (window) message = `[quota/${window === "day" ? "ngày" : "phút"}] ${message}`;
  }
  return new ProviderError(message.slice(0, 400), { status: response.status, lane: "gemini", retryAfterMs });
}

/**
 * Thời gian nghỉ cho model sau 429: hạn mức phút → theo retryDelay Google gợi ý (thường < 60 s),
 * hạn mức ngày → 60 phút, không rõ → 5 phút như AI Studio.
 */
export function rateLimitCooldownMs(error: ProviderError): number {
  if (/\[quota\/ngày\]/.test(error.message)) return COOLDOWN_MS.missing;
  if (error.retryAfterMs !== undefined) return Math.min(COOLDOWN_MS.rateLimited, Math.max(1_000, error.retryAfterMs + 500));
  if (/\[quota\/phút\]/.test(error.message)) return 60_000;
  return COOLDOWN_MS.rateLimited;
}

export type GeminiFailure = "auth" | "missing" | "rateLimited" | "unavailable" | "badRequest" | "abort";

export function classifyGeminiError(error: unknown): GeminiFailure {
  if (error instanceof DOMException && error.name === "AbortError") return "abort";
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ProviderError ? error.status : 0;
  if (status === 401 || status === 403 || /PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(message)) return "auth";
  if (status === 404 || /not found|is not supported|unknown model|is not available/i.test(message)) return "missing";
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) return "rateLimited";
  if (
    status >= 500 ||
    status === 408 ||
    /UNAVAILABLE|overloaded|high demand|timeout|timed out|ECONNRESET|socket|fetch failed|network/i.test(message)
  ) {
    return "unavailable";
  }
  if (status === 400) return "badRequest";
  return "unavailable";
}

function accumulate(chunks: GeminiChunk[], model: string): GenerateResponse {
  let text = "";
  let finishReason = "";
  let usage: GeminiChunk["usageMetadata"] = {};
  let modelVersion = "";
  for (const chunk of chunks) {
    if (chunk.error?.message) {
      throw new ProviderError(chunk.error.message, { status: chunk.error.code ?? 500, lane: "gemini" });
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) if (!part.thought && part.text) text += part.text;
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.modelVersion) modelVersion = chunk.modelVersion;
    if (!text && chunk.promptFeedback?.blockReason) {
      throw new ProviderError(`Gemini chặn prompt: ${chunk.promptFeedback.blockReason}`, { status: 400, lane: "gemini" });
    }
  }
  const promptTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  return {
    text,
    finishReason: finishReason || "STOP",
    model: modelVersion || model,
    lane: "gemini",
    usage: {
      promptTokens,
      outputTokens,
      totalTokens: usage?.totalTokenCount ?? promptTokens + outputTokens,
    },
  };
}

type Fetch = typeof fetch;

async function streamOnce(args: {
  fetchImpl: Fetch;
  apiKey: string;
  model: string;
  request: GenerateRequest;
  firstTokenMs: number;
  signal?: AbortSignal;
}): Promise<GenerateResponse> {
  const controller = new AbortController();
  const outer = args.signal;
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(new DOMException("first-token timeout", "TimeoutError")),
    args.firstTokenMs,
  );
  const totalTimer = setTimeout(
    () => controller.abort(new DOMException("stream timeout", "TimeoutError")),
    STREAM_TOTAL_MS,
  );
  try {
    const response = await args.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": args.apiKey },
        body: JSON.stringify(buildGeminiBody(args.request, args.model)),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw await readError(response);
    if (!response.body) throw new ProviderError("Gemini không trả stream.", { status: 502, lane: "gemini" });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: GeminiChunk[] = [];
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstTimer) {
        clearTimeout(firstTimer);
        firstTimer = undefined;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") chunks.push(JSON.parse(data) as GeminiChunk);
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) chunks.push(JSON.parse(tail.slice(5).trim()) as GeminiChunk);
    return accumulate(chunks, args.model);
  } catch (error) {
    if (outer?.aborted) throw new DOMException("Aborted", "AbortError");
    if (error instanceof ProviderError) throw error;
    const reason = controller.signal.reason as { message?: string } | undefined;
    const message = reason?.message || (error instanceof Error ? error.message : "fetch failed");
    throw new ProviderError(`gemini ${args.model}: ${message}`, { status: 504, lane: "gemini" });
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    outer?.removeEventListener("abort", onAbort);
  }
}

async function unaryOnce(args: {
  fetchImpl: Fetch;
  apiKey: string;
  model: string;
  request: GenerateRequest;
  signal?: AbortSignal;
}): Promise<GenerateResponse> {
  const timeout = AbortSignal.timeout(UNARY_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  try {
    const response = await args.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": args.apiKey },
        body: JSON.stringify(buildGeminiBody(args.request, args.model)),
        signal,
      },
    );
    if (!response.ok) throw await readError(response);
    return accumulate([(await response.json()) as GeminiChunk], args.model);
  } catch (error) {
    if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`gemini ${args.model}: ${error instanceof Error ? error.message : "fetch failed"}`, {
      status: 504,
      lane: "gemini",
    });
  }
}

/**
 * Gọi chuỗi model Gemini với ngắt mạch kiểu AI Studio:
 * 404 → nghỉ 60 phút, 429 → nghỉ 5 phút, 503/timeout/mạng → nghỉ 2 phút, 401/403 → dừng ngay.
 * Model khỏe xếp trước; khi cả chuỗi đang nghỉ thì trả 503 kèm retryAfter để bộ định tuyến chuyển lane.
 */
/** Lần thử cuối đưa model dự phòng (hydrogen) lên trước; flash-lite vẫn là phương án dự phòng. */
export function orderGeminiModels(models: string[], preferFallback = false): string[] {
  const resolved = resolveGeminiModels(models);
  if (!preferFallback || resolved.length < 2) return resolved;
  return [...resolved.slice(1), resolved[0]];
}

export async function generateGeminiRest(options: {
  apiKey: string;
  models: string[];
  request: GenerateRequest;
  signal?: AbortSignal;
  fetchImpl?: Fetch;
  breaker?: ModelBreaker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRounds?: number;
}): Promise<GenerateResponse> {
  if (!options.apiKey) throw new ProviderError("Thiếu Gemini API key.", { status: 401, lane: "gemini" });
  const models = orderGeminiModels(options.models, options.request.preferFallbackModel);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const breaker = options.breaker ?? sharedBreaker;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRounds = Math.max(1, options.maxRounds ?? 2);
  let last: ProviderError | null = null;
  // Model lỗi tạm thời (503/timeout) trong chính lượt gọi này vẫn được thử lại ở vòng sau (kèm unary),
  // giống AI Studio; model 429/404 thì bỏ cho tới hết thời gian nghỉ.
  const transient = new Set<string>();

  for (let round = 1; round <= maxRounds; round += 1) {
    const healthy = models.filter((model) => breaker.coolUntil(model) <= now() || (round > 1 && transient.has(model)));
    if (!healthy.length) {
      const soonest = Math.min(...models.map((model) => breaker.coolUntil(model))) - now();
      throw new ProviderError(last?.message ?? "Tất cả model Gemini đang nghỉ.", {
        status: last?.status === 429 ? 429 : 503,
        lane: "gemini",
        retryAfterMs: Math.max(1_000, soonest),
      });
    }
    for (const model of healthy) {
      try {
        const firstTokenMs = round === 1 ? FIRST_TOKEN_MS.first : FIRST_TOKEN_MS.later;
        let response: GenerateResponse;
        try {
          response = await streamOnce({ fetchImpl, apiKey: options.apiKey, model, request: options.request, firstTokenMs, signal: options.signal });
        } catch (error) {
          // Từ vòng 2: thử generateContent (unary) như AI Studio trước khi bỏ model.
          const kind = classifyGeminiError(error);
          if (round < 2 || kind === "auth" || kind === "missing" || kind === "abort" || kind === "badRequest") throw error;
          response = await unaryOnce({ fetchImpl, apiKey: options.apiKey, model, request: options.request, signal: options.signal });
        }
        breaker.clear(model);
        return response;
      } catch (error) {
        const kind = classifyGeminiError(error);
        if (kind === "abort") throw error;
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError(error instanceof Error ? error.message : "Gemini lỗi.", { status: 502, lane: "gemini" });
        last = providerError;
        if (kind === "auth") throw providerError;
        if (kind === "badRequest" && /too many states|schema/i.test(providerError.message) && options.request.kind === "scenes") {
          const loose = relaxSceneSchema(options.request.responseSchema);
          if (JSON.stringify(loose) === JSON.stringify(options.request.responseSchema)) throw providerError;
          // Schema quá phức tạp cho Gemini: thử lại ngay một lần với schema nới (validator vẫn kiểm id).
          return generateGeminiRest({ ...options, request: { ...options.request, responseSchema: loose } });
        }
        if (kind === "badRequest") throw providerError;
        if (kind === "missing") breaker.mark(model, COOLDOWN_MS.missing);
        else if (kind === "rateLimited") breaker.mark(model, rateLimitCooldownMs(providerError));
        else {
          breaker.mark(model, COOLDOWN_MS.unavailable);
          transient.add(model);
        }
        if (kind !== "unavailable") transient.delete(model);
      }
    }
    if (round < maxRounds && (transient.size || models.some((model) => breaker.coolUntil(model) <= now()))) {
      await sleep(backoffMs(round, options.random));
    }
  }
  throw last ?? new ProviderError("Không có model Gemini nào phản hồi.", { status: 503, lane: "gemini" });
}

export function geminiProvider(options: {
  apiKey: string;
  models: string[];
  signal?: AbortSignal;
}): { lane: ProviderLane; model: string; available: boolean; generate: (request: GenerateRequest, signal?: AbortSignal) => Promise<GenerateResponse> } {
  const models = resolveGeminiModels(options.models);
  return {
    lane: "gemini",
    model: models[0],
    available: Boolean(options.apiKey),
    generate: (request, signal) => generateGeminiRest({ ...options, request, signal: signal ?? options.signal }),
  };
}
