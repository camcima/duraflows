import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  InMemoryGuardRegistry,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyNotSupportedError,
  InvalidArgumentError,
  computeDefinitionHash,
} from "../../src/index.js";
import type { CommandResult, TriggerWorkflowEventInput, WorkflowDefinition } from "../../src/index.js";
import { runIdempotencyStoreConformance } from "../../src/testing/index.js";
import { createInMemoryPersistence, InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";

const definition: WorkflowDefinition = {
  name: "idempotent-order",
  initialState: "new",
  states: {
    new: {
      events: {
        submit: { targetState: "processing", commands: [{ name: "work" }] },
        note: { commands: [{ name: "work" }] },
        poll: { targetState: "new", commands: [{ name: "work" }] },
        guarded: { targetState: "done", guard: { name: "allowed" }, commands: [{ name: "work" }] },
        fail: { targetState: "done", errorState: "failed", commands: [{ name: "work" }] },
      },
    },
    processing: { onEnter: { targetState: "done", commands: [{ name: "enter" }] } },
    done: { events: { close: { targetState: "closed" } } },
    failed: {},
    closed: {},
  },
};

describe("event idempotency", () => {
  let persistence: ReturnType<typeof createInMemoryPersistence>;
  let runtime: WorkflowRuntime;
  let registry: InMemoryDefinitionRegistry;
  let definitions: InMemoryDefinitionStore;
  let commands: InMemoryCommandRegistry;
  let work: ReturnType<typeof vi.fn<() => Promise<CommandResult>>>;
  let enter: ReturnType<typeof vi.fn<() => Promise<CommandResult>>>;
  let guard: ReturnType<typeof vi.fn<() => boolean>>;
  let observe: ReturnType<typeof vi.fn>;
  let uuid: string;

  beforeEach(async () => {
    persistence = createInMemoryPersistence({ idempotency: true });
    registry = new InMemoryDefinitionRegistry();
    registry.register(definition);
    definitions = new InMemoryDefinitionStore();
    commands = new InMemoryCommandRegistry();
    work = vi.fn(async () => ({ ok: true }));
    enter = vi.fn(async () => ({ ok: true }));
    commands.register("work", { execute: work });
    commands.register("enter", { execute: enter });
    guard = vi.fn(() => false);
    const guards = new InMemoryGuardRegistry();
    guards.register("allowed", { name: "allowed", evaluate: guard });
    observe = vi.fn();
    runtime = new WorkflowRuntime({
      ...persistence,
      definitionRegistry: registry,
      definitionStore: definitions,
      commandRegistry: commands,
      guardRegistry: guards,
      clock: { now: () => new Date("2026-10-03T00:00:00Z") },
      observers: [{ name: "observe", onEnter: observe }],
    });
    uuid = (await runtime.createInstance({ workflowName: definition.name })).uuid;
    observe.mockClear();
  });

  const request = (uuid: string, eventName = "submit", extra: Partial<TriggerWorkflowEventInput> = {}) => ({
    workflowInstanceUuid: uuid,
    eventName,
    idempotencyKey: "event-1",
    ...extra,
  });

  it("replays the complete chain after state changes without commands, history, or observers", async () => {
    const first = await runtime
      .getHandle(uuid)
      .triggerEvent("submit", { idempotencyKey: "event-1", idempotencyFingerprint: "order-1" });
    expect(first.toState).toBe("done");
    expect(first.commandResults).toHaveLength(2);
    await runtime.triggerEvent({ workflowInstanceUuid: uuid, eventName: "close" });
    const before = await runtime.getInstance(uuid);
    const history = await runtime.getHistory(uuid);
    const calls = observe.mock.calls.length;
    expect(await runtime.triggerEvent(request(uuid, "submit", { idempotencyFingerprint: "order-1" }))).toEqual(first);
    expect(work).toHaveBeenCalledOnce();
    expect(enter).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(calls);
    expect(await runtime.getHistory(uuid)).toEqual(history);
    expect(await runtime.getInstance(uuid)).toEqual(before);
  });

  it.each(["note", "poll"])("deduplicates %s while it remains available", async (event) => {
    const first = await runtime.triggerEvent(request(uuid, event));
    expect(await runtime.triggerEvent(request(uuid, event))).toEqual(first);
    expect(work).toHaveBeenCalledOnce();
    expect(await runtime.getHistory(uuid)).toHaveLength(1);
  });

  it("keeps receipt identity stable when a caller mutates its input during execution", async () => {
    const input: TriggerWorkflowEventInput = request(uuid, "note", { idempotencyFingerprint: "original" });
    work.mockImplementationOnce(async () => {
      input.idempotencyKey = undefined;
      input.idempotencyFingerprint = "changed";
      input.eventName = "poll";
      return { ok: true };
    });
    const first = await runtime.triggerEvent(input);
    expect(await runtime.triggerEvent(request(uuid, "note", { idempotencyFingerprint: "original" }))).toEqual(first);
    expect(work).toHaveBeenCalledOnce();
    await persistence.transactionRunner.runInTransaction(async () => {
      expect(await persistence.idempotencyStore!.find(uuid, "event-1")).toMatchObject({
        eventName: "note",
        fingerprint: "original",
        result: first,
      });
    });
  });

  it("stores guard rejection and reevaluates only with a new key", async () => {
    const first = await runtime.triggerEvent(request(uuid, "guarded"));
    guard.mockReturnValue(true);
    expect(await runtime.triggerEvent(request(uuid, "guarded"))).toEqual(first);
    expect(first.outcome).toBe("guard-rejected");
    expect(guard).toHaveBeenCalledOnce();
    expect(work).not.toHaveBeenCalled();
    expect((await runtime.triggerEvent(request(uuid, "guarded", { idempotencyKey: "event-2" }))).outcome).toBe(
      "success",
    );
  });

  it("replays routed business failure", async () => {
    work.mockResolvedValue({ ok: false, code: "DECLINED" });
    const first = await runtime.triggerEvent(request(uuid, "fail"));
    expect(first).toMatchObject({ outcome: "failure", toState: "failed" });
    expect(await runtime.triggerEvent(request(uuid, "fail"))).toEqual(first);
    expect(work).toHaveBeenCalledOnce();
  });

  it.each([{ eventName: "poll" }, { idempotencyFingerprint: "different" }])(
    "rejects reused keys with mismatched identity: %j",
    async (extra) => {
      await runtime.triggerEvent(request(uuid, "note"));
      await expect(runtime.triggerEvent(request(uuid, "note", extra))).rejects.toThrow(IdempotencyConflictError);
      expect(work).toHaveBeenCalledOnce();
    },
  );

  it("rejects dropping a fingerprint and accepts changed subjects when fingerprints are omitted", async () => {
    await runtime.triggerEvent(request(uuid, "note", { idempotencyFingerprint: "input" }));
    await expect(runtime.triggerEvent(request(uuid, "note"))).rejects.toThrow(IdempotencyConflictError);
    const first = await runtime.triggerEvent(
      request(uuid, "note", { idempotencyKey: "no-fingerprint", subject: () => 1 }),
    );
    expect(
      await runtime.triggerEvent(
        request(uuid, "note", { idempotencyKey: "no-fingerprint", subject: { different: true } }),
      ),
    ).toEqual(first);
  });

  it.each([null, 3, "", "  ", "a\0b", "é".repeat(129), "\ud800"])(
    "rejects malformed keys/fingerprints: %j",
    async (value) => {
      for (const field of ["idempotencyKey", "idempotencyFingerprint"] as const) {
        await expect(
          runtime.triggerEvent(
            request(uuid, "note", { [field]: value } as unknown as Partial<TriggerWorkflowEventInput>),
          ),
        ).rejects.toThrow(InvalidArgumentError);
      }
      expect(work).not.toHaveBeenCalled();
    },
  );

  it("requires a key for fingerprints and a store for keyed calls", async () => {
    await expect(
      runtime.triggerEvent(request(uuid, "note", { idempotencyKey: undefined, idempotencyFingerprint: "input" })),
    ).rejects.toThrow(InvalidArgumentError);
    const unsupported = new WorkflowRuntime({
      ...persistence,
      idempotencyStore: undefined,
      definitionRegistry: registry,
      commandRegistry: commands,
      clock: { now: () => new Date() },
    });
    await expect(unsupported.triggerEvent(request(uuid, "note"))).rejects.toThrow(IdempotencyNotSupportedError);
    expect(work).not.toHaveBeenCalled();
  });

  it("retains unkeyed behavior without accessing the store", async () => {
    const lookup = vi.spyOn(persistence.idempotencyStore!, "find");
    await runtime.triggerEvent(request(uuid, "note", { idempotencyKey: undefined }));
    await runtime.triggerEvent(request(uuid, "note", { idempotencyKey: undefined }));
    expect(work).toHaveBeenCalledTimes(2);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["command", "entry", "receipt", "serialization", "invalid event"])(
    "rolls back %s failure and permits retry",
    async (failure) => {
      const before = await runtime.getInstance(uuid);
      if (failure === "command") work.mockRejectedValueOnce(new Error("command"));
      if (failure === "entry") enter.mockRejectedValueOnce(new Error("entry"));
      if (failure === "receipt")
        vi.spyOn(persistence.idempotencyStore!, "complete").mockRejectedValueOnce(new Error("receipt"));
      if (failure === "serialization") work.mockResolvedValueOnce({ ok: true, metadata: { value: 1n } });
      const event = failure === "invalid event" ? "missing" : "submit";
      await expect(runtime.triggerEvent(request(uuid, event))).rejects.toThrow();
      expect(await runtime.getInstance(uuid)).toEqual(before);
      expect(await runtime.getHistory(uuid)).toHaveLength(0);
      expect(observe).not.toHaveBeenCalled();
      await persistence.transactionRunner.runInTransaction(async () => {
        expect(await persistence.idempotencyStore!.find(uuid, "event-1")).toBeNull();
      });
      expect((await runtime.triggerEvent(request(uuid))).outcome).toBe("success");
    },
  );

  it("rolls back a completed receipt with its outer transaction", async () => {
    await expect(
      persistence.transactionRunner.runInTransaction(async () => {
        await runtime.triggerEvent(request(uuid));
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");
    expect(observe).not.toHaveBeenCalled();
    expect((await runtime.triggerEvent(request(uuid))).outcome).toBe("success");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("blocks same-key reentry through another runtime using the transaction", async () => {
    const other = new WorkflowRuntime({
      ...persistence,
      definitionRegistry: registry,
      commandRegistry: commands,
      clock: { now: () => new Date() },
    });
    work.mockImplementationOnce(async () => {
      await expect(other.triggerEvent(request(uuid, "note"))).rejects.toThrow(IdempotencyInProgressError);
      return { ok: true };
    });
    expect((await runtime.triggerEvent(request(uuid, "note"))).outcome).toBe("success");
    expect(work).toHaveBeenCalledOnce();
  });

  it("permits nested keyed calls on a different instance and scopes identical keys per instance", async () => {
    const second = (await runtime.createInstance({ workflowName: definition.name })).uuid;
    work.mockImplementationOnce(async () => {
      await runtime.triggerEvent(request(second, "note"));
      return { ok: true };
    });
    await runtime.triggerEvent(request(uuid, "note"));
    expect(work).toHaveBeenCalledTimes(2);
    await runtime.triggerEvent(request(second, "note"));
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("normalizes JSON results once and protects receipts from returned-result mutation", async () => {
    const toJSON = vi.fn(() => "serialized");
    work.mockResolvedValue({
      ok: true,
      metadata: { at: new Date("2026-10-03"), object: { toJSON } },
      error: new Error("hidden"),
    });
    const first = await runtime.triggerEvent(request(uuid, "note"));
    expect(first.commandResults[0]).toEqual({
      ok: true,
      metadata: { at: "2026-10-03T00:00:00.000Z", object: "serialized" },
      error: {},
    });
    expect(toJSON).toHaveBeenCalledOnce();
    first.commandResults[0].metadata!.at = "mutated";
    const replay = await runtime.triggerEvent(request(uuid, "note"));
    expect(replay.commandResults[0].metadata!.at).toBe("2026-10-03T00:00:00.000Z");
    replay.commandResults.length = 0;
    expect((await runtime.triggerEvent(request(uuid, "note"))).commandResults).toHaveLength(1);
  });

  it("replays after migration without resolving the instance's current definition", async () => {
    const first = await runtime.triggerEvent(request(uuid, "note"));
    const v2 = { ...definition, version: 2 };
    await definitions.ensure({
      workflowName: definition.name,
      version: 2,
      definitionJson: v2,
      contentHash: computeDefinitionHash(v2),
    });
    const migration = await runtime.migrateInstances({
      workflowName: definition.name,
      fromVersion: 1,
      toVersion: 2,
      instanceUuids: [uuid],
    });
    expect(migration.failed).toEqual([]);
    expect((await runtime.getInstance(uuid))!.definitionVersion).toBe(2);
    expect(await runtime.triggerEvent(request(uuid, "note"))).toEqual(first);
    expect(work).toHaveBeenCalledOnce();
  });

  it("keeps opaque key identity and accepts the maximum UTF-8 length", async () => {
    for (const key of ["Key", "key", " key", "é".repeat(128)])
      await runtime.triggerEvent(request(uuid, "note", { idempotencyKey: key }));
    expect(work).toHaveBeenCalledTimes(4);
  });
});

runIdempotencyStoreConformance("transactional in-memory double", {
  setup: async () => {
    const p = createInMemoryPersistence({ idempotency: true });
    return {
      store: p.idempotencyStore!,
      transactionRunner: p.transactionRunner,
      instanceUuid: "instance",
      withInstanceLock: (work) => p.transactionRunner.runInTransaction(work),
      teardown: async () => {},
    };
  },
});
