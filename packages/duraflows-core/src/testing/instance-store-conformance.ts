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
      expiresAt: null,
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
  });
}
