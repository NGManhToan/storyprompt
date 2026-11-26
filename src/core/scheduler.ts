import { SchedulerError } from "./errors.js";

export { SchedulerError } from "./errors.js";

const WINDOW_MS = 60_000;

export type Lease = {
  id: number;
  reconcile: (actualTokens: number) => void;
};

export type Scheduler = {
  acquire: (estimatedTokens: number) => Promise<Lease>;
  penalize: (retryAfterMs: number) => void;
  snapshot: () => {
    rpmUsed: number;
    tpmUsed: number;
    rpdUsed: number;
    dayKey: string;
    pauseUntil: number;
  };
};

type Stamp = { at: number; tokens: number; id: number };

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

export function createScheduler(options: {
  rpm: number;
  tpm: number;
  rpd: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  dayCount?: number;
  dayKey?: string;
  onUsage?: (usage: { dayKey: string; count: number }) => void;
}): Scheduler {
  if (options.rpm < 1) throw new SchedulerError("rpm", "RPM phải lớn hơn hoặc bằng 1.");
  if (options.tpm < 1) throw new SchedulerError("tpm", "TPM phải lớn hơn hoặc bằng 1.");
  if (options.rpd < 1) throw new SchedulerError("rpd", "RPD phải lớn hơn hoặc bằng 1.");

  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stamps: Stamp[] = [];
  let sequence = 1;
  let pauseUntil = 0;
  let dayKey = options.dayKey ?? utcDay(now());
  let dayCount = options.dayCount ?? 0;

  function roll() {
    const key = utcDay(now());
    if (key !== dayKey) {
      dayKey = key;
      dayCount = 0;
      options.onUsage?.({ dayKey, count: dayCount });
    }
  }

  function prune() {
    const time = now();
    while (stamps.length && time - stamps[0].at >= WINDOW_MS) stamps.shift();
  }

  async function wait(ms: number) {
    const waitMs = Math.max(1, Math.ceil(ms));
    const before = now();
    await sleep(waitMs);
    if (now() <= before) throw new SchedulerError("stall", "Đồng hồ không tiến sau khi chờ hạn mức.");
  }

  async function acquire(estimatedTokens: number): Promise<Lease> {
    const estimated = Math.max(1, Math.ceil(estimatedTokens));
    for (let guard = 0; guard < 10_000; guard += 1) {
      roll();
      if (dayCount >= options.rpd) {
        throw new SchedulerError("rpd", "Đã chạm trần request trong ngày (RPD).");
      }
      const time = now();
      if (time < pauseUntil) {
        await wait(pauseUntil - time);
        continue;
      }
      prune();
      if (!stamps.length && estimated > options.tpm) {
        throw new SchedulerError("tpm", "Một lô ước lượng vượt quá TPM.");
      }
      if (stamps.length >= options.rpm) {
        await wait(stamps[0].at + WINDOW_MS - now() + 1);
        continue;
      }
      const used = stamps.reduce((sum, stamp) => sum + stamp.tokens, 0);
      if (used + estimated > options.tpm) {
        await wait(stamps[0].at + WINDOW_MS - now() + 1);
        continue;
      }
      const id = sequence;
      sequence += 1;
      stamps.push({ at: now(), tokens: estimated, id });
      dayCount += 1;
      options.onUsage?.({ dayKey, count: dayCount });
      return {
        id,
        reconcile(actualTokens: number) {
          const row = stamps.find((stamp) => stamp.id === id);
          if (!row) return;
          row.tokens = Math.max(1, Math.ceil(actualTokens || estimated));
        },
      };
    }
    throw new SchedulerError("stall", "Bộ điều phối không lấy được suất.");
  }

  function penalize(retryAfterMs: number) {
    const until = now() + Math.max(0, retryAfterMs);
    if (until > pauseUntil) pauseUntil = until;
  }

  function snapshot() {
    roll();
    prune();
    return {
      rpmUsed: stamps.length,
      tpmUsed: stamps.reduce((sum, stamp) => sum + stamp.tokens, 0),
      rpdUsed: dayCount,
      dayKey,
      pauseUntil,
    };
  }

  return { acquire, penalize, snapshot };
}
