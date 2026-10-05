import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  WorkflowInstanceBusyError,
  IdempotencyConflictError,
  DurableExecutionNotSupportedError,
} from "../../src/index.js";
import type { WorkflowDefinition, WorkflowCommand, DurableExecutionOptions } from "../../src/index.js";
import { createInMemoryPersistence, InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";

const definition: WorkflowDefinition = {
  name: "durable",
  initialState: "new",
  states: {
    new: {
      events: {
        submit: { targetState: "entering", commands: [{ name: "charge" }, { name: "reserve" }] },
        guarded: { targetState: "done", guard: { name: "allowed" } },
        timeout: { targetState: "done", timeout: { afterMinutes: 1 } },
        note: { commands: [{ name: "charge" }] },
        fail: { targetState: "done", errorState: "failed", commands: [{ name: "reserve" }] },
        database: {
          targetState: "done",
          commands: [
            { name: "charge", transactional: true },
            { name: "reserve", transactional: true },
          ],
        },
      },
    },
    entering: { context: { stage: "entry" }, onEnter: { targetState: "done", commands: [{ name: "entry" }] } },
    failed: { onEnter: { targetState: "compensated", commands: [{ name: "refund" }] } },
    compensated: {},
    done: {},
  },
};

describe("durable command execution", () => {
  let p: ReturnType<typeof createInMemoryPersistence>;
  let runtime: WorkflowRuntime;
  let definitions: InMemoryDefinitionRegistry;
  let definitionStore: InMemoryDefinitionStore;
  let commands: InMemoryCommandRegistry;
  let guard: ReturnType<typeof vi.fn>;
  let observer: ReturnType<typeof vi.fn>;
  let now: number;
  let uuid: string;
  let charge: ReturnType<typeof vi.fn<WorkflowCommand["execute"]>>;
  let reserve: ReturnType<typeof vi.fn<WorkflowCommand["execute"]>>;
  let entry: ReturnType<typeof vi.fn<WorkflowCommand["execute"]>>;
  let refund: ReturnType<typeof vi.fn<WorkflowCommand["execute"]>>;
  const make = (options?: DurableExecutionOptions) =>
    new WorkflowRuntime({
      ...p,
      definitionRegistry: definitions,
      definitionStore,
      commandRegistry: commands,
      guardRegistry: { get: () => ({ name: "allowed", evaluate: guard }), has: () => true },
      clock: { now: () => new Date(now) },
      observers: [{ name: "observer", onEnter: observer }],
      durableExecution: { initialDelayMs: 10, maxDelayMs: 100, leaseDurationMs: 100, maxAttempts: 2, ...options },
    });
  beforeEach(async () => {
    p = createInMemoryPersistence({ durableExecution: true, idempotency: true });
    now = Date.parse("2026-10-04T00:00:00Z");
    definitions = new InMemoryDefinitionRegistry();
    definitions.register(definition);
    definitionStore = new InMemoryDefinitionStore();
    commands = new InMemoryCommandRegistry();
    charge = vi.fn((_subject, ctx) => {
      ctx.context.chargeId = "charge-1";
      return { ok: true };
    });
    reserve = vi.fn((_subject, ctx) => {
      expect(ctx.context.chargeId).toBeDefined();
      ctx.context.reserved = true;
      return { ok: true };
    });
    entry = vi.fn((_subject, ctx) => {
      expect(ctx.context.stage).toBe("entry");
      ctx.context.shipped = true;
      return { ok: true };
    });
    refund = vi.fn(() => ({ ok: true }));
    for (const [name, execute] of [
      ["charge", charge],
      ["reserve", reserve],
      ["entry", entry],
      ["refund", refund],
    ] as const)
      commands.register(name, { execute });
    guard = vi.fn(() => false);
    observer = vi.fn();
    runtime = make();
    uuid = (await runtime.createInstance({ workflowName: "durable" })).uuid;
    observer.mockClear();
  });
  const enqueue = (eventName = "submit", key = "request") =>
    runtime.enqueueEvent({ workflowInstanceUuid: uuid, eventName, idempotencyKey: key });

  it("checkpoints commands and context, recovers in a new runtime, and commits the full entry chain once", async () => {
    const e = await runtime.getHandle(uuid).enqueueEvent("submit", { idempotencyKey: "request" });
    expect((await runtime.processPendingExecutions()).progressed).toEqual([e.uuid]);
    expect((await runtime.getInstance(uuid))!.currentState).toBe("new");
    expect(await runtime.getHistory(uuid)).toHaveLength(0);
    expect(observer).not.toHaveBeenCalled();
    expect((await runtime.getExecution(e.uuid))!.journal[0].context).toEqual({ chargeId: "charge-1" });
    runtime = make();
    await runtime.processPendingExecutions();
    expect((await runtime.processPendingExecutions()).completed).toEqual([e.uuid]);
    expect(charge).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(entry).toHaveBeenCalledOnce();
    expect((await runtime.getInstance(uuid))!.context).toEqual({
      chargeId: "charge-1",
      reserved: true,
      stage: "entry",
      shipped: true,
    });
    expect(await runtime.getHistory(uuid)).toHaveLength(2);
    expect(observer).toHaveBeenCalledTimes(2);
    const completed = (await runtime.getExecution(e.uuid))!;
    expect(completed.result).toMatchObject({ toState: "done", outcome: "success" });
    expect(await enqueue()).toEqual(completed);
    expect((await runtime.processPendingExecutions()).processed).toBe(0);
  });

  it("retries only the interrupted command with a stable downstream identity", async () => {
    reserve.mockRejectedValueOnce(new Error("offline"));
    const e = await enqueue();
    await runtime.processPendingExecutions();
    expect((await runtime.processPendingExecutions()).retrying).toEqual([e.uuid]);
    expect((await runtime.processPendingExecutions()).processed).toBe(0);
    now += 10;
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    expect(charge).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledTimes(2);
    const first = reserve.mock.calls[0][1].durable!;
    const second = reserve.mock.calls[1][1].durable!;
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.attempt).toBe(2);
  });

  it("parks persistent exceptions, permits retry, and retains earlier checkpoints", async () => {
    const e = await enqueue();
    reserve.mockRejectedValue(new Error("offline"));
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    now += 10;
    expect((await runtime.processPendingExecutions()).parked).toEqual([e.uuid]);
    expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(1);
    await runtime.retryExecution(e.uuid);
    reserve.mockImplementation((_s, c) => {
      expect(c.context.chargeId).toBe("charge-1");
      return { ok: true };
    });
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    expect(charge).toHaveBeenCalledOnce();
  });

  it("deduplicates acceptance, detects conflicts, and protects active instances", async () => {
    const e = await enqueue();
    expect(await enqueue()).toEqual(e);
    await expect(enqueue("note")).rejects.toThrow(IdempotencyConflictError);
    await expect(
      runtime.enqueueEvent({
        workflowInstanceUuid: uuid,
        eventName: "submit",
        idempotencyKey: "request",
        idempotencyFingerprint: "other",
      }),
    ).rejects.toThrow(IdempotencyConflictError);
    await expect(enqueue("note", "other")).rejects.toThrow(WorkflowInstanceBusyError);
    await expect(runtime.triggerEvent({ workflowInstanceUuid: uuid, eventName: "note" })).rejects.toThrow(
      WorkflowInstanceBusyError,
    );
    await expect(runtime.rearmTimeout(uuid)).rejects.toThrow(WorkflowInstanceBusyError);
    now += 60001;
    expect((await runtime.processExpiredWorkflows()).processed).toBe(0);
    await runtime.cancelExecution(e.uuid);
    expect((await runtime.getExecution(e.uuid))!.status).toBe("cancelled");
    await runtime.triggerEvent({ workflowInstanceUuid: uuid, eventName: "note" });
  });

  it("commits guard rejection at acceptance and never reevaluates it", async () => {
    const e = await enqueue("guarded");
    expect(e.result?.outcome).toBe("guard-rejected");
    guard.mockReturnValue(true);
    expect(await enqueue("guarded")).toEqual(e);
    expect(guard).toHaveBeenCalledOnce();
    const accepted = await enqueue("guarded", "new");
    expect((await runtime.processPendingExecutions()).completed).toEqual([accepted.uuid]);
  });

  it("rolls enqueue back with its caller and refuses workers inside a transaction", async () => {
    await expect(
      p.transactionRunner.runInTransaction(async () => {
        await enqueue();
        await expect(runtime.processPendingExecutions()).rejects.toThrow("outside a transaction");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await p.executionStore!.findActive(uuid)).toBeNull();
    expect(await enqueue()).toMatchObject({ status: "pending" });
  });

  it("supports routed failure and checkpoints compensation commands", async () => {
    reserve.mockReturnValue({ ok: false, code: "NO_STOCK" });
    const e = await enqueue("fail");
    await runtime.processPendingExecutions();
    expect((await runtime.processPendingExecutions()).completed).toEqual([e.uuid]);
    expect(refund).toHaveBeenCalledOnce();
    expect((await runtime.getExecution(e.uuid))!.result).toMatchObject({ outcome: "failure", toState: "compensated" });
  });

  it("parks an unrouted business failure without erasing completed commands", async () => {
    reserve.mockReturnValue({ ok: false });
    const e = await enqueue();
    await runtime.processPendingExecutions();
    expect((await runtime.processPendingExecutions()).parked).toEqual([e.uuid]);
    expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(2);
    await runtime.cancelExecution(e.uuid);
    expect((await runtime.getInstance(uuid))!.currentState).toBe("new");
  });

  it("uses immutable JSON input snapshots and does not let callers mutate stored executions", async () => {
    const subject = { orderId: "original" };
    const e = await runtime.enqueueEvent({
      workflowInstanceUuid: uuid,
      eventName: "note",
      idempotencyKey: "key",
      subject,
    });
    subject.orderId = "changed";
    e.initialContext.changed = true;
    charge.mockImplementation((s, c) => {
      expect(s).toEqual({ orderId: "original" });
      expect(Object.isFrozen(s)).toBe(true);
      expect(c.context).toEqual({});
      return { ok: true };
    });
    await runtime.processPendingExecutions();
    expect((await runtime.getExecution(e.uuid))!.initialContext).toEqual({});
  });

  it.each([() => 1, new Date(), { a: undefined }, { a: 1n }, Number.NaN])(
    "rejects unrecoverable input %#",
    async (subject) => {
      await expect(
        runtime.enqueueEvent({ workflowInstanceUuid: uuid, eventName: "note", idempotencyKey: "key", subject }),
      ).rejects.toThrow("Durable inputs");
    },
  );

  it("rolls a transactional command's writes back when checkpoint serialization fails", async () => {
    const business = await runtime.createInstance({ workflowName: "durable" });
    charge.mockImplementation(async () => {
      const row = (await p.instanceStore.lockByUuid(business.uuid))!;
      row.context.changed = true;
      row.version++;
      await p.instanceStore.update(row);
      return { ok: true, metadata: { bad: 1n } };
    });
    const e = await enqueue("database");
    expect((await runtime.processPendingExecutions()).retrying).toEqual([e.uuid]);
    expect((await runtime.getInstance(business.uuid))!.context).toEqual({});
    expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(0);
  });

  it("rolls back partial finalization and retries without rerunning earlier commands", async () => {
    const e = await enqueue();
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    vi.spyOn(p.historyStore, "append").mockRejectedValueOnce(new Error("storage"));
    expect((await runtime.processPendingExecutions()).retrying).toEqual([e.uuid]);
    expect((await runtime.getInstance(uuid))!.currentState).toBe("new");
    expect(await runtime.getHistory(uuid)).toHaveLength(0);
    expect(observer).not.toHaveBeenCalled();
    now += 10;
    await runtime.processPendingExecutions();
    expect(charge).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(entry).toHaveBeenCalledTimes(2);
  });

  it("heartbeats extend leases; expired owners cannot checkpoint", async () => {
    const e = await enqueue("note");
    charge.mockImplementation(async (_s, c) => {
      now += 80;
      await c.durable!.heartbeat();
      now += 80;
      return { ok: true };
    });
    expect((await runtime.processPendingExecutions()).completed).toEqual([e.uuid]);
    const other = await runtime.createInstance({ workflowName: "durable" });
    uuid = other.uuid;
    const expired = await enqueue("note");
    charge.mockImplementation(() => {
      now += 101;
      return { ok: true };
    });
    expect((await runtime.processPendingExecutions()).skipped).toEqual([expired.uuid]);
    expect((await runtime.getExecution(expired.uuid))!.journal).toHaveLength(0);
    charge.mockReturnValue({ ok: true });
    expect((await runtime.processPendingExecutions()).completed).toEqual([expired.uuid]);
  });

  it("rejects missing capability and invalid worker policy", async () => {
    const noStore = new WorkflowRuntime({
      ...p,
      executionStore: undefined,
      definitionRegistry: definitions,
      commandRegistry: commands,
      clock: { now: () => new Date(now) },
    });
    await expect(
      noStore.enqueueEvent({ workflowInstanceUuid: uuid, eventName: "note", idempotencyKey: "key" }),
    ).rejects.toThrow(DurableExecutionNotSupportedError);
    expect(() => make({ leaseDurationMs: 0 })).toThrow();
    expect(() => make({ maxDelayMs: 1, initialDelayMs: 2 })).toThrow();
    await expect(runtime.processPendingExecutions({ limit: 0 })).rejects.toThrow();
    expect(await runtime.getExecution("missing")).toBeNull();
  });
  it("snapshots input before initialization yields and preserves JSON property names", async () => {
    const subject = { value: "before" };
    const input = { workflowInstanceUuid: uuid, eventName: "note", idempotencyKey: "key", subject };
    const accepted = runtime.enqueueEvent(input);
    subject.value = "after";
    input.eventName = "missing";
    const e = await accepted;
    charge.mockImplementation((s, c) => {
      expect(s).toEqual({ value: "before" });
      Object.defineProperty(c.context, "__proto__", { value: { value: 1 }, enumerable: true });
      return { ok: true };
    });
    await runtime.processPendingExecutions();
    const context = (await runtime.getInstance(uuid))!.context;
    expect(Object.hasOwn(context, "__proto__")).toBe(true);
    expect(context.value).toBeUndefined();
    expect((await runtime.getExecution(e.uuid))!.status).toBe("completed");
  });

  it("parks repeated lease expirations at the attempt limit", async () => {
    const e = await enqueue("note");
    charge.mockImplementation(() => {
      now += 101;
      return { ok: true };
    });
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    expect((await runtime.processPendingExecutions()).parked).toEqual([e.uuid]);
    expect(charge).toHaveBeenCalledTimes(2);
    await runtime.retryExecution(e.uuid);
    charge.mockReturnValue({ ok: true });
    expect((await runtime.processPendingExecutions()).completed).toEqual([e.uuid]);
  });

  it("retains best-effort failures and resumes the next command", async () => {
    const bestEffort = new InMemoryCommandRegistry();
    bestEffort.register("charge", { bestEffort: true, execute: charge });
    for (const [name, execute] of [
      ["reserve", reserve],
      ["entry", entry],
      ["refund", refund],
    ] as const)
      bestEffort.register(name, { execute });
    commands = bestEffort;
    runtime = make();
    charge.mockRejectedValue("optional failure");
    reserve.mockReturnValue({ ok: true });
    const e = await enqueue();
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    expect((await runtime.getExecution(e.uuid))!.result).toMatchObject({
      outcome: "success",
      commandResults: [{ ok: false, code: "BEST_EFFORT_THROWN" }, { ok: true }, { ok: true }],
    });
  });

  it("validates identity, missing instances, invalid events and operator actions", async () => {
    for (const key of ["", " ", "é".repeat(129), "\0", "\ud800"])
      await expect(enqueue("note", key)).rejects.toThrow("Durable keys");
    await expect(enqueue("missing")).rejects.toThrow("not available");
    await expect(
      runtime.enqueueEvent({ workflowInstanceUuid: "missing", eventName: "note", idempotencyKey: "key" }),
    ).rejects.toThrow("not found");
    await expect(runtime.retryExecution("missing")).rejects.toThrow("not found");
    const e = await enqueue("note");
    await expect(runtime.retryExecution(e.uuid)).rejects.toThrow("Only parked");
    charge.mockImplementation(async () => {
      await expect(runtime.cancelExecution(e.uuid)).rejects.toThrow("actively leased");
      return { ok: true };
    });
    await runtime.processPendingExecutions();
    await expect(runtime.cancelExecution(e.uuid)).rejects.toThrow("completed");
  });

  it("rejects a worker whose transaction runner cannot detect ambient transactions", async () => {
    p.transactionRunner.isTransactionActive = undefined as unknown as () => boolean;
    await expect(runtime.processPendingExecutions()).rejects.toThrow("ambient-transaction detection");
  });

  it("reports storage errors and ignores stale candidate pages", async () => {
    const e = await enqueue("note");
    const due = vi.spyOn(p.executionStore!, "findDue");
    due.mockResolvedValueOnce([e]);
    await runtime.cancelExecution(e.uuid);
    expect((await runtime.processPendingExecutions()).skipped).toEqual([e.uuid]);
    const next = await enqueue("note", "next");
    vi.spyOn(p.executionStore!, "findByUuid").mockRejectedValueOnce(new Error("read failed"));
    expect((await runtime.processPendingExecutions()).failed).toEqual([{ uuid: next.uuid, error: "read failed" }]);
    charge.mockRejectedValue(new Error("command failed"));
    const update = vi.spyOn(p.executionStore!, "update");
    const original = update.getMockImplementation()!;
    update.mockImplementationOnce(original).mockRejectedValueOnce(new Error("retry save failed"));
    expect((await runtime.processPendingExecutions()).failed).toEqual([
      { uuid: next.uuid, error: "retry save failed" },
    ]);
  });

  it("retries malformed command results without storing a checkpoint", async () => {
    charge.mockReturnValue(undefined as never);
    const e = await enqueue("note");
    expect((await runtime.processPendingExecutions()).retrying).toEqual([e.uuid]);
    expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(0);
  });
  it("pins an accepted plan across deployment and blocks migration until cancellation", async () => {
    const e = await enqueue();
    await runtime.processPendingExecutions();
    definitions = new InMemoryDefinitionRegistry();
    definitions.register({
      ...definition,
      version: 2,
      versionPolicy: "latest",
      states: { ...definition.states, new: { events: { submit: { targetState: "done" } } } },
    });
    runtime = make();
    await runtime.initialize();
    const migration = await runtime.migrateInstances({
      workflowName: "durable",
      fromVersion: 1,
      toVersion: 2,
      instanceUuids: [uuid],
    });
    expect(migration.failed).toHaveLength(1);
    expect(migration.failed[0].error).toContain("active durable execution");
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    expect(entry).toHaveBeenCalledOnce();
    expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(3);
    expect((await runtime.getInstance(uuid))!.definitionVersion).toBe(1);
  });

  it("fences direct instance changes before claiming and before committing", async () => {
    const e = await enqueue("note");
    const change = async () => {
      await p.transactionRunner.runInTransaction(async () => {
        const instance = (await p.instanceStore.lockByUuid(uuid))!;
        instance.version++;
        await p.instanceStore.update(instance);
      });
    };
    await change();
    expect((await runtime.processPendingExecutions()).failed[0].error).toContain("Instance changed");
    expect(charge).not.toHaveBeenCalled();
    await runtime.cancelExecution(e.uuid);
    const next = await enqueue("note", "next");
    charge.mockImplementation(async () => {
      await change();
      return { ok: true };
    });
    expect((await runtime.processPendingExecutions()).failed[0].error).toContain("Instance changed");
    expect((await runtime.getExecution(next.uuid))!.journal).toHaveLength(0);
  });

  it("rolls back a transactional command that outlives its lease", async () => {
    const e = await enqueue("database");
    charge.mockImplementation(() => {
      now += 101;
      return { ok: true };
    });
    expect((await runtime.processPendingExecutions()).skipped).toEqual([e.uuid]);
    expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(0);
  });
  it("does not let an occupied instance starve unrelated timeout work at the batch limit", async () => {
    await enqueue("note");
    now += 1;
    const idle = await runtime.createInstance({ workflowName: "durable" });
    now += 60001;
    expect((await runtime.processExpiredWorkflows({ limit: 1 })).processed).toBe(1);
    expect((await runtime.getInstance(idle.uuid))!.currentState).toBe("done");
    expect((await runtime.getInstance(uuid))!.currentState).toBe("new");
  });

  it("recovers entry failure routing into compensation", async () => {
    definitions.register({
      name: "entry-failure",
      initialState: "new",
      states: {
        new: { events: { go: { targetState: "entering" } } },
        entering: { onEnter: { commands: [{ name: "entry" }], errorState: "failed" } },
        failed: { onEnter: { commands: [{ name: "refund" }], targetState: "done" } },
        done: {},
      },
    });
    runtime = make();
    uuid = (await runtime.createInstance({ workflowName: "entry-failure" })).uuid;
    entry.mockReturnValue({ ok: false, code: "ENTRY_FAILED" });
    const e = await enqueue("go");
    await runtime.processPendingExecutions();
    runtime = make();
    expect((await runtime.processPendingExecutions()).completed).toEqual([e.uuid]);
    expect(entry).toHaveBeenCalledOnce();
    expect(refund).toHaveBeenCalledOnce();
    expect((await runtime.getExecution(e.uuid))!.result).toMatchObject({ outcome: "failure", toState: "done" });
    expect((await runtime.getHistory(uuid)).find((row) => row.outcome === "failure")!.errorMessage).toBe(
      "ENTRY_FAILED",
    );
  });

  it("assigns distinct stable identities to repeated occurrences of a command", async () => {
    definitions.register({
      name: "repeated-command",
      initialState: "new",
      states: {
        new: { events: { go: { targetState: "done", commands: [{ name: "charge" }, { name: "charge" }] } } },
        done: {},
      },
    });
    runtime = make();
    uuid = (await runtime.createInstance({ workflowName: "repeated-command" })).uuid;
    charge.mockReturnValueOnce({ ok: true }).mockRejectedValueOnce(new Error("retry occurrence"));
    const e = await enqueue("go");
    await runtime.processPendingExecutions();
    await runtime.processPendingExecutions();
    now += 10;
    runtime = make();
    expect((await runtime.processPendingExecutions()).completed).toEqual([e.uuid]);
    const keys = charge.mock.calls.map(([, ctx]) => ctx.durable!.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    expect((await runtime.getExecution(e.uuid))!.journal.map((row) => row.id)).toEqual(["0", "1"]);
  });
});
