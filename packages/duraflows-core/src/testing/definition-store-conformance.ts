import { describe, it, expect } from "vitest";
import type { WorkflowDefinitionStore, WorkflowDefinition } from "../index.js";

export interface DefinitionStoreConformanceHarness {
  /**
   * Build a fresh store for a single test. Called once per test. The returned
   * `teardown` is always called in a `finally` block — use it to clear state.
   */
  setup(): Promise<{
    store: WorkflowDefinitionStore;
    teardown: () => Promise<void>;
  }>;
}

/**
 * Run the standard conformance suite against an adapter's
 * `WorkflowDefinitionStore`. Adapters call this from their own test file to
 * verify they satisfy the cross-adapter contract.
 *
 * @example
 * ```ts
 * import { runDefinitionStoreConformance } from "@duraflows/core/testing";
 *
 * runDefinitionStoreConformance("my-adapter", {
 *   setup: async () => ({
 *     store: new MyDefinitionStore(),
 *     teardown: async () => {},
 *   }),
 * });
 * ```
 */
export function runDefinitionStoreConformance(label: string, harness: DefinitionStoreConformanceHarness): void {
  describe(`WorkflowDefinitionStore conformance: ${label}`, () => {
    const definitionJson: WorkflowDefinition = {
      name: "conformance-wf",
      version: 1,
      initialState: "start",
      states: {
        start: { events: { Go: { targetState: "done" } } },
        done: {},
      },
    };
    const record = {
      workflowName: "conformance-wf",
      version: 1,
      contentHash: `sha256:${"ab".repeat(32)}`,
      definitionJson,
    };

    it("ensure inserts a new snapshot and returns it", async () => {
      const { store, teardown } = await harness.setup();
      try {
        const stored = await store.ensure(record);
        expect(stored.workflowName).toBe("conformance-wf");
        expect(stored.version).toBe(1);
        expect(stored.contentHash).toBe(record.contentHash);
        expect(stored.registeredAt).toBeInstanceOf(Date);
      } finally {
        await teardown();
      }
    });

    it("ensure returns the existing row unchanged when (name, version) already exists", async () => {
      const { store, teardown } = await harness.setup();
      try {
        await store.ensure(record);
        const second = await store.ensure({
          ...record,
          contentHash: `sha256:${"cd".repeat(32)}`,
        });
        expect(second.contentHash).toBe(record.contentHash);
      } finally {
        await teardown();
      }
    });

    it("findByNameAndVersion retrieves a stored snapshot with a structurally equal definition", async () => {
      const { store, teardown } = await harness.setup();
      try {
        await store.ensure(record);
        const found = await store.findByNameAndVersion("conformance-wf", 1);
        expect(found).not.toBeNull();
        expect(found!.definitionJson).toEqual(definitionJson);
      } finally {
        await teardown();
      }
    });

    it("findByNameAndVersion returns null for an unknown version", async () => {
      const { store, teardown } = await harness.setup();
      try {
        await store.ensure(record);
        expect(await store.findByNameAndVersion("conformance-wf", 99)).toBeNull();
        expect(await store.findByNameAndVersion("no-such-wf", 1)).toBeNull();
      } finally {
        await teardown();
      }
    });

    it("versions of the same workflow are independent rows", async () => {
      const { store, teardown } = await harness.setup();
      try {
        await store.ensure(record);
        await store.ensure({
          ...record,
          version: 2,
          contentHash: `sha256:${"ef".repeat(32)}`,
        });
        const v1 = await store.findByNameAndVersion("conformance-wf", 1);
        const v2 = await store.findByNameAndVersion("conformance-wf", 2);
        expect(v1!.contentHash).toBe(record.contentHash);
        expect(v2!.contentHash).toBe(`sha256:${"ef".repeat(32)}`);
      } finally {
        await teardown();
      }
    });
  });
}
