import { describe, expect, it } from "vitest";
import { SchedulerError } from "../src/core/errors.js";
import { parseRetryAfter } from "../src/core/errors.js";
import { createScheduler } from "../src/core/scheduler.js";

function clock() {
  let time = 1_700_000_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe("scheduler", () => {
  it("holds the third request until an RPM slot frees", async () => {
    const time = clock();
    const scheduler = createScheduler({ rpm: 2, tpm: 100_000, rpd: 50, now: time.now, sleep: time.sleep });
    await scheduler.acquire(10);
    await scheduler.acquire(10);
    await scheduler.acquire(10);
    expect(time.sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it("waits for TPM headroom and reconciles the reservation", async () => {
    const time = clock();
    const scheduler = createScheduler({ rpm: 10, tpm: 100, rpd: 50, now: time.now, sleep: time.sleep });
    const first = await scheduler.acquire(60);
    first.reconcile(40);
    expect(scheduler.snapshot().tpmUsed).toBe(40);
    await scheduler.acquire(70);
    expect(time.sleeps.length).toBeGreaterThan(0);
  });

  it("stops at the daily cap and refuses a single request larger than TPM", async () => {
    const time = clock();
    const scheduler = createScheduler({ rpm: 10, tpm: 1_000, rpd: 1, now: time.now, sleep: time.sleep });
    await scheduler.acquire(10);
    await expect(scheduler.acquire(10)).rejects.toBeInstanceOf(SchedulerError);
    const other = createScheduler({ rpm: 10, tpm: 50, rpd: 5, now: time.now, sleep: time.sleep });
    await expect(other.acquire(80)).rejects.toMatchObject({ code: "tpm" });
  });

  it("honors a penalize window from retry-after", async () => {
    const time = clock();
    const scheduler = createScheduler({ rpm: 10, tpm: 10_000, rpd: 20, now: time.now, sleep: time.sleep });
    scheduler.penalize(5_000);
    await scheduler.acquire(10);
    expect(time.sleeps[0]).toBe(5_000);
  });

  it("parses retry-after seconds and HTTP dates", () => {
    expect(parseRetryAfter("2", 1_000)).toBe(2_000);
    const when = new Date(10_000).toUTCString();
    expect(parseRetryAfter(when, 1_000)).toBe(9_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
