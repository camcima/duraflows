import "reflect-metadata";
import { describe, it, expect } from "vitest";
import {
  WorkflowCommand,
  WORKFLOW_COMMAND_METADATA_KEY,
} from "../../src/decorators/workflow-command.decorator.js";

describe("WorkflowCommand decorator", () => {
  it("applies @Injectable metadata to the target class", () => {
    class TestCmd {
      async execute() {
        return { ok: true };
      }
    }

    WorkflowCommand("test-cmd")(TestCmd);

    // NestJS @Injectable sets this metadata key (__injectable__)
    const isInjectable = Reflect.hasMetadata("__injectable__", TestCmd);
    expect(isInjectable).toBe(true);
  });

  it("stores the command name via the discovery decorator metadata", () => {
    class TestCmd {
      async execute() {
        return { ok: true };
      }
    }

    WorkflowCommand("my-command")(TestCmd);

    const metadata = Reflect.getMetadata(WORKFLOW_COMMAND_METADATA_KEY, TestCmd);
    expect(metadata).toBe("my-command");
  });

  it("decorated class can still be instantiated", () => {
    @WorkflowCommand("instantiable-cmd")
    class TestCmd {
      async execute() {
        return { ok: true };
      }
    }

    const instance = new TestCmd();
    expect(instance).toBeInstanceOf(TestCmd);
  });
});
