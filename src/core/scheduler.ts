import { SchedulerError } from "./errors.js";

export { SchedulerError } from "./errors.js";

const WINDOW_MS = 60_000;

export type Lease = {
  id: number;
  /** Cập nhật số thật sau khi nhà cung cấp trả về. */
  reconcile: (actualTokens: number, actualOutputTokens?: number, actualNeurons?: number) => void;
};

/** Ước lượng cho một request. Số đơn lẻ = tổng token (tương thích cũ). */
export type Estimate = number | { input: number; output: number; neurons?: number };

export type SchedulerSnapshot = {
  rpmUsed: number;
  tpmUsed: number;
  otpmUsed: number;
  rpdUsed: number;
  neuronsUsed: number;
  dayKey: string;
  pauseUntil: number;
};

export type Scheduler = {
  acquire: (estimate: Estimate) => Promise<Lease>;
  /** Số ms phải chờ để lấy suất. 0 = lấy ngay. Infinity = hết hạn mức ngày hoặc vượt trần. */
  peek: (estimate: Estimate) => number;
  /** false khi riêng lô này vượt trần TPM/OTPM của lane (lane vẫn dùng được cho lô nhỏ hơn). */
  fits: (estimate: Estimate) => boolean;
  penalize: (retryAfterMs: number) => void;
  snapshot: () => SchedulerSnapshot;
};

type Stamp = { at: number; tokens: number; output: number; id: number };

export function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function createAbortableSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function normalize(estimate: Estimate, tpmInputOnly: boolean) {
  if (typeof estimate === "number") {
    const tokens = Math.max(1, Math.ceil(estimate));
    return { tokens, output: 0, neurons: 0 };
  }
  const input = Math.max(0, Math.ceil(estimate.input));
  const output = Math.max(0, Math.ceil(estimate.output));
  return {
    tokens: Math.max(1, tpmInputOnly ? input : input + output),
    output,
    neurons: Math.max(0, estimate.neurons ?? 0),
  };
}

