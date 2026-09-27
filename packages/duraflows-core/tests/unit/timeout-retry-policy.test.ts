import { describe, it, expect } from "vitest";
import { TimeoutRetryPolicy } from "../../src/runtime/timeout-retry-policy.js";
import { InvalidArgumentError } from "../../src/errors/index.js";

const now = new Date("2026-01-01T00:00:00Z");

describe("TimeoutRetryPolicy", () => {
  it("defaults to 1 minute doubling, capped at 1 hour, parking after 10 attempts", () => {
    const policy = new TimeoutRetryPolicy();
    expect([policy.initialDelayMs, policy.maxDelayMs, policy.maxAttempts]).toEqual([60_000, 3_600_000, 10]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => policy.delayMs(n) / 60_000)).toEqual([
      1, 2, 4, 8, 16, 32, 60, 60, 60,
    ]);
  });

  it("caps the delay even for very large attempt counts", () => {
    const policy = new TimeoutRetryPolicy({ initialDelayMs: 1000, maxDelayMs: 5000, maxAttempts: 2000 });
    expect(policy.delayMs(1500)).toBe(5000);
  });

  it("schedules the next retry after a failure", () => {
    const policy = new TimeoutRetryPolicy({ initialDelayMs: 60_000, maxDelayMs: 240_000, maxAttempts: 3 });
    const first = policy.next(null, "boom", now);
    expect(first).toEqual({
      attempts: 1,
      lastError: "boom",
      retryAt: new Date(now.getTime() + 60_000),
      parkedAt: null,
    });
    const second = policy.next(first, "boom again", now);
    expect(second).toEqual({
      attempts: 2,
      lastError: "boom again",
      retryAt: new Date(now.getTime() + 120_000),
      parkedAt: null,
    });
  });

  it("parks when the failure count reaches maxAttempts", () => {
    const policy = new TimeoutRetryPolicy({ maxAttempts: 2 });
    const parked = policy.next({ attempts: 1, lastError: "x", retryAt: now, parkedAt: null }, "final", now);
    expect(parked).toEqual({ attempts: 2, lastError: "final", retryAt: null, parkedAt: now });
  });

  it("parks on the first failure when maxAttempts is 1", () => {
    const policy = new TimeoutRetryPolicy({ maxAttempts: 1 });
    expect(policy.next(null, "boom", now)).toEqual({ attempts: 1, lastError: "boom", retryAt: null, parkedAt: now });
  });

  it("truncates the stored error message to 2000 characters", () => {
    const policy = new TimeoutRetryPolicy();
    expect(policy.next(null, "e".repeat(5000), now).lastError).toHaveLength(2000);
  });

  it("replaces NUL characters, which PostgreSQL text columns reject, with U+FFFD", () => {
    const policy = new TimeoutRetryPolicy();
    const { lastError } = policy.next(null, "bad\u0000byte\u0000", now);
    expect(lastError).toBe("bad�byte�");
    expect(lastError).not.toContain("\u0000");
  });

  it.each([
    ["initialDelayMs of 0", { initialDelayMs: 0 }],
    ["a negative maxDelayMs", { maxDelayMs: -1 }],
    ["a fractional maxAttempts", { maxAttempts: 1.5 }],
    ["NaN initialDelayMs", { initialDelayMs: Number.NaN }],
    ["maxAttempts of 0", { maxAttempts: 0 }],
  ])("rejects %s", (_label, options) => {
    expect(() => new TimeoutRetryPolicy(options)).toThrow(InvalidArgumentError);
  });

  it("rejects an initial delay above the maximum delay", () => {
    expect(() => new TimeoutRetryPolicy({ initialDelayMs: 10_000, maxDelayMs: 5_000 })).toThrow(
      "timeoutRetry.initialDelayMs (10000) must not exceed timeoutRetry.maxDelayMs (5000)",
    );
  });
});
