import { FatalRunError, isAbortError, ProviderError, SchedulerError } from "./errors.js";
import { backoffMs, COOLDOWN_MS } from "./providers/gemini.js";
import type { Estimate, Scheduler } from "./scheduler.js";
import type { GenerateRequest, GenerateResponse, Provider, RequestLog } from "./types.js";

/** Một lane = nhà cung cấp + bộ hạn mức riêng. Hàng đợi chung: lô nào rảnh lane nào thì chạy lane đó. */
export type LaneSlot = {
  provider: Provider;
  scheduler: Scheduler;
  /** Ước lượng neuron cho Cloudflare (input, output) → neuron. */
  neurons?: (inputTokens: number, outputTokens: number) => number;
};

type SlotState = {
  coolUntil: number;
  disabled?: string;
  exhausted?: string;
  failures: number;
};

export type Router = {
  call: (
    request: GenerateRequest,
    attempt: number,
  ) => Promise<{ response: GenerateResponse; latencyMs: number }>;
  state: () => { lane: string; model: string; coolUntil: number; disabled?: string; exhausted?: string }[];
};

const MAX_TRIES = 10;
/** Không đợi lane nghỉ quá lâu một lèo; ngủ từng đoạn rồi xét lại vì lane khác có thể rảnh trước. */
const MAX_NAP_MS = 15_000;

function estimateOf(slot: LaneSlot, request: GenerateRequest): Estimate {
  const input = request.estimatedInputTokens ?? Math.ceil(request.estimatedTokens * 0.7);
  const output = request.estimatedOutputTokens ?? Math.max(0, request.estimatedTokens - input);
  // Neuron ước theo trần output (max_tokens) để không bao giờ vượt ngưỡng dừng sau khi đối soát số thật.
  return { input, output, neurons: slot.neurons ? slot.neurons(input, Math.max(output, request.maxOutputTokens)) : 0 };
}