export function createScheduler(options: {
  rpm: number;
  tpm: number;
  rpd: number;
  /** Output tokens per minute (Groq áp riêng). */
  otpm?: number;
  /** TPM chỉ tính input (Gemini). */
  tpmInputOnly?: boolean;
  /** Dừng khi neuron trong ngày UTC chạm mức này (Cloudflare). */
  neuronStop?: number;
  neuronsUsed?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  dayCount?: number;
  dayKey?: string;
  onUsage?: (usage: { dayKey: string; count: number; neurons: number }) => void;
}): Scheduler {
  if (options.rpm < 1) throw new SchedulerError("rpm", "RPM phải lớn hơn hoặc bằng 1.");
  if (options.tpm < 1) throw new SchedulerError("tpm", "TPM phải lớn hơn hoặc bằng 1.");
  if (options.rpd < 1) throw new SchedulerError("rpd", "RPD phải lớn hơn hoặc bằng 1.");
  if (options.otpm !== undefined && options.otpm < 1) {
    throw new SchedulerError("otpm", "OTPM phải lớn hơn hoặc bằng 1.");
  }

  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tpmInputOnly = Boolean(options.tpmInputOnly);
  const stamps: Stamp[] = [];
  const neuronLeases = new Map<number, number>();
  let sequence = 1;
  let pauseUntil = 0;
  let dayKey = options.dayKey ?? utcDay(now());
  let dayCount = options.dayCount ?? 0;
  let neurons = options.neuronsUsed ?? 0;

  function emit() {
    options.onUsage?.({ dayKey, count: dayCount, neurons: Math.round(neurons * 10) / 10 });
  }

  function roll() {
    const key = utcDay(now());
    if (key !== dayKey) {
      dayKey = key;
      dayCount = 0;
      neurons = 0;
      neuronLeases.clear();
      emit();
    }
  }

  function prune() {
    const time = now();
    while (stamps.length && time - stamps[0].at >= WINDOW_MS) stamps.shift();
  }

  /** Thời gian chờ đến khi đủ chỗ cho `need` trong cửa sổ 60 s theo trường `field`. */
  function waitFor(field: "tokens" | "output", need: number, cap: number): number {
    let used = stamps.reduce((sum, stamp) => sum + stamp[field], 0);
    if (used + need <= cap) return 0;
    for (const stamp of stamps) {
      used -= stamp[field];
      if (used + need <= cap) return stamp.at + WINDOW_MS - now() + 1;
    }
    return 0;
  }

  function check(estimate: Estimate): { wait: number; fatal?: SchedulerError } {
    roll();
    const need = normalize(estimate, tpmInputOnly);
    if (dayCount >= options.rpd) {
      return { wait: Infinity, fatal: new SchedulerError("rpd", "Đã chạm trần request trong ngày (RPD).") };
    }
    if (options.neuronStop !== undefined && neurons + need.neurons > options.neuronStop) {
      return {
        wait: Infinity,
        fatal: new SchedulerError(
          "budget",
          `Đã chạm ngưỡng neuron an toàn trong ngày (${Math.round(neurons)}/${options.neuronStop}).`,
        ),
      };
    }
    if (need.tokens > options.tpm) {
      return { wait: Infinity, fatal: new SchedulerError("tpm", "Một lô ước lượng vượt quá TPM.") };
    }
    if (options.otpm !== undefined && need.output > options.otpm) {
      return { wait: Infinity, fatal: new SchedulerError("otpm", "Một lô ước lượng vượt quá OTPM.") };
    }
    const time = now();
    if (time < pauseUntil) return { wait: pauseUntil - time };
    prune();
    let wait = 0;
    if (stamps.length >= options.rpm) wait = Math.max(wait, stamps[stamps.length - options.rpm].at + WINDOW_MS - time + 1);
    wait = Math.max(wait, waitFor("tokens", need.tokens, options.tpm));
    if (options.otpm !== undefined) wait = Math.max(wait, waitFor("output", need.output, options.otpm));
    return { wait };
  }

  async function wait(ms: number) {
    const waitMs = Math.max(1, Math.ceil(ms));
    const before = now();
    await sleep(waitMs);
    if (now() <= before) throw new SchedulerError("stall", "Đồng hồ không tiến sau khi chờ hạn mức.");
  }

  function peek(estimate: Estimate): number {
    return check(estimate).wait;
  }

  function fits(estimate: Estimate): boolean {
    const need = normalize(estimate, tpmInputOnly);
    if (need.tokens > options.tpm) return false;
    if (options.otpm !== undefined && need.output > options.otpm) return false;
    return true;
  }

  async function acquire(estimate: Estimate): Promise<Lease> {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const verdict = check(estimate);
      if (verdict.fatal) throw verdict.fatal;
      if (verdict.wait > 0) {
        await wait(verdict.wait);
        continue;
      }
      const need = normalize(estimate, tpmInputOnly);
      const id = sequence;
      sequence += 1;
      stamps.push({ at: now(), tokens: need.tokens, output: need.output, id });
      dayCount += 1;
      neurons += need.neurons;
      neuronLeases.set(id, need.neurons);
      emit();
      return {
        id,
        reconcile(actualTokens: number, actualOutputTokens?: number, actualNeurons?: number) {
          const row = stamps.find((stamp) => stamp.id === id);
          if (row) {
            row.tokens = Math.max(1, Math.ceil(actualTokens || need.tokens));
            if (actualOutputTokens !== undefined) row.output = Math.max(0, Math.ceil(actualOutputTokens));
          }
          if (actualNeurons !== undefined && neuronLeases.has(id)) {
            neurons += Math.max(0, actualNeurons) - (neuronLeases.get(id) ?? 0);
            neuronLeases.set(id, Math.max(0, actualNeurons));
            emit();
          }
        },
      };
    }
    throw new SchedulerError("stall", "Bộ điều phối không lấy được suất.");
  }

  function penalize(retryAfterMs: number) {
    const until = now() + Math.max(0, retryAfterMs);
    if (until > pauseUntil) pauseUntil = until;
  }

  function snapshot(): SchedulerSnapshot {
    roll();
    prune();
    return {
      rpmUsed: stamps.length,
      tpmUsed: stamps.reduce((sum, stamp) => sum + stamp.tokens, 0),
      otpmUsed: stamps.reduce((sum, stamp) => sum + stamp.output, 0),
      rpdUsed: dayCount,
      neuronsUsed: Math.round(neurons * 10) / 10,
      dayKey,
      pauseUntil,
    };
  }

  return { acquire, peek, fits, penalize, snapshot };
}
