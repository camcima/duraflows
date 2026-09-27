import { InvalidArgumentError } from "../errors/index.js";
import type { WorkflowTimeoutRetry, WorkflowTimeoutRetryOptions } from "../types/runtime.js";
import { assertPositiveSafeInteger } from "../util/assert.js";

const MAX_LAST_ERROR_LENGTH = 2000;

/**
 * Validated retry policy for failed timeout processing: exponential backoff
 * (doubling from `initialDelayMs`, capped at `maxDelayMs`), parking after
 * `maxAttempts` consecutive failures.
 */
export class TimeoutRetryPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;

  constructor(options: WorkflowTimeoutRetryOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? 60_000;
    this.maxDelayMs = options.maxDelayMs ?? 3_600_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    assertPositiveSafeInteger(this.initialDelayMs, "timeoutRetry.initialDelayMs");
    assertPositiveSafeInteger(this.maxDelayMs, "timeoutRetry.maxDelayMs");
    assertPositiveSafeInteger(this.maxAttempts, "timeoutRetry.maxAttempts");
    if (this.initialDelayMs > this.maxDelayMs) {
      throw new InvalidArgumentError(
        `timeoutRetry.initialDelayMs (${this.initialDelayMs}) must not exceed timeoutRetry.maxDelayMs (${this.maxDelayMs})`,
      );
    }
  }

  /** Delay before the next attempt after `attempts` consecutive failures (`attempts >= 1`). */
  delayMs(attempts: number): number {
    return Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** (attempts - 1));
  }

  /**
   * The retry state after one more failure on top of `previous`. NUL
   * characters in `error` become U+FFFD: PostgreSQL `text` rejects NUL, so an
   * unsanitized message could never be recorded and the instance would keep
   * its original priority on every sweep.
   */
  next(previous: WorkflowTimeoutRetry | null, error: string, now: Date): WorkflowTimeoutRetry {
    const attempts = (previous?.attempts ?? 0) + 1;
    const lastError = error.replaceAll("\u0000", "\uFFFD").slice(0, MAX_LAST_ERROR_LENGTH);
    if (attempts >= this.maxAttempts) {
      return { attempts, lastError, retryAt: null, parkedAt: now };
    }
    return { attempts, lastError, retryAt: new Date(now.getTime() + this.delayMs(attempts)), parkedAt: null };
  }
}