export function createRouter(args: {
  slots: LaneSlot[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onLog: (log: RequestLog) => void;
  random?: () => number;
}): Router {
  const slots = args.slots.filter((slot) => slot.provider.available);
  const states = new Map<LaneSlot, SlotState>(slots.map((slot) => [slot, { coolUntil: 0, failures: 0 }]));

  function log(slot: LaneSlot, request: GenerateRequest, attempt: number, extra: Partial<RequestLog>) {
    args.onLog({
      id: crypto.randomUUID(),
      at: args.now(),
      lane: slot.provider.lane,
      model: slot.provider.model,
      kind: request.kind,
      sceneIds: request.sceneIds,
      attempt,
      finishReason: "error",
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      status: "error",
      rejections: [],
      ...extra,
    });
  }

  function pick(request: GenerateRequest): { slot: LaneSlot; wait: number } | null {
    let best: { slot: LaneSlot; wait: number } | null = null;
    for (const slot of slots) {
      const state = states.get(slot)!;
      if (state.disabled || state.exhausted) continue;
      const estimate = estimateOf(slot, request);
      if (slot.scheduler.fits && !slot.scheduler.fits(estimate)) continue; // lô quá lớn cho lane này, lane khác nhận
      let quota: number;
      try {
        quota = slot.scheduler.peek(estimate);
      } catch {
        quota = Infinity;
      }
      if (!Number.isFinite(quota)) {
        state.exhausted = "Hết hạn mức ngày (RPD hoặc ngưỡng neuron).";
        continue;
      }
      const wait = Math.max(0, state.coolUntil - args.now(), quota);
      // Thứ tự slot = thứ tự ưu tiên; chỉ đổi khi lane sau rảnh sớm hơn hẳn.
      if (!best || wait < best.wait) best = { slot, wait };
      if (wait === 0) break;
    }
    return best;
  }

  async function call(request: GenerateRequest, attempt: number) {
    if (!slots.length) throw new FatalRunError("Chưa có lane nào sẵn sàng. Hãy nhập khóa API hoặc chạy mô phỏng.");
    let last: unknown;
    let naps = 0;
    for (let tryNo = 0; tryNo < MAX_TRIES; tryNo += 1) {
      if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const choice = pick(request);
      if (!choice) {
        const reasons = slots
          .map((slot) => {
            const state = states.get(slot)!;
            return `${slot.provider.lane}: ${state.disabled ?? state.exhausted ?? "nghỉ"}`;
          })
          .join(" · ");
        throw new FatalRunError(`Không còn lane dùng được. ${reasons}`);
      }
      if (choice.wait > 0) {
        naps += 1;
        if (naps > 5_000) throw new FatalRunError("Bộ định tuyến chờ quá lâu mà lane không rảnh.");
        await args.sleep(Math.min(choice.wait, MAX_NAP_MS));
        tryNo -= 1; // chờ hạn mức không tính là một lần thử
        continue;
      }
      const { slot } = choice;
      const state = states.get(slot)!;
      let lease;
      try {
        lease = await slot.scheduler.acquire(estimateOf(slot, request));
      } catch (error) {
        if (error instanceof SchedulerError) {
          if (error.code === "rpd" || error.code === "budget") state.exhausted = error.message;
          else state.coolUntil = args.now() + 1_000;
          continue;
        }
        throw error;
      }
      const started = args.now();
      try {
        const raw = await slot.provider.generate(request, args.signal);
        const neurons =
          raw.neurons ?? (slot.neurons ? slot.neurons(raw.usage.promptTokens, raw.usage.outputTokens) : undefined);
        const response = neurons === undefined ? raw : { ...raw, neurons };
        lease.reconcile(response.usage.totalTokens || request.estimatedTokens, response.usage.outputTokens, neurons);
        state.failures = 0;
        return { response, latencyMs: Math.max(0, args.now() - started) };
      } catch (error) {
        lease.reconcile(1, 0, 0);
        last = error;
        const latencyMs = Math.max(0, args.now() - started);
        if (isAbortError(error)) throw error;
        const status = error instanceof ProviderError ? error.status : 0;
        const message = error instanceof Error ? error.message : "Lỗi nhà cung cấp.";
        const retryAfter = error instanceof ProviderError ? error.retryAfterMs : undefined;
        if (status === 401 || status === 403) {
          state.disabled = `khóa bị từ chối (${status})`;
          log(slot, request, attempt, { latencyMs, error: message });
          continue;
        }
        if (status === 404) {
          state.coolUntil = args.now() + COOLDOWN_MS.missing;
          log(slot, request, attempt, { latencyMs, error: message });
          continue;
        }
        if (status === 429 && /per day|\bTPD\b|\bRPD\b|daily|neurons?/i.test(message)) {
          // Hết hạn mức NGÀY (vd. Groq TPD 200K, Cloudflare 10.000 neuron): nghỉ lane tới hết lượt, để lane khác nhận.
          state.exhausted = `hết hạn mức ngày: ${message.slice(0, 120)}`;
          log(slot, request, attempt, { latencyMs, finishReason: "rate_limit", status: "rate_limited", error: `429 ngày: ${message}` });
          continue;
        }
        if (status === 429) {
          const wait = retryAfter !== undefined ? Math.max(0, retryAfter) : COOLDOWN_MS.rateLimited;
          state.coolUntil = args.now() + wait;
          slot.scheduler.penalize(wait);
          log(slot, request, attempt, {
            latencyMs,
            finishReason: "rate_limit",
            status: "rate_limited",
            error: `429, nghỉ ${Math.round(wait / 1000)}s: ${message}`,
          });
          continue;
        }
        if (status === 400 || status === 413 || status === 422) {
          // Request hỏng với lane này (schema, độ dài…) → để lane khác thử, lane này nghỉ ngắn.
          state.coolUntil = args.now() + 30_000;
          log(slot, request, attempt, { latencyMs, error: message });
          continue;
        }
        state.failures += 1;
        const wait =
          retryAfter ?? (state.failures >= 3 ? COOLDOWN_MS.unavailable : backoffMs(state.failures, args.random));
        state.coolUntil = args.now() + wait;
        log(slot, request, attempt, { latencyMs, error: message });
      }
    }
    throw last instanceof Error ? last : new Error("Nhà cung cấp không trả lời.");
  }

  return {
    call,
    state: () =>
      slots.map((slot) => {
        const state = states.get(slot)!;
        return {
          lane: slot.provider.lane,
          model: slot.provider.model,
          coolUntil: state.coolUntil,
          disabled: state.disabled,
          exhausted: state.exhausted,
        };
      }),
  };
}
