import { describe, it, expect } from "vitest";
import type { WorkflowInstanceStore, WorkflowTransactionRunner, WorkflowInstance } from "../index.js";

export interface InstanceStoreConformanceHarness {
  /**
   * Build a fresh store + transaction runner pair for a single test.
   * Called once per test. The returned `teardown` is always called in a
   * `finally` block — use it to clear state (e.g., flush an in-memory map,
   * rollback a DB transaction, drop test rows, or close a connection).
   */
  setup(): Promise<{
    store: WorkflowInstanceStore;
    transactionRunner: WorkflowTransactionRunner;
    teardown: () => Promise<void>;
  }>;
}

/**
 * Run the standard conformance suite against an adapter's
 * `WorkflowInstanceStore`. Adapters call this from their own test file to
 * verify they satisfy the cross-adapter contract.
 *
 * @example
 * ```ts
 * import { runInstanceStoreConformance } from "@duraflows/core/testing";
 *
 * runInstanceStoreConformance("my-adapter", {
 *   setup: async () => {
 *     const store = new MyInstanceStore();
 *     const transactionRunner = new MyTransactionRunner();
 *     return { store, transactionRunner, teardown: async () => {} };
 *   },
 * });
 * ```
 */
export function runInstanceStoreConformance(label: string, harness: InstanceStoreConformanceHarness): void {
  describe(`WorkflowInstanceStore conformance: ${label}`, () => {
    const makeInstance = (overrides?: Partial<WorkflowInstance>): WorkflowInstance => ({
      uuid: overrides?.uuid ?? "00000000-0000-0000-0000-000000000001",
      workflowName: "test-workflow",
      currentState: "initial",
      version: 0,
      definitionVersion: null,
      expiresAt: null,
      timeoutRetry: null,
      lastTransitionAt: new Date("2026-01-01T00:00:00Z"),
      context: {},
      metadata: {},
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    });

    it("create stores an instance; findByUuid retrieves it", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const instance = makeInstance();
        await transactionRunner.runInTransaction(() => store.create(instance));

        const fetched = await store.findByUuid(instance.uuid);
        expect(fetched).not.toBeNull();
        expect(fetched!.uuid).toBe(instance.uuid);
        expect(fetched!.workflowName).toBe(instance.workflowName);
        expect(fetched!.currentState).toBe("initial");
      } finally {
        await teardown();
      }
    });

    it("findByUuid returns null for unknown uuid", async () => {
      const { store, teardown } = await harness.setup();
      try {
        const fetched = await store.findByUuid("00000000-0000-0000-0000-000000000999");
        expect(fetched).toBeNull();
      } finally {
        await teardown();
      }
    });

    it("update persists mutable field changes (currentState, version, context, expiresAt)", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const instance = makeInstance();
        await transactionRunner.runInTransaction(() => store.create(instance));

        await transactionRunner.runInTransaction(async () => {
          const locked = await store.lockByUuid(instance.uuid);
          expect(locked).not.toBeNull();
          locked!.currentState = "next";
          locked!.version = 1;
          locked!.context = { foo: "bar" };
          locked!.expiresAt = new Date("2026-06-01T00:00:00Z");
          await store.update(locked!);
        });

        const fetched = await store.findByUuid(instance.uuid);
        expect(fetched!.currentState).toBe("next");
        expect(fetched!.version).toBe(1);
        expect(fetched!.context).toEqual({ foo: "bar" });
        expect(fetched!.expiresAt).toEqual(new Date("2026-06-01T00:00:00Z"));
      } finally {
        await teardown();
      }
    });

    it("update with a stale version throws (optimistic locking)", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const instance = makeInstance();
        await transactionRunner.runInTransaction(() => store.create(instance));

        // Runtime convention: `version` is pre-incremented before update(),
        // so adapters match on `version = instance.version - 1`.
        instance.version = 1;
        instance.updatedAt = new Date("2026-01-02T00:00:00Z");
        await transactionRunner.runInTransaction(() => store.update(instance));

        // Re-issuing the same (now stale) version must throw.
        await expect(transactionRunner.runInTransaction(() => store.update(instance))).rejects.toThrow();
      } finally {
        await teardown();
      }
    });

    it("update does NOT overwrite metadata (metadata is immutable)", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const instance = makeInstance({ metadata: { tenant: "alice" } });
        await transactionRunner.runInTransaction(() => store.create(instance));

        await transactionRunner.runInTransaction(async () => {
          const locked = await store.lockByUuid(instance.uuid);
          expect(locked).not.toBeNull();
          // Mutate the metadata on the in-memory object — adapters must ignore it.
          // Must increment version to satisfy the optimistic-locking contract
          // (same convention as the runtime: version is pre-incremented before update()).
          locked!.version = 1;
          locked!.metadata = { tenant: "bob" };
          await store.update(locked!);
        });

        const fetched = await store.findByUuid(instance.uuid);
        expect(fetched!.metadata).toEqual({ tenant: "alice" });
      } finally {
        await teardown();
      }
    });

    it("findExpired returns instances whose expiresAt is in the past", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const past = new Date("2025-01-01T00:00:00Z");
        const future = new Date("2030-01-01T00:00:00Z");
        const now = new Date("2026-01-01T00:00:00Z");

        const expired1 = makeInstance({ uuid: "00000000-0000-0000-0000-000000000010", expiresAt: past });
        const expired2 = makeInstance({ uuid: "00000000-0000-0000-0000-000000000011", expiresAt: past });
        const fresh = makeInstance({ uuid: "00000000-0000-0000-0000-000000000012", expiresAt: future });
        const noExpiry = makeInstance({ uuid: "00000000-0000-0000-0000-000000000013" });

        for (const inst of [expired1, expired2, fresh, noExpiry]) {
          await transactionRunner.runInTransaction(() => store.create(inst));
        }

        const found = await transactionRunner.runInTransaction(() => store.findExpired(10, now));
        const foundUuids = new Set(found.map((i) => i.uuid));
        expect(foundUuids.has(expired1.uuid)).toBe(true);
        expect(foundUuids.has(expired2.uuid)).toBe(true);
        expect(foundUuids.has(fresh.uuid)).toBe(false);
        expect(foundUuids.has(noExpiry.uuid)).toBe(false);
      } finally {
        await teardown();
      }
    });

    it("findExpired respects limit", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const past = new Date("2025-01-01T00:00:00Z");
        const now = new Date("2026-01-01T00:00:00Z");

        for (let i = 0; i < 5; i++) {
          const inst = makeInstance({
            uuid: `00000000-0000-0000-0000-00000000002${i}`,
            expiresAt: past,
          });
          await transactionRunner.runInTransaction(() => store.create(inst));
        }

        const found = await transactionRunner.runInTransaction(() => store.findExpired(3, now));
        expect(found.length).toBeLessThanOrEqual(3);
      } finally {
        await teardown();
      }
    });

    it("round-trips timeoutRetry through create, update and findByUuid", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const retrying = {
          attempts: 2,
          lastError: "boom",
          retryAt: new Date("2026-01-01T01:00:00Z"),
          parkedAt: null,
        };
        const instance = makeInstance({ uuid: "00000000-0000-0000-0000-000000000030", timeoutRetry: retrying });
        await transactionRunner.runInTransaction(() => store.create(instance));
        expect((await store.findByUuid(instance.uuid))!.timeoutRetry).toEqual(retrying);

        await transactionRunner.runInTransaction(() => store.update({ ...instance, version: 1, timeoutRetry: null }));
        expect((await store.findByUuid(instance.uuid))!.timeoutRetry).toBeNull();

        const parked = {
          attempts: 3,
          lastError: "still broken",
          retryAt: null,
          parkedAt: new Date("2026-01-01T02:00:00Z"),
        };
        await transactionRunner.runInTransaction(() => store.update({ ...instance, version: 2, timeoutRetry: parked }));
        expect((await store.findByUuid(instance.uuid))!.timeoutRetry).toEqual(parked);
      } finally {
        await teardown();
      }
    });

    it("findExpired skips parked and not-yet-due retries and orders by when each became due", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const now = new Date("2026-01-01T00:00:00Z");
        const retryDueJune = makeInstance({
          uuid: "00000000-0000-0000-0000-000000000040",
          expiresAt: new Date("2025-01-01T00:00:00Z"),
          timeoutRetry: { attempts: 1, lastError: "x", retryAt: new Date("2025-06-01T00:00:00Z"), parkedAt: null },
        });
        const deadlineMarch = makeInstance({
          uuid: "00000000-0000-0000-0000-000000000041",
          expiresAt: new Date("2025-03-01T00:00:00Z"),
        });
        const retryInFuture = makeInstance({
          uuid: "00000000-0000-0000-0000-000000000042",
          expiresAt: new Date("2025-02-01T00:00:00Z"),
          timeoutRetry: { attempts: 1, lastError: "x", retryAt: new Date("2026-06-01T00:00:00Z"), parkedAt: null },
        });
        const parked = makeInstance({
          uuid: "00000000-0000-0000-0000-000000000043",
          expiresAt: new Date("2025-01-15T00:00:00Z"),
          timeoutRetry: { attempts: 10, lastError: "x", retryAt: null, parkedAt: new Date("2025-12-01T00:00:00Z") },
        });
        for (const inst of [retryDueJune, deadlineMarch, retryInFuture, parked]) {
          await transactionRunner.runInTransaction(() => store.create(inst));
        }

        const found = await transactionRunner.runInTransaction(() => store.findExpired(10, now));

        expect(found.map((i) => i.uuid)).toEqual([deadlineMarch.uuid, retryDueJune.uuid]);
      } finally {
        await teardown();
      }
    });

    it("findParkedTimeouts lists parked instances oldest-parked first, filtered and limited", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const park = (uuid: string, workflowName: string, parkedAt: string) =>
          makeInstance({
            uuid,
            workflowName,
            timeoutRetry: { attempts: 10, lastError: "x", retryAt: null, parkedAt: new Date(parkedAt) },
          });
        const a1 = park("00000000-0000-0000-0000-000000000050", "wf-a", "2025-05-01T00:00:00Z");
        const b1 = park("00000000-0000-0000-0000-000000000051", "wf-b", "2025-04-01T00:00:00Z");
        const a2 = park("00000000-0000-0000-0000-000000000052", "wf-a", "2025-06-01T00:00:00Z");
        const retrying = makeInstance({
          uuid: "00000000-0000-0000-0000-000000000053",
          workflowName: "wf-a",
          timeoutRetry: { attempts: 1, lastError: "x", retryAt: new Date("2025-07-01T00:00:00Z"), parkedAt: null },
        });
        const healthy = makeInstance({ uuid: "00000000-0000-0000-0000-000000000054", workflowName: "wf-a" });
        for (const inst of [a1, b1, a2, retrying, healthy]) {
          await transactionRunner.runInTransaction(() => store.create(inst));
        }

        expect((await store.findParkedTimeouts({ limit: 10 })).map((i) => i.uuid)).toEqual([b1.uuid, a1.uuid, a2.uuid]);
        expect((await store.findParkedTimeouts({ limit: 10, workflowName: "wf-a" })).map((i) => i.uuid)).toEqual([
          a1.uuid,
          a2.uuid,
        ]);
        expect((await store.findParkedTimeouts({ limit: 1 })).map((i) => i.uuid)).toEqual([b1.uuid]);
      } finally {
        await teardown();
      }
    });

    it("round-trips definitionVersion through create, update and findByUuid", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const instance = makeInstance({ definitionVersion: 4 });
        await transactionRunner.runInTransaction(() => store.create(instance));
        let fetched = await store.findByUuid(instance.uuid);
        expect(fetched!.definitionVersion).toBe(4);

        fetched!.definitionVersion = 5;
        fetched!.version++;
        await transactionRunner.runInTransaction(() => store.update(fetched!));
        fetched = await store.findByUuid(instance.uuid);
        expect(fetched!.definitionVersion).toBe(5);

        const legacy = makeInstance({
          uuid: "00000000-0000-0000-0000-000000000002",
          definitionVersion: null,
        });
        await transactionRunner.runInTransaction(() => store.create(legacy));
        expect((await store.findByUuid(legacy.uuid))!.definitionVersion).toBeNull();
      } finally {
        await teardown();
      }
    });

    it("countInstances filters by workflow, definition version and excluded states", async () => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        const rows = [
          makeInstance({ uuid: "00000000-0000-0000-0000-000000000060", definitionVersion: 1, currentState: "open" }),
          makeInstance({ uuid: "00000000-0000-0000-0000-000000000061", definitionVersion: 1, currentState: "open" }),
          makeInstance({ uuid: "00000000-0000-0000-0000-000000000062", definitionVersion: 1, currentState: "closed" }),
          makeInstance({ uuid: "00000000-0000-0000-0000-000000000063", definitionVersion: 2, currentState: "open" }),
          makeInstance({
            uuid: "00000000-0000-0000-0000-000000000064",
            workflowName: "other-workflow",
            definitionVersion: 1,
            currentState: "open",
          }),
          makeInstance({ uuid: "00000000-0000-0000-0000-000000000065", definitionVersion: null, currentState: "open" }),
        ];
        for (const row of rows) {
          await transactionRunner.runInTransaction(() => store.create(row));
        }

        const count = (definitionVersion: number, excludeStates: readonly string[]) =>
          store.countInstances({ workflowName: "test-workflow", definitionVersion, excludeStates });
        expect(await count(1, ["closed"])).toBe(2);
        expect(await count(1, [])).toBe(3);
        expect(await count(1, ["open", "closed"])).toBe(0);
        expect(await count(2, ["closed"])).toBe(1);
        expect(await count(9, [])).toBe(0);
      } finally {
        await teardown();
      }
    });

    it("findInstanceUuids pages one workflow version's instances by uuid (optional)", async (ctx) => {
      const { store, transactionRunner, teardown } = await harness.setup();
      try {
        if (!store.findInstanceUuids) {
          ctx.skip();
          return;
        }
        const u = (n: number) => `00000000-0000-0000-0000-0000000000${n}`;
        const rows = [
          makeInstance({ uuid: u(72), definitionVersion: 1 }),
          makeInstance({ uuid: u(70), definitionVersion: 1 }),
          makeInstance({ uuid: u(74), definitionVersion: 2 }),
          makeInstance({ uuid: u(73), definitionVersion: 1, currentState: "closed" }),
          makeInstance({ uuid: u(75), workflowName: "other-workflow", definitionVersion: 1 }),
          makeInstance({ uuid: u(71), definitionVersion: 1 }),
          makeInstance({ uuid: u(76), definitionVersion: null }),
        ];
        for (const row of rows) {
          await transactionRunner.runInTransaction(() => store.create(row));
        }

        const find = (options: { definitionVersion?: number; limit?: number; afterUuid?: string }) =>
          store.findInstanceUuids!({
            workflowName: "test-workflow",
            definitionVersion: options.definitionVersion ?? 1,
            limit: options.limit ?? 10,
            afterUuid: options.afterUuid,
          });
        expect(await find({})).toEqual([u(70), u(71), u(72), u(73)]);
        expect(await find({ limit: 2 })).toEqual([u(70), u(71)]);
        expect(await find({ afterUuid: u(71) })).toEqual([u(72), u(73)]);
        expect(await find({ afterUuid: u(73) })).toEqual([]);
        expect(await find({ definitionVersion: 2 })).toEqual([u(74)]);
      } finally {
        await teardown();
      }
    });
  });
}
