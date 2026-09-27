import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { InvalidArgumentError, WorkflowInstanceNotFoundError } from "../../src/errors/index.js";
import { createInMemoryPersistence } from "../helpers/in-memory-persistence.js";
import type { WorkflowInstance } from "../../src/types/runtime.js";

describe("processExpiredWorkflows retry scheduling and parking", () => {
  let now: number;
  let persistence: ReturnType<typeof createInMemoryPersistence>;
  let runtime: WorkflowRuntime;
  let brokenFails: boolean;

  const minutes = (n: number) => n * 60_000;

  beforeEach(() => {
    now = new Date("2026-01-01T00:00:00Z").getTime();
    brokenFails = true;
    persistence = createInMemoryPersistence();
    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    const commandRegistry = new InMemoryCommandRegistry();
    definitionRegistry.register({
      name: "broken",
      initialState: "start",
      states: {
        start: {
          events: {
            expire: { targetState: "done", commands: [{ name: "flaky" }], timeout: { afterMinutes: 1 } },
            fix: { targetState: "fixed" },
          },
        },
        done: {},
        fixed: {},
      },
    });
    definitionRegistry.register({
      name: "healthy",
      initialState: "start",
      states: { start: { events: { expire: { targetState: "done", timeout: { afterMinutes: 1 } } } }, done: {} },
    });
    commandRegistry.register("flaky", {
      execute: async () => {
        if (brokenFails) throw new Error("js boom");
        return { ok: true };
      },
    });
    runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      ...persistence,
      clock: { now: () => new Date(now) },
      timeoutRetry: { initialDelayMs: minutes(1), maxDelayMs: minutes(4), maxAttempts: 3 },
    });
  });

  const stored = async (uuid: string): Promise<WorkflowInstance> => (await persistence.instanceStore.findByUuid(uuid))!;

  it("lets healthy instances progress past a batch of failing ones (starvation regression)", async () => {
    const broken = [];
    for (let i = 0; i < 3; i++) broken.push(await runtime.createInstance({ workflowName: "broken" }));
    now += 1000;
    const healthy = [
      await runtime.createInstance({ workflowName: "healthy" }),
      await runtime.createInstance({ workflowName: "healthy" }),
    ];
    now += minutes(5);

    for (let sweep = 0; sweep < 3; sweep++) await runtime.processExpiredWorkflows({ limit: 2 });

    for (const h of healthy) expect((await stored(h.uuid)).currentState).toBe("done");
    for (const b of broken) expect((await stored(b.uuid)).timeoutRetry?.attempts).toBe(1);
  });

  it("schedules a retry after a failure and skips the instance until it is due", async () => {
    const instance = await runtime.createInstance({ workflowName: "broken" });
    now += minutes(5);

    const first = await runtime.processExpiredWorkflows();

    expect(first.failed).toEqual([
      { uuid: instance.uuid, error: "js boom", attempts: 1, retryAt: new Date(now + minutes(1)) },
    ]);
    expect(first.parked).toEqual([]);
    expect((await stored(instance.uuid)).timeoutRetry).toEqual({
      attempts: 1,
      lastError: "js boom",
      retryAt: new Date(now + minutes(1)),
      parkedAt: null,
    });

    const tooEarly = await runtime.processExpiredWorkflows();
    expect(tooEarly.failed).toEqual([]);

    now += minutes(1) + 1;
    const second = await runtime.processExpiredWorkflows();
    expect(second.failed[0]).toMatchObject({ attempts: 2, retryAt: new Date(now + minutes(2)) });
  });

  it("parks after maxAttempts and never picks a parked instance again", async () => {
    const instance = await runtime.createInstance({ workflowName: "broken" });
    now += minutes(5);
    await runtime.processExpiredWorkflows();
    now += minutes(1) + 1;
    await runtime.processExpiredWorkflows();
    now += minutes(2) + 1;

    const third = await runtime.processExpiredWorkflows();

    expect(third.parked).toEqual([{ uuid: instance.uuid, error: "js boom" }]);
    expect(third.failed[0]).toMatchObject({ attempts: 3, retryAt: null });
    expect((await stored(instance.uuid)).timeoutRetry).toMatchObject({
      attempts: 3,
      retryAt: null,
      parkedAt: new Date(now),
    });

    now += minutes(600);
    const later = await runtime.processExpiredWorkflows();
    expect(later.failed).toEqual([]);
    expect(later.processed).toBe(0);
  });

  it("clears the retry state when a retry finally succeeds", async () => {
    const instance = await runtime.createInstance({ workflowName: "broken" });
    now += minutes(5);
    await runtime.processExpiredWorkflows();
    brokenFails = false;
    now += minutes(1) + 1;

    const result = await runtime.processExpiredWorkflows();

    expect(result.processed).toBe(1);
    expect((await stored(instance.uuid)).currentState).toBe("done");
    expect((await stored(instance.uuid)).timeoutRetry).toBeNull();
  });

  it("clears the retry state (and un-parks) when a user moves the instance on", async () => {
    const instance = await runtime.createInstance({ workflowName: "broken" });
    now += minutes(5);
    for (const step of [0, minutes(1) + 1, minutes(2) + 1]) {
      now += step;
      await runtime.processExpiredWorkflows();
    }
    expect((await stored(instance.uuid)).timeoutRetry?.parkedAt).not.toBeNull();

    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "fix" });

    expect((await stored(instance.uuid)).currentState).toBe("fixed");
    expect((await stored(instance.uuid)).timeoutRetry).toBeNull();
  });

  it.each([
    ["the state changed", (i: WorkflowInstance): WorkflowInstance | null => ({ ...i, currentState: "elsewhere" })],
    [
      "another sweep already recorded this failure",
      (i: WorkflowInstance): WorkflowInstance | null => ({
        ...i,
        timeoutRetry: { attempts: 1, lastError: "x", retryAt: new Date(now), parkedAt: null },
      }),
    ],
    ["the instance was deleted", (): WorkflowInstance | null => null],
  ])("records nothing when %s before the failure is recorded", async (_label, alter) => {
    const instance = await runtime.createInstance({ workflowName: "broken" });
    now += minutes(5);
    const originalLock = persistence.instanceStore.lockByUuid.bind(persistence.instanceStore);
    let locks = 0;
    vi.spyOn(persistence.instanceStore, "lockByUuid").mockImplementation(async (uuid) => {
      const found = await originalLock(uuid);
      locks++;
      // Lock 1: the failing attempt. Lock 2: the failure-recording transaction.
      return locks === 2 && found ? alter(found) : found;
    });

    const result = await runtime.processExpiredWorkflows();

    expect(result.failed).toEqual([{ uuid: instance.uuid, error: "js boom" }]);
    expect((await stored(instance.uuid)).timeoutRetry).toBeNull();
  });

  it("skips an instance whose retry another worker scheduled after this sweep's scan", async () => {
    const instance = await runtime.createInstance({ workflowName: "broken" });
    now += minutes(5);
    const originalLock = persistence.instanceStore.lockByUuid.bind(persistence.instanceStore);
    vi.spyOn(persistence.instanceStore, "lockByUuid").mockImplementation(async (uuid) => {
      const found = await originalLock(uuid);
      return (
        found && {
          ...found,
          timeoutRetry: { attempts: 1, lastError: "x", retryAt: new Date(now + minutes(1)), parkedAt: null },
        }
      );
    });

    const result = await runtime.processExpiredWorkflows();

    expect(result).toMatchObject({ processed: 0, failed: [] });
    expect((await stored(instance.uuid)).currentState).toBe("start");
  });

  it("still completes the sweep and warns when recording the failure itself fails", async () => {
    const instance = await runtime.createInstance({ workflowName: "broken" });
    now += minutes(5);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalUpdate = persistence.instanceStore.update.bind(persistence.instanceStore);
    vi.spyOn(persistence.instanceStore, "update").mockImplementation(async (i) => {
      if (i.timeoutRetry) throw new Error("database unavailable");
      return originalUpdate(i);
    });

    const result = await runtime.processExpiredWorkflows();

    expect(result.failed).toEqual([{ uuid: instance.uuid, error: "js boom" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
    warn.mockRestore();
  });

  it("rejects an invalid timeoutRetry option at construction", () => {
    expect(
      () =>
        new WorkflowRuntime({
          definitionRegistry: new InMemoryDefinitionRegistry(),
          commandRegistry: new InMemoryCommandRegistry(),
          ...createInMemoryPersistence(),
          clock: { now: () => new Date() },
          timeoutRetry: { maxAttempts: 0 },
        }),
    ).toThrow(InvalidArgumentError);
  });

  describe("operator API", () => {
    const parkBroken = async (): Promise<WorkflowInstance> => {
      const instance = await runtime.createInstance({ workflowName: "broken" });
      now += minutes(5);
      for (const step of [0, minutes(1) + 1, minutes(2) + 1]) {
        now += step;
        await runtime.processExpiredWorkflows();
      }
      return instance;
    };

    it("findParkedTimeouts lists parked instances, filtered by workflow name", async () => {
      const instance = await parkBroken();

      expect((await runtime.findParkedTimeouts()).map((i) => i.uuid)).toEqual([instance.uuid]);
      expect(await runtime.findParkedTimeouts({ workflowName: "healthy" })).toEqual([]);
    });

    it("findParkedTimeouts rejects an invalid limit", async () => {
      await expect(runtime.findParkedTimeouts({ limit: 0 })).rejects.toThrow(InvalidArgumentError);
    });

    it("rearmTimeout clears a parked instance so the next sweep retries it", async () => {
      const instance = await parkBroken();

      const rearmed = await runtime.rearmTimeout(instance.uuid);

      expect(rearmed.timeoutRetry).toBeNull();
      expect(await runtime.findParkedTimeouts()).toEqual([]);
      brokenFails = false;
      const result = await runtime.processExpiredWorkflows();
      expect(result.processed).toBe(1);
      expect((await stored(instance.uuid)).currentState).toBe("done");
    });

    it("rearmTimeout leaves an instance without retry state untouched", async () => {
      const instance = await runtime.createInstance({ workflowName: "healthy" });

      const result = await runtime.rearmTimeout(instance.uuid);

      expect(result.version).toBe(instance.version);
      expect((await stored(instance.uuid)).version).toBe(instance.version);
    });

    it("rearmTimeout throws for an unknown instance", async () => {
      await expect(runtime.rearmTimeout("00000000-0000-0000-0000-00000000dead")).rejects.toThrow(
        WorkflowInstanceNotFoundError,
      );
    });
  });
});
