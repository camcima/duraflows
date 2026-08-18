/**
 * Conformance suite self-test: verifies that runDefinitionStoreConformance works
 * end-to-end by running it against the in-memory store used throughout the
 * core integration tests. This both demonstrates the helper and ensures it
 * stays in sync with the interface.
 */
import { runDefinitionStoreConformance } from "../../src/testing/index.js";
import { InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";

// ---------------------------------------------------------------------------
// Run the shared conformance suite
// ---------------------------------------------------------------------------

runDefinitionStoreConformance("InMemoryDefinitionStore (core self-test)", {
  setup: async () => ({
    store: new InMemoryDefinitionStore(),
    teardown: async () => {
      // In-memory: nothing to tear down
    },
  }),
});
