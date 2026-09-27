import { runTransactionRunnerConformance } from "../../src/testing/index.js";
import { createInMemoryPersistence } from "../helpers/in-memory-persistence.js";

runTransactionRunnerConformance("in-memory", {
  setup: async () => {
    const { transactionRunner, instanceStore } = createInMemoryPersistence();
    return { runner: transactionRunner, store: instanceStore, teardown: async () => {} };
  },
});
