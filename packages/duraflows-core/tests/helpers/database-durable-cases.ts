import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  InMemoryGuardRegistry,
  ExecutionLeaseLostError,
  type WorkflowPersistenceProvider,
  type WorkflowCommand,
  type WorkflowRuntimeOptions,
  type WorkflowExecutionContext,
  type StateEnterEvent,
  type DurableWorkflowExecution,
} from "../../src/index.js";

/** Real multi-connection tests shared by the two PostgreSQL adapters. */
export function runDatabaseDurableCases(
  label: string,
  providers: () => WorkflowPersistenceProvider,
  readLeaseUntil: (executionUuid: string) => Promise<Date | null>,
  reset: () => Promise<void>,
): void {
  describe(`${label} durable executions`, () => {
    beforeEach(reset);
    function fixture(transactional = false, suffix = "", bestEffort = false) {
      const p = providers();
      const name = (transactional ? "durable-db-transactional" : "durable-db") + suffix;
      let definitions = new InMemoryDefinitionRegistry();
      definitions.register({
        name,
        initialState: "new",
        states: {
          new: {
            events: {
              expire: { targetState: "done", timeout: { afterMinutes: 1 } },
              go: {
                targetState: "done",
                commands: [
                  { name: "first", transactional },
                  { name: "second", transactional },
                ],
              },
            },
          },
          done: {},
        },
      });
      const commands = new InMemoryCommandRegistry();
      let firstCalls = 0,
        secondCalls = 0;
      let first: WorkflowCommand["execute"] = () => ({ ok: true });
      let second: WorkflowCommand["execute"] = () => ({ ok: true });
      commands.register("first", {
        bestEffort,
        execute: (s, c) => {
          firstCalls++;
          return first(s, c);
        },
      });
      commands.register("second", {
        execute: (s, c) => {
          secondCalls++;
          return second(s, c);
        },
      });
      let now = Date.parse("2026-01-01T12:00:00.000Z");
      const make = (options: Partial<WorkflowRuntimeOptions> = {}) =>
        new WorkflowRuntime({
          ...p,
          definitionRegistry: definitions,
          commandRegistry: commands,
          clock: { now: () => new Date(now) },
          durableExecution: { leaseDurationMs: 100, initialDelayMs: 1 },
          ...options,
        });
      return {
        p,
        name,
        replaceDefinition: (definition: import("../../src/index.js").WorkflowDefinition) => {
          definitions = new InMemoryDefinitionRegistry();
          definitions.register(definition);
        },
        make,
        now: () => new Date(now),
        first: (fn: WorkflowCommand["execute"]) => {
          first = fn;
        },
        second: (fn: WorkflowCommand["execute"]) => {
          second = fn;
        },
        advance: (ms = 101) => {
          now += ms;
        },
        calls: () => [firstCalls, secondCalls],
      };
    }
    it("rejects stale heartbeats and checkpoints while the replacement worker owns a live lease", async () => {
      const f = fixture();
      const events: StateEnterEvent[] = [];
      const options = {
        observers: [
          {
            name: "audit",
            onEnter: (event: StateEnterEvent) => {
              events.push(event);
            },
          },
        ],
      };
      const a = f.make(options),
        b = f.make(options);
      const instance = await a.createInstance({ workflowName: f.name });
      events.length = 0;
      const execution = await a.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "live-owner",
      });
      let releaseA!: () => void, releaseB!: () => void, enterA!: () => void, enterB!: () => void;
      const blockedA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const blockedB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      const startedA = new Promise<void>((resolve) => {
        enterA = resolve;
      });
      const startedB = new Promise<void>((resolve) => {
        enterB = resolve;
      });
      let invocation = 0;
      let heartbeatError: unknown;
      const identities: string[] = [];
      f.first(async (_subject, context) => {
        const owner = ++invocation;
        identities.push(context.durable!.idempotencyKey);
        if (owner === 1) {
          enterA();
          await blockedA;
          try {
            await context.durable!.heartbeat();
          } catch (error) {
            heartbeatError = error;
          }
        } else {
          try {
            await context.durable!.heartbeat();
          } finally {
            enterB();
          }
          await blockedB;
        }
        context.context.owner = owner;
        return { ok: true, code: `OWNER_${owner}` };
      });
      const stale = a.processPendingExecutions();
      let replacement: ReturnType<WorkflowRuntime["processPendingExecutions"]> | undefined;
      try {
        await Promise.race([
          startedA,
          stale.then(() => {
            throw new Error("Worker finished before starting its command");
          }),
        ]);
        const firstLease = (await a.getExecution(execution.uuid))!;
        f.advance(100); // The old lease expires exactly at this boundary.
        replacement = b.processPendingExecutions();
        await Promise.race([
          startedB,
          replacement.then(() => {
            throw new Error("Replacement worker finished before starting its command");
          }),
        ]);
        const activeLease = (await b.getExecution(execution.uuid))!;
        expect(activeLease.leaseToken).not.toBe(firstLease.leaseToken);
        expect(activeLease.leaseUntil).toBe(new Date(f.now().getTime() + 100).toISOString());
        const persistedInstance = await b.getInstance(instance.uuid);
        releaseA();
        expect(await stale).toEqual({
          processed: 1,
          completed: [],
          progressed: [],
          retrying: [],
          parked: [],
          skipped: [execution.uuid],
          failed: [],
        });
        expect(heartbeatError).toBeInstanceOf(ExecutionLeaseLostError);
        // Comparing the whole record also pins the replacement's lease, revision and journal.
        expect(await b.getExecution(execution.uuid)).toEqual(activeLease);
        expect(await b.getInstance(instance.uuid)).toEqual(persistedInstance);
        expect(await b.getHistory(instance.uuid)).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        releaseA();
        releaseB();
        await Promise.allSettled([stale, ...(replacement ? [replacement] : [])]);
      }
      expect(await replacement).toMatchObject({ processed: 1, progressed: [execution.uuid], skipped: [], failed: [] });
      expect(identities).toEqual([`${execution.uuid}:0`, `${execution.uuid}:0`]);
      expect((await b.getExecution(execution.uuid))!.journal).toMatchObject([
        { context: { owner: 2 }, result: { ok: true, code: "OWNER_2" }, attempts: 2 },
      ]);
      expect(await b.processPendingExecutions()).toMatchObject({
        processed: 1,
        completed: [execution.uuid],
        failed: [],
      });
      expect((await b.getInstance(instance.uuid))!.context).toEqual({ owner: 2 });
      expect(await b.getHistory(instance.uuid)).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it("rejects a heartbeat and checkpoint exactly when their lease expires", async () => {
      const f = fixture();
      const runtime = f.make();
      const instance = await runtime.createInstance({ workflowName: f.name });
      const execution = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "expiry-boundary",
      });
      let heartbeatError: unknown;
      f.first(async (_subject, context) => {
        f.advance(100);
        try {
          await context.durable!.heartbeat();
        } catch (error) {
          heartbeatError = error;
        }
        context.context.expiredWrite = true;
        return { ok: true };
      });
      expect(await runtime.processPendingExecutions()).toMatchObject({
        processed: 1,
        skipped: [execution.uuid],
        progressed: [],
        failed: [],
      });
      expect(heartbeatError).toBeInstanceOf(ExecutionLeaseLostError);
      expect((await runtime.getExecution(execution.uuid))!.journal).toEqual([]);
      expect(await runtime.getInstance(instance.uuid)).toEqual(instance);
      expect(await runtime.getHistory(instance.uuid)).toEqual([]);
      await runtime.cancelExecution(execution.uuid);
    });

    it("persists exponential retry deadlines, caps delays and resumes only when each deadline is due", async () => {
      const f = fixture();
      const options = {
        durableExecution: { leaseDurationMs: 100, initialDelayMs: 10, maxDelayMs: 25, maxAttempts: 5 },
      };
      let runtime = f.make(options);
      const instance = await runtime.createInstance({ workflowName: f.name });
      const execution = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "backoff",
      });
      const attempts: number[] = [];
      const identities: string[] = [];
      f.first((_subject, context) => {
        attempts.push(context.durable!.attempt);
        identities.push(context.durable!.idempotencyKey);
        throw new Error("temporary outage");
      });
      for (const [index, delay] of [10, 20, 25, 25].entries()) {
        const attemptedAt = f.now().getTime();
        expect(await runtime.processPendingExecutions()).toEqual({
          processed: 1,
          completed: [],
          progressed: [],
          retrying: [execution.uuid],
          parked: [],
          skipped: [],
          failed: [],
        });
        expect(await runtime.getExecution(execution.uuid)).toMatchObject({
          attempts: index + 1,
          availableAt: new Date(attemptedAt + delay).toISOString(),
          status: "pending",
          leaseToken: null,
          leaseUntil: null,
          journal: [],
          lastError: "temporary outage",
        });
        expect(await runtime.getInstance(instance.uuid)).toEqual(instance);
        expect(await runtime.getHistory(instance.uuid)).toEqual([]);
        runtime = f.make(options); // A fresh worker must obey the stored retry policy and deadline.
        f.advance(delay - 1);
        expect(await runtime.processPendingExecutions()).toEqual({
          processed: 0,
          completed: [],
          progressed: [],
          retrying: [],
          parked: [],
          skipped: [],
          failed: [],
        });
        expect(f.calls()).toEqual([index + 1, 0]);
        f.advance(1);
      }
      f.first((_subject, context) => {
        attempts.push(context.durable!.attempt);
        identities.push(context.durable!.idempotencyKey);
        return { ok: true, code: "RECOVERED" };
      });
      expect(await runtime.processPendingExecutions()).toMatchObject({
        processed: 1,
        progressed: [execution.uuid],
        retrying: [],
        failed: [],
      });
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(identities)).toEqual(new Set([`${execution.uuid}:0`]));
      expect((await runtime.getExecution(execution.uuid))!.journal[0]).toMatchObject({
        id: "0",
        name: "first",
        attempts: 5,
        result: { ok: true, code: "RECOVERED" },
      });
      expect((await runtime.getExecution(execution.uuid))!.attempts).toBe(0);
      expect(await f.make(options).processPendingExecutions()).toMatchObject({
        processed: 1,
        completed: [execution.uuid],
        failed: [],
      });
      expect(f.calls()).toEqual([5, 1]);
    });

    it("passes frozen acceptance inputs to guards and persists the complete rejection audit once", async () => {
      const f = fixture(false, "-guard-audit");
      f.replaceDefinition({
        name: f.name,
        version: 3,
        initialState: "new",
        states: {
          new: {
            events: {
              go: {
                targetState: "done",
                guard: { name: "allowed", metadata: { minimum: 2 } },
                commands: [{ name: "first" }],
              },
            },
          },
          done: {},
        },
      });
      const guards = new InMemoryGuardRegistry();
      let calls = 0;
      let observedSubject: unknown;
      let observedContext: WorkflowExecutionContext | undefined;
      guards.register("allowed", {
        name: "internal-policy",
        evaluate: (subject, context) => {
          calls++;
          observedSubject = subject;
          observedContext = context;
          expect(Object.isFrozen(subject)).toBe(true);
          expect(Object.isFrozen(context.context)).toBe(true);
          expect(Object.isFrozen(context.context.customer)).toBe(true);
          expect(Object.isFrozen(context.metadata)).toBe(true);
          expect(Object.isFrozen(context.commandMetadata)).toBe(true);
          expect(Object.isFrozen(context.triggerMetadata)).toBe(true);
          expect(() => {
            (context.context.customer as { tier: number }).tier = 99;
          }).toThrow(TypeError);
          return false;
        },
      });
      const events: StateEnterEvent[] = [];
      const runtime = f.make({
        guardRegistry: guards,
        observers: [
          {
            name: "audit",
            onEnter: (event) => {
              events.push(event);
            },
          },
        ],
      });
      const instance = await runtime.createInstance({
        workflowName: f.name,
        context: { customer: { tier: 1 } },
        metadata: { orderId: "order-1" },
      });
      events.length = 0;
      const input = {
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "guard-rejection",
        subject: { customerId: "customer-1" },
        triggerMetadata: { actor: "customer-1" },
      };
      const execution = await runtime.enqueueEvent(input);
      expect(observedSubject).toEqual(input.subject);
      expect(observedContext).toMatchObject({
        context: { customer: { tier: 1 } },
        metadata: instance.metadata,
        commandMetadata: { minimum: 2 },
        triggerMetadata: input.triggerMetadata,
        now: f.now(),
        fromState: "new",
        toState: "done",
      });
      expect(observedContext!.transitionUuid).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
      expect(execution).toMatchObject({
        status: "completed",
        rejectedBy: "allowed",
        journal: [],
        result: {
          outcome: "guard-rejected",
          fromState: "new",
          toState: "new",
          commandResults: [],
          rejectedBy: "allowed",
        },
      });
      expect(await runtime.getHistory(instance.uuid)).toEqual([
        expect.objectContaining({
          workflowInstanceUuid: instance.uuid,
          eventName: "go",
          fromState: "new",
          toState: "new",
          outcome: "guard-rejected",
          rejectedBy: "allowed",
          commandResultsJson: [],
          triggerMetadata: input.triggerMetadata,
          definitionVersion: 3,
        }),
      ]);
      const recovered = f.make({ guardRegistry: guards });
      expect(await recovered.enqueueEvent(input)).toEqual(execution);
      expect(calls).toBe(1);
      expect(f.calls()).toEqual([0, 0]);
      expect(await recovered.processPendingExecutions()).toMatchObject({ processed: 0, completed: [] });
      expect(await recovered.getHistory(instance.uuid)).toHaveLength(1);
      expect(await recovered.getInstance(instance.uuid)).toEqual(instance);
      expect(events).toEqual([]);
    });

    it("preserves distinct transition identities across retries and recovery and commits complete hop audits", async () => {
      const f = fixture(false, "-hop-audit");
      f.replaceDefinition({
        name: f.name,
        version: 4,
        initialState: "new",
        states: {
          new: {
            events: { go: { targetState: "entered", commands: [{ name: "first", metadata: { stage: "event" } }] } },
          },
          entered: {
            context: { stage: "entered" },
            onEnter: { targetState: "ready" },
          },
          ready: {
            context: { stage: "ready" },
            onEnter: { targetState: "done", commands: [{ name: "second", metadata: { stage: "entry" } }] },
          },
          done: { context: { stage: "done" } },
        },
      });
      const events: StateEnterEvent[] = [];
      const committedStates: string[] = [];
      const options = {
        observers: [
          {
            name: "audit",
            onEnter: async (event: StateEnterEvent) => {
              if (event.triggerEvent !== null) {
                committedStates.push((await f.p.instanceStore.findByUuid(event.instanceUuid))!.currentState);
                expect(Object.isFrozen(event.context)).toBe(true);
                expect(Object.isFrozen(event.metadata)).toBe(true);
                expect(Object.isFrozen(event.triggerMetadata)).toBe(true);
                events.push(event);
              }
            },
          },
        ],
      };
      let runtime = f.make(options);
      const identities: { transition: string; key: string; metadata: Readonly<Record<string, unknown>> }[] = [];
      f.first((_subject, context) => {
        identities.push({
          transition: context.transitionUuid,
          key: context.durable!.idempotencyKey,
          metadata: context.commandMetadata,
        });
        context.context.charged = true;
        return { ok: true, code: "CHARGED" };
      });
      let fail = true;
      f.second((_subject, context) => {
        identities.push({
          transition: context.transitionUuid,
          key: context.durable!.idempotencyKey,
          metadata: context.commandMetadata,
        });
        if (fail) {
          fail = false;
          throw new Error("entry unavailable");
        }
        expect(context.context).toEqual({ orderId: "order-1", charged: true, stage: "ready" });
        context.context.delivered = true;
        return { ok: true, code: "DELIVERED" };
      });
      const allTransitions: string[] = [];
      for (const key of ["hop-1", "hop-2"]) {
        const instance = await runtime.createInstance({
          workflowName: f.name,
          context: { orderId: "order-1" },
          metadata: { tenant: "tenant-1" },
        });
        const triggerMetadata = { actor: "operator-1" };
        const execution = await runtime.enqueueEvent({
          workflowInstanceUuid: instance.uuid,
          eventName: "go",
          idempotencyKey: key,
          triggerMetadata,
        });
        const start = identities.length;
        const eventStart = events.length;
        expect(await runtime.processPendingExecutions()).toMatchObject({ processed: 1, progressed: [execution.uuid] });
        if (key === "hop-1") {
          expect(await runtime.processPendingExecutions()).toMatchObject({ processed: 1, retrying: [execution.uuid] });
          expect(await runtime.getHistory(instance.uuid)).toEqual([]);
          expect(events).toHaveLength(eventStart);
          f.advance(1);
          runtime = f.make(options);
        }
        expect(await runtime.processPendingExecutions()).toMatchObject({
          processed: 1,
          completed: [execution.uuid],
          failed: [],
        });
        const commands = identities.slice(start);
        const root = commands[0].transition,
          entry = commands[1].transition;
        for (const id of [root, entry])
          expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        expect(root).not.toBe(entry);
        expect(commands).toEqual([
          { transition: root, key: `${execution.uuid}:0`, metadata: { stage: "event" } },
          ...Array.from({ length: key === "hop-1" ? 2 : 1 }, () => ({
            transition: entry,
            key: `${execution.uuid}:1`,
            metadata: { stage: "entry" },
          })),
        ]);
        const finalEntry = events.at(-1)!.transitionUuid;
        expect(finalEntry).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        expect(new Set([root, entry, finalEntry]).size).toBe(3);
        allTransitions.push(root, entry, finalEntry);
        const history = await runtime.getHistory(instance.uuid);
        expect(history).toHaveLength(3);
        expect(history.find((row) => row.eventName === "go")).toMatchObject({
          workflowInstanceUuid: instance.uuid,
          eventName: "go",
          fromState: "new",
          toState: "entered",
          outcome: "success",
          commandResultsJson: [{ ok: true, code: "CHARGED" }],
          triggerMetadata,
          definitionVersion: 4,
        });
        expect(history.find((row) => row.fromState === "ready")).toMatchObject({
          workflowInstanceUuid: instance.uuid,
          eventName: "onEnter",
          fromState: "ready",
          toState: "done",
          outcome: "success",
          commandResultsJson: [{ ok: true, code: "DELIVERED" }],
          triggerMetadata: { source: "onEnter" },
          definitionVersion: 4,
        });
        expect(history.find((row) => row.fromState === "entered")).toMatchObject({
          workflowInstanceUuid: instance.uuid,
          eventName: "onEnter",
          fromState: "entered",
          toState: "ready",
          outcome: "success",
          commandResultsJson: [],
          triggerMetadata: { source: "onEnter" },
          definitionVersion: 4,
        });
        expect(events.slice(eventStart)).toEqual([
          {
            workflowName: f.name,
            instanceUuid: instance.uuid,
            state: "entered",
            fromState: "new",
            toState: "entered",
            transitionUuid: root,
            triggerEvent: "go",
            context: { orderId: "order-1", charged: true, stage: "entered" },
            metadata: instance.metadata,
            triggerMetadata,
            occurredAt: f.now(),
          },
          {
            workflowName: f.name,
            instanceUuid: instance.uuid,
            state: "ready",
            fromState: "entered",
            toState: "ready",
            transitionUuid: entry,
            triggerEvent: "onEnter",
            context: { orderId: "order-1", charged: true, stage: "ready" },
            metadata: instance.metadata,
            triggerMetadata: { source: "onEnter" },
            occurredAt: f.now(),
          },
          {
            workflowName: f.name,
            instanceUuid: instance.uuid,
            state: "done",
            fromState: "ready",
            toState: "done",
            transitionUuid: finalEntry,
            triggerEvent: "onEnter",
            context: { orderId: "order-1", charged: true, stage: "done", delivered: true },
            metadata: instance.metadata,
            triggerMetadata: { source: "onEnter" },
            occurredAt: f.now(),
          },
        ]);
        expect((await runtime.getExecution(execution.uuid))!.result).toMatchObject({
          outcome: "success",
          fromState: "new",
          toState: "done",
          commandResults: [
            { ok: true, code: "CHARGED" },
            { ok: true, code: "DELIVERED" },
          ],
          historyUuid: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
        });
        expect(await runtime.getInstance(instance.uuid)).toMatchObject({
          currentState: "done",
          context: events.at(-1)!.context,
          definitionVersion: 4,
          version: instance.version + 3,
        });
      }
      expect(new Set(allTransitions).size).toBe(6);
      expect(committedStates).toEqual(Array(6).fill("done"));
      expect(f.calls()).toEqual([2, 3]);
    });

    it.each(["pending", "running", "parked", "completed", "cancelled"] as const)(
      "queries active executions directly with status=%s",
      async (status) => {
        const f = fixture(false, `-active-${status}`);
        const runtime = f.make();
        const instance = await runtime.createInstance({ workflowName: f.name });
        const execution = await runtime.enqueueEvent({
          workflowInstanceUuid: instance.uuid,
          eventName: "go",
          idempotencyKey: "active-status",
        });
        const stored = { ...execution, status, revision: execution.revision + 1 };
        await f.p.transactionRunner.runInTransaction(async () => {
          await f.p.instanceStore.lockByUuid(instance.uuid);
          await f.p.executionStore!.update(stored);
        });
        expect(await f.p.executionStore!.findActive(instance.uuid)).toEqual(
          ["pending", "running", "parked"].includes(status) ? stored : null,
        );
        if (["pending", "running", "parked"].includes(status)) await runtime.cancelExecution(execution.uuid);
      },
    );

    it.each(["create", "update"] as const)(
      "filters persisted leases before limiting due work after %s",
      async (operation) => {
        const f = fixture(false, `-lease-query-${operation}`);
        const runtime = f.make();
        const store = f.p.executionStore!;
        const busy = await runtime.createInstance({ workflowName: f.name });
        const idle = await runtime.createInstance({ workflowName: f.name });
        const seed = await runtime.enqueueEvent({
          workflowInstanceUuid: busy.uuid,
          eventName: "go",
          idempotencyKey: "busy",
        });
        const due = await runtime.enqueueEvent({
          workflowInstanceUuid: idle.uuid,
          eventName: "go",
          idempotencyKey: "idle",
        });
        expect(await readLeaseUntil(seed.uuid)).toBeNull();
        expect(await readLeaseUntil(due.uuid)).toBeNull();
        const leased: DurableWorkflowExecution = {
          ...seed,
          status: "running",
          availableAt: new Date(f.now().getTime() - 1).toISOString(),
          leaseToken: crypto.randomUUID(),
          leaseUntil: new Date(f.now().getTime() + 100).toISOString(),
        };
        await f.p.transactionRunner.runInTransaction(async () => {
          await f.p.instanceStore.lockByUuid(busy.uuid);
          if (operation === "create") {
            await store.update({ ...seed, status: "cancelled", revision: seed.revision + 1 });
            await store.create({ ...leased, uuid: crypto.randomUUID(), idempotencyKey: "leased-create" });
            leased.uuid = (await store.findActive(busy.uuid))!.uuid;
            leased.idempotencyKey = "leased-create";
          } else {
            leased.revision++;
            await store.update(leased);
          }
        });
        expect(await store.findByUuid(leased.uuid)).toEqual(leased);
        expect(await readLeaseUntil(leased.uuid)).toEqual(new Date(leased.leaseUntil!));
        expect((await store.findDue(1, f.now())).map((row) => row.uuid)).toEqual([due.uuid]);
        f.advance(100);
        expect((await store.findDue(1, f.now())).map((row) => row.uuid)).toEqual([leased.uuid]);
        await f.p.transactionRunner.runInTransaction(async () => {
          await f.p.instanceStore.lockByUuid(busy.uuid);
          await store.update({
            ...leased,
            status: "pending",
            leaseToken: null,
            leaseUntil: null,
            revision: leased.revision + 1,
          });
        });
        expect(await readLeaseUntil(leased.uuid)).toBeNull();
        await runtime.cancelExecution(leased.uuid);
        await runtime.cancelExecution(due.uuid);
      },
    );

    it.each(["pending", "running", "parked"] as const)(
      "counts an unnumbered captured definition with status=%s when its instance is excluded",
      async (status) => {
        const f = fixture(false, "-unnumbered-usage");
        const runtime = f.make();
        const instance = await runtime.createInstance({ workflowName: f.name });
        const execution = await runtime.enqueueEvent({
          workflowInstanceUuid: instance.uuid,
          eventName: "go",
          idempotencyKey: "unnumbered",
        });
        expect(execution.definition.version).toBeUndefined();
        await f.p.transactionRunner.runInTransaction(async () => {
          await f.p.instanceStore.lockByUuid(instance.uuid);
          await f.p.executionStore!.update({ ...execution, status, revision: execution.revision + 1 });
        });
        // Empty exclusions must omit the SQL predicate; PostgreSQL rejects NOT IN ().
        expect(
          await f.p.executionStore!.countInstancesUsingDefinition!({
            workflowName: f.name,
            definitionVersion: 1,
            excludeStates: [],
          }),
        ).toBe(1);
        expect(
          await f.p.executionStore!.countInstancesUsingDefinition!({
            workflowName: f.name,
            definitionVersion: 1,
            excludeStates: ["new"],
          }),
        ).toBe(1);
        await runtime.cancelExecution(execution.uuid);
        expect(
          await f.p.executionStore!.countInstancesUsingDefinition!({
            workflowName: f.name,
            definitionVersion: 1,
            excludeStates: ["new"],
          }),
        ).toBe(0);
      },
    );
    it("deduplicates concurrent acceptance and resumes persisted progress across runtimes", async () => {
      const f = fixture();
      const a = f.make(),
        b = f.make();
      const instance = await a.createInstance({ workflowName: f.name });
      const input = { workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "request" };
      const [x, y] = await Promise.all([a.enqueueEvent(input), b.enqueueEvent(input)]);
      expect(x.uuid).toBe(y.uuid);
      await a.processPendingExecutions();
      expect(f.calls()).toEqual([1, 0]);
      expect((await b.processPendingExecutions()).completed).toContain(x.uuid);
      expect(f.calls()).toEqual([1, 1]);
      expect((await b.getExecution(x.uuid))!.journal).toHaveLength(2);
      expect((await b.getInstance(instance.uuid))!.currentState).toBe("done");
      expect(await b.enqueueEvent(input)).toMatchObject({ uuid: x.uuid, status: "completed" });
    });
    it("fences an expired worker while preserving downstream command identity", async () => {
      const f = fixture();
      const a = f.make(),
        b = f.make();
      const instance = await a.createInstance({ workflowName: f.name });
      const e = await a.enqueueEvent({ workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "race" });
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const keys: string[] = [];
      f.first(async (_s, c) => {
        keys.push(c.durable!.idempotencyKey);
        if (keys.length === 1) {
          entered();
          await blocked;
        }
        c.context.owner = keys.length;
        return { ok: true };
      });
      const stale = a.processPendingExecutions();
      try {
        await Promise.race([
          started,
          stale.then(() => {
            throw new Error("Worker finished before starting its command");
          }),
        ]);
        expect((await b.processPendingExecutions()).processed).toBe(0);
        f.advance();
        expect((await b.processPendingExecutions()).progressed).toContain(e.uuid);
      } finally {
        release();
      }
      expect((await stale).skipped).toContain(e.uuid);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect((await b.getExecution(e.uuid))!.journal).toHaveLength(1);
      await b.processPendingExecutions();
      expect(f.calls()).toEqual([2, 1]);
    });
    it("commits short database commands with checkpoints and rolls back only the failing command", async () => {
      const f = fixture(true);
      const a = f.make();
      const business = await a.createInstance({ workflowName: f.name });
      const instance = await a.createInstance({ workflowName: f.name });
      const write = async (value: string) => {
        const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
        row.context.value = value;
        row.version++;
        await f.p.instanceStore.update(row);
      };
      f.first(async (_s, c) => {
        expect(f.p.transactionRunner.isTransactionActive!()).toBe(true);
        await write("first");
        await c.durable!.heartbeat();
        return { ok: true };
      });
      f.second(async () => {
        await write("second");
        throw new Error("second failed");
      });
      const e = await a.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "database",
      });
      await a.processPendingExecutions();
      expect((await a.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      expect((await a.processPendingExecutions()).retrying).toContain(e.uuid);
      expect((await a.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      expect((await a.getExecution(e.uuid))!.journal).toHaveLength(1);
      f.second(() => ({ ok: true }));
      f.advance();
      await a.processPendingExecutions();
      expect(f.calls()).toEqual([1, 2]);
    });
    it("enforces revision, key and active-instance uniqueness and rolls back acceptance", async () => {
      const f = fixture();
      const a = f.make();
      const instance = await a.createInstance({ workflowName: f.name });
      const input = { workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "unique" };
      await expect(
        f.p.transactionRunner.runInTransaction(async () => {
          await a.enqueueEvent(input);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await f.p.executionStore!.findByKey(instance.uuid, "unique")).toBeNull();
      const e = await a.enqueueEvent(input);
      for (const operation of [
        () => f.p.executionStore!.create({ ...e, uuid: crypto.randomUUID() }),
        () => f.p.executionStore!.create({ ...e, uuid: crypto.randomUUID(), idempotencyKey: "different" }),
        () => f.p.executionStore!.update({ ...e, revision: 99 }),
      ]) {
        await expect(
          f.p.transactionRunner.runInTransaction(async () => {
            await f.p.instanceStore.lockByUuid(instance.uuid);
            await operation();
          }),
        ).rejects.toThrow();
      }
      expect((await a.getExecution(e.uuid))!.revision).toBe(0);
      await a.cancelExecution(e.uuid);
      expect(await f.p.executionStore!.findActive(instance.uuid)).toBeNull();
      expect(await f.p.executionStore!.findByUuid(crypto.randomUUID())).toBeNull();
    });
    it("excludes occupied instances before limiting timeout candidates", async () => {
      const f = fixture();
      f.advance(-86400000);
      const runtime = f.make();
      const occupied = await runtime.createInstance({ workflowName: f.name });
      const queued = await runtime.enqueueEvent({
        workflowInstanceUuid: occupied.uuid,
        eventName: "go",
        idempotencyKey: "busy",
      });
      f.advance(1);
      const idle = await runtime.createInstance({ workflowName: f.name });
      f.advance(60001);
      expect((await runtime.processExpiredWorkflows({ limit: 1 })).processed).toBe(1);
      expect((await runtime.getInstance(idle.uuid))!.currentState).toBe("done");
      expect((await runtime.getInstance(occupied.uuid))!.currentState).toBe("new");
      await runtime.cancelExecution(queued.uuid);
    });

    it("rolls back successful database writes when checkpoint storage or finalization fails", async () => {
      const f = fixture(true);
      const runtime = f.make();
      const business = await runtime.createInstance({ workflowName: f.name });
      const instance = await runtime.createInstance({ workflowName: f.name });
      const write = async (value: string) => {
        const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
        row.context.value = value;
        row.version++;
        await f.p.instanceStore.update(row);
        return { ok: true };
      };
      f.first(() => write("first"));
      f.second(() => write("second"));
      const e = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "checkpoint-failure",
      });
      const store = f.p.executionStore!;
      const update = store.update.bind(store);
      let fail = true;
      const checkpoint = vi.spyOn(store, "update").mockImplementation(async (execution) => {
        await update(execution);
        if (fail && execution.journal.length === 1) {
          fail = false;
          throw new Error("checkpoint storage failed");
        }
      });
      try {
        expect((await runtime.processPendingExecutions()).retrying).toContain(e.uuid);
      } finally {
        checkpoint.mockRestore();
      }
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({});
      expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(0);
      f.advance();
      await runtime.processPendingExecutions();
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      const append = f.p.historyStore.append.bind(f.p.historyStore);
      const history = vi.spyOn(f.p.historyStore, "append").mockImplementationOnce(async (record) => {
        await append(record);
        throw new Error("finalization storage failed");
      });
      try {
        expect((await runtime.processPendingExecutions()).retrying).toContain(e.uuid);
      } finally {
        history.mockRestore();
      }
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      expect((await runtime.getInstance(instance.uuid))!.currentState).toBe("new");
      expect(await runtime.getHistory(instance.uuid)).toHaveLength(0);
      expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(1);
      f.advance();
      expect((await runtime.processPendingExecutions()).completed).toContain(e.uuid);
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ value: "second" });
      expect(f.calls()).toEqual([2, 2]);
    });

    it("commits transactional writes with a recorded business failure", async () => {
      const f = fixture(true);
      const runtime = f.make();
      const business = await runtime.createInstance({ workflowName: f.name });
      const instance = await runtime.createInstance({ workflowName: f.name });
      f.first(async () => {
        const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
        row.context.failureRecorded = true;
        row.version++;
        await f.p.instanceStore.update(row);
        return { ok: false, code: "DECLINED" };
      });
      const e = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "declined",
      });
      expect((await runtime.processPendingExecutions()).parked).toContain(e.uuid);
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ failureRecorded: true });
      expect((await runtime.getExecution(e.uuid))!.journal[0].result).toEqual({ ok: false, code: "DECLINED" });
      await runtime.cancelExecution(e.uuid);
    });
    it.each([false, true])(
      "persists safe retry and parked diagnostics with transactional=%s",
      async (transactional) => {
        const f = fixture(transactional, "-unicode");
        const runtime = f.make();
        const business = await runtime.createInstance({ workflowName: f.name });
        const instance = await runtime.createInstance({ workflowName: f.name });
        f.first(async () => {
          if (transactional) {
            const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
            row.context.changed = true;
            row.version++;
            await f.p.instanceStore.update(row);
          }
          return { ok: true };
        });
        f.second(async () => {
          if (transactional) {
            const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
            row.context.changed = false;
            row.version++;
            await f.p.instanceStore.update(row);
          }
          throw new Error("bad\u0000\ud800\udc00\ud800\udc00\udc00");
        });
        const e = await runtime.enqueueEvent({
          workflowInstanceUuid: instance.uuid,
          eventName: "go",
          idempotencyKey: "unicode",
        });
        await runtime.processPendingExecutions();
        for (let attempt = 1; attempt <= 10; attempt++) {
          const batch = await runtime.processPendingExecutions();
          expect(batch.failed).toEqual([]);
          expect(batch[attempt === 10 ? "parked" : "retrying"]).toContain(e.uuid);
          const current = (await runtime.getExecution(e.uuid))!;
          expect(current.lastError).toBe("bad�𐀀𐀀�");
          expect(current.leaseToken).toBeNull();
          expect(current.leaseUntil).toBeNull();
          expect(current.journal).toHaveLength(1);
          if (transactional) expect((await runtime.getInstance(business.uuid))!.context).toEqual({ changed: true });
          f.advance(4000000);
        }
        await runtime.cancelExecution(e.uuid);
      },
    );

    it("checkpoints best-effort thrown diagnostics and finalizes history", async () => {
      const f = fixture(false, "-best-effort-unicode", true);
      const runtime = f.make();
      const instance = await runtime.createInstance({ workflowName: f.name });
      f.first(() => {
        throw "bad\u0000\ud800";
      });
      const e = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "best-effort",
      });
      expect((await runtime.processPendingExecutions()).progressed).toContain(e.uuid);
      expect((await runtime.processPendingExecutions()).completed).toContain(e.uuid);
      expect((await runtime.getExecution(e.uuid))!.journal[0].result).toMatchObject({
        ok: false,
        code: "BEST_EFFORT_THROWN",
        message: "bad��",
      });
      expect((await runtime.getHistory(instance.uuid))[0].commandResultsJson[0].message).toBe("bad��");
    });

    it("counts captured versions across transaction boundaries without double-counting", async () => {
      const f = fixture(false, "-usage");
      const v1 = f.make();
      const instance = await v1.createInstance({ workflowName: f.name });
      const original = await v1.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "original",
      });
      // Definition v1 omits its version and must still count once, not twice.
      expect((await v1.listDefinitionVersions(f.name))[0].activeInstances).toBe(1);
      await v1.cancelExecution(original.uuid);
      const unrelated = fixture(false, "-unrelated-usage");
      const other = unrelated.make();
      const otherInstance = await other.createInstance({ workflowName: unrelated.name });
      const otherExecution = await other.enqueueEvent({
        workflowInstanceUuid: otherInstance.uuid,
        eventName: "go",
        idempotencyKey: "other",
      });
      expect((await v1.listDefinitionVersions(f.name))[0].activeInstances).toBe(1);
      await other.cancelExecution(otherExecution.uuid);
      const v2Definition = {
        name: f.name,
        version: 2,
        versionPolicy: "latest" as const,
        initialState: "new",
        states: {
          new: { events: { go: { targetState: "done", commands: [{ name: "first" }, { name: "second" }] } } },
          done: {},
        },
      };
      f.replaceDefinition(v2Definition);
      const v2 = f.make();
      await v2.initialize();
      const count = async (runtime = v2) =>
        (await runtime.listDefinitionVersions(f.name)).map((v) => v.activeInstances);
      expect(await count()).toEqual([1, 0]);
      const input = { workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "queued" };
      await expect(
        f.p.transactionRunner.runInTransaction(async () => {
          await v2.enqueueEvent(input);
          expect(await count()).toEqual([1, 1]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await count()).toEqual([1, 0]);
      const e = await v2.enqueueEvent(input);
      expect(await count()).toEqual([1, 1]);
      expect(
        await f.p.executionStore!.countInstancesUsingDefinition!({
          workflowName: f.name,
          definitionVersion: 2,
          excludeStates: ["new"],
        }),
      ).toBe(1);
      f.first(async () => {
        expect(await count()).toEqual([1, 1]);
        return { ok: true };
      });
      await v2.processPendingExecutions();
      const recovered = f.make();
      expect((await recovered.processPendingExecutions()).completed).toContain(e.uuid);
      expect(await count(recovered)).toEqual([0, 0]);
      const another = await recovered.createInstance({ workflowName: f.name });
      const parked = await recovered.enqueueEvent({
        ...input,
        workflowInstanceUuid: another.uuid,
        idempotencyKey: "parked",
      });
      expect(await count()).toEqual([0, 1]);
      f.first(() => ({ ok: false }));
      await recovered.processPendingExecutions();
      expect((await recovered.getExecution(parked.uuid))!.status).toBe("parked");
      expect(await count()).toEqual([0, 1]);
      await recovered.cancelExecution(parked.uuid);
      // The stamped nonterminal instance still requires v2.
      expect(await count()).toEqual([0, 1]);
    });
  });
}
