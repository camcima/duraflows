import { describe, it, expect } from "vitest";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { InvalidArgumentError } from "../../src/errors/index.js";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
} from "../../src/types/persistence.js";

// Validation must reject before any store call — these stubs prove it.
const unreachable = () => {
  throw new Error("store must not be reached when input validation fails");
};
const instanceStore = {
  create: unreachable,
  findByUuid: unreachable,
  lockByUuid: unreachable,
  update: unreachable,
  findExpired: unreachable,
} as unknown as WorkflowInstanceStore;
const historyStore = {
  append: unreachable,
  findByInstanceUuid: unreachable,
} as unknown as WorkflowHistoryStore;
const transactionRunner: WorkflowTransactionRunner = {
  runInTransaction: async (callback) => callback(),
};

function baseOptions() {
  return {
    definitionRegistry: new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    }),
    commandRegistry: new InMemoryCommandRegistry(),
    instanceStore,
    historyStore,
    transactionRunner,
    clock: { now: () => new Date("2026-01-01T00:00:00Z") },
  };
}

describe("WorkflowRuntime input validation (AR-05)", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects processExpiredWorkflows limit %s",
    async (limit) => {
      const runtime = new WorkflowRuntime(baseOptions());
      await expect(runtime.processExpiredWorkflows({ limit })).rejects.toBeInstanceOf(InvalidArgumentError);
    },
  );

  it.each([0, -1, 1.5, Number.NaN])("rejects getHistory limit %s", async (limit) => {
    const runtime = new WorkflowRuntime(baseOptions());
    await expect(runtime.getHistory("some-uuid", { limit })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it.each([-1, 1.5, Number.NaN])("rejects getHistory offset %s", async (offset) => {
    const runtime = new WorkflowRuntime(baseOptions());
    await expect(runtime.getHistory("some-uuid", { offset })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxOnEnterDepth %s at construction",
    (maxOnEnterDepth) => {
      expect(() => new WorkflowRuntime({ ...baseOptions(), maxOnEnterDepth })).toThrow(InvalidArgumentError);
    },
  );

  it("accepts valid values", () => {
    expect(() => new WorkflowRuntime({ ...baseOptions(), maxOnEnterDepth: 5 })).not.toThrow();
  });
});
