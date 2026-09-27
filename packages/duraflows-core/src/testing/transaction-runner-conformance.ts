import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { WorkflowError } from "../index.js";
import type { WorkflowInstance, WorkflowInstanceStore, WorkflowTransactionRunner } from "../index.js";

export interface TransactionRunnerConformanceHarness {
  /**
   * Build a fresh runner + instance store pair for a single test. The runner
   * must implement `afterCommit`. `failWithDatabaseError`, when provided, must
   * run a statement that fails with a database error on the active
   * transaction's connection (e.g. `SELECT 1/0`); omit it for runners with no
   * database. `teardown` is always called in a `finally` block.
   */
  setup(): Promise<{
    runner: WorkflowTransactionRunner;
    store: WorkflowInstanceStore;
    failWithDatabaseError?: () => Promise<void>;
    teardown: () => Promise<void>;
  }>;
}

function makeInstance(): WorkflowInstance {
  return {
    uuid: randomUUID(),
    workflowName: "conformance-workflow",
    currentState: "initial",
    version: 0,
    definitionVersion: null,
    expiresAt: null,
    lastTransitionAt: new Date("2026-01-01T00:00:00Z"),
    context: {},
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function requireAfterCommit(runner: WorkflowTransactionRunner): (callback: () => Promise<void>) => void {
  if (!runner.afterCommit) {
    throw new Error("runTransactionRunnerConformance requires a runner that implements afterCommit");
  }
  return (callback) => runner.afterCommit!(callback);
}

/**
 * Run the standard conformance suite against an adapter's
 * `WorkflowTransactionRunner`: after-commit delivery and savepoint-based
 * nested failure isolation.
 *
 * @example
 * ```ts
 * import { runTransactionRunnerConformance } from "@duraflows/core/testing";
 *
 * runTransactionRunnerConformance("my-adapter", {
 *   setup: async () => ({ runner, store, failWithDatabaseError, teardown: async () => {} }),
 * });
 * ```
 */
export function runTransactionRunnerConformance(label: string, harness: TransactionRunnerConformanceHarness): void {
  describe(`WorkflowTransactionRunner conformance: ${label}`, () => {
    it("runs afterCommit callbacks after the outermost commit, in registration order", async () => {
      const { runner, store, teardown } = await harness.setup();
      try {
        const afterCommit = requireAfterCommit(runner);
        const fired: string[] = [];

        await runner.runInTransaction(async () => {
          await store.create(makeInstance());
          afterCommit(async () => {
            fired.push("first");
          });
          await runner.runInTransaction(async () => {
            afterCommit(async () => {
              fired.push("nested");
            });
          });
          afterCommit(async () => {
            fired.push("last");
          });
          expect(fired).toEqual([]);
        });

        expect(fired).toEqual(["first", "nested", "last"]);
      } finally {
        await teardown();
      }
    });

    it("discards afterCommit callbacks when the transaction rolls back", async () => {
      const { runner, store, teardown } = await harness.setup();
      try {
        const afterCommit = requireAfterCommit(runner);
        const callback = vi.fn(async () => {});
        const instance = makeInstance();

        await expect(
          runner.runInTransaction(async () => {
            await store.create(instance);
            afterCommit(callback);
            throw new Error("outer rollback");
          }),
        ).rejects.toThrow("outer rollback");

        expect(callback).not.toHaveBeenCalled();
        expect(await store.findByUuid(instance.uuid)).toBeNull();
      } finally {
        await teardown();
      }
    });

    it("a failed nested call rolls back only its own writes and callbacks", async () => {
      const { runner, store, teardown } = await harness.setup();
      try {
        const afterCommit = requireAfterCommit(runner);
        const fired: string[] = [];
        const kept = makeInstance();
        const discarded = makeInstance();

        await runner.runInTransaction(async () => {
          await store.create(kept);
          afterCommit(async () => {
            fired.push("outer");
          });
          await expect(
            runner.runInTransaction(async () => {
              await store.create(discarded);
              afterCommit(async () => {
                fired.push("inner");
              });
              throw new Error("inner boom");
            }),
          ).rejects.toThrow("inner boom");
        });

        expect(await store.findByUuid(kept.uuid)).not.toBeNull();
        expect(await store.findByUuid(discarded.uuid)).toBeNull();
        expect(fired).toEqual(["outer"]);
      } finally {
        await teardown();
      }
    });

    it("the outer transaction stays usable after a caught nested database error", async (ctx) => {
      const { runner, store, failWithDatabaseError, teardown } = await harness.setup();
      try {
        if (!failWithDatabaseError) {
          ctx.skip();
          return;
        }
        const before = makeInstance();
        const after = makeInstance();

        await runner.runInTransaction(async () => {
          await store.create(before);
          await expect(runner.runInTransaction(() => failWithDatabaseError())).rejects.toThrow();
          await store.create(after);
        });

        expect(await store.findByUuid(before.uuid)).not.toBeNull();
        expect(await store.findByUuid(after.uuid)).not.toBeNull();
      } finally {
        await teardown();
      }
    });

    it("a throwing callback does not stop later callbacks or fail the committed call", async () => {
      const { runner, teardown } = await harness.setup();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const afterCommit = requireAfterCommit(runner);
        const fired: string[] = [];

        const value = await runner.runInTransaction(async () => {
          afterCommit(async () => {
            throw new Error("observer exploded");
          });
          afterCommit(async () => {
            fired.push("second");
          });
          return "committed";
        });

        expect(value).toBe("committed");
        expect(fired).toEqual(["second"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("observer exploded"));
      } finally {
        warn.mockRestore();
        await teardown();
      }
    });

    it("afterCommit outside a transaction throws WorkflowError", async () => {
      const { runner, teardown } = await harness.setup();
      try {
        const afterCommit = requireAfterCommit(runner);

        expect(() => afterCommit(async () => {})).toThrow(WorkflowError);
      } finally {
        await teardown();
      }
    });

    it("a transaction started from an afterCommit callback is a fresh outermost transaction", async () => {
      const { runner, store, teardown } = await harness.setup();
      try {
        const afterCommit = requireAfterCommit(runner);
        const order: string[] = [];
        const created = makeInstance();

        await runner.runInTransaction(async () => {
          afterCommit(async () => {
            await runner.runInTransaction(async () => {
              await store.create(created);
              afterCommit(async () => {
                order.push("inner afterCommit");
              });
            });
            order.push("outer callback done");
          });
        });

        expect(order).toEqual(["inner afterCommit", "outer callback done"]);
        expect(await store.findByUuid(created.uuid)).not.toBeNull();
      } finally {
        await teardown();
      }
    });
  });
}
