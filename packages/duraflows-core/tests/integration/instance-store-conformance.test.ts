/**
 * Conformance suite self-test: verifies that runInstanceStoreConformance works
 * end-to-end by running it against the in-memory store used throughout the
 * core integration tests. This both demonstrates the helper and ensures it
 * stays in sync with the interface.
 */
import { runInstanceStoreConformance } from "../../src/testing/index.js";
import { createInMemoryPersistence } from "../helpers/in-memory-persistence.js";

// ---------------------------------------------------------------------------
// Run the shared conformance suite
// ---------------------------------------------------------------------------

runInstanceStoreConformance("InMemoryInstanceStore (core self-test)", {
  setup: async () => {
    const { instanceStore, transactionRunner } = createInMemoryPersistence();
    return {
      store: instanceStore,
      transactionRunner,
      teardown: async () => {
        // In-memory: nothing to tear down
      },
    };
  },
});
