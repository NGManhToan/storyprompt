export type ProviderLane = "gemini" | "groq" | "cloudflare" | "mock";

export class ProviderError extends Error {
  status: number;
  retryAfterMs?: number;
  lane: string;

  constructor(message: string, options: { status: number; lane: string; retryAfterMs?: number }) {
    super(message);
    this.name = "ProviderError";
    this.status = options.status;
    this.lane = options.lane;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class FatalRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalRunError";
  }
}

export class SchedulerError extends Error {
  code: "rpm" | "tpm" | "rpd" | "stall";

  constructor(code: SchedulerError["code"], message: string) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return undefined;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
