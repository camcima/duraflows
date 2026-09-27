import { runTransactionRunnerConformance } from "../../src/testing/index.js";
import { createInMemoryPersistence } from "../helpers/in-memory-persistence.js";

runTransactionRunnerConformance("in-memory", {
  setup: async () => {
    const { transactionRunner, instanceStore } = createInMemoryPersistence();
    return {
      runner: transactionRunner,
      store: instanceStore,
      // No database here: a thrown error stands in for a failed statement.
      failWithDatabaseError: async () => {
        throw new Error("simulated database error");
      },
      teardown: async () => {},
    };
  },
});
