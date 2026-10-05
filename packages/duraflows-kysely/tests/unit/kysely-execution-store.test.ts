import { describe, it, expect, vi } from "vitest";
import type { Kysely, Transaction } from "kysely";
import {
  KyselyWorkflowExecutionStore,
  KyselyTransactionContext,
  kyselyWorkflowProviders,
  kyselyWorkflowProvidersFromTransaction,
  type WorkflowDatabase,
} from "../../src/index.js";
import type { DurableWorkflowExecution } from "@duraflows/core";
const e = {
  uuid: "execution",
  workflowInstanceUuid: "instance",
  idempotencyKey: "key",
  status: "running",
  revision: 2,
  availableAt: "2026-10-04T00:00:00Z",
  leaseUntil: "2026-10-04T00:00:30Z",
} as DurableWorkflowExecution;
describe("KyselyWorkflowExecutionStore", () => {
  it("uses ambient transactions for writes and checks revision ownership", async () => {
    const b = {
      selectFrom: vi.fn(),
      union: vi.fn(),
      as: vi.fn(),
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ count: "2" }),
      select: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      insertInto: vi.fn(),
      values: vi.fn(),
      updateTable: vi.fn(),
      set: vi.fn(),
      execute: vi.fn().mockResolvedValue([{ execution_json: e }]),
      executeTakeFirst: vi.fn().mockResolvedValue({ execution_json: e, numUpdatedRows: 1n }),
    };
    for (const key of [
      "selectFrom",
      "union",
      "as",
      "select",
      "where",
      "orderBy",
      "limit",
      "insertInto",
      "values",
      "updateTable",
      "set",
    ] as const)
      b[key].mockReturnValue(b);
    const db = b as unknown as Kysely<WorkflowDatabase>;
    const store = new KyselyWorkflowExecutionStore(db);
    await expect(store.create(e)).rejects.toThrow("active transaction");
    await expect(store.update(e)).rejects.toThrow("active transaction");
    expect(await store.findByUuid(e.uuid)).toEqual(e);
    expect(await store.findByKey("instance", "key")).toEqual(e);
    expect(await store.findActive("instance")).toEqual(e);
    for (const read of [
      () => store.findByUuid("missing"),
      () => store.findByKey("instance", "missing"),
      () => store.findActive("missing"),
    ]) {
      b.executeTakeFirst.mockResolvedValueOnce(undefined);
      expect(await read()).toBeNull();
    }
    const options = { workflowName: "order", definitionVersion: 2, excludeStates: ["done"] };
    expect(await store.countInstancesUsingDefinition(options)).toBe(2);
    expect(await store.countInstancesUsingDefinition({ ...options, excludeStates: [] })).toBe(2);
    const selectCount = b.select.mock.calls.find(([arg]) => typeof arg === "function")![0] as (eb: unknown) => unknown;
    const countExpression = { as: vi.fn() };
    selectCount({ fn: { countAll: vi.fn().mockReturnValue(countExpression) } });
    expect(countExpression.as).toHaveBeenCalledWith("count");
    const jsonPath = { key: vi.fn() };
    jsonPath.key.mockReturnValue(jsonPath);
    const countEb = Object.assign(vi.fn(), {
      ref: vi.fn().mockReturnValue(jsonPath),
      cast: vi.fn(),
      val: vi.fn(),
      fn: { coalesce: vi.fn() },
    });
    for (const [arg] of b.where.mock.calls) if (typeof arg === "function") (arg as (eb: unknown) => unknown)(countEb);
    const now = new Date();
    expect(await store.findDue(2, now)).toEqual([e]);
    const predicate = b.where.mock.calls.filter(([arg]) => typeof arg === "function").at(-1)![0] as (
      eb: unknown,
    ) => unknown;
    const eb = Object.assign(vi.fn().mockReturnValue("expression"), { or: vi.fn() });
    predicate(eb);
    expect(eb).toHaveBeenCalledWith("lease_until", "<=", now);
    expect(eb.or).toHaveBeenCalledWith(["expression", "expression"]);
    await KyselyTransactionContext.run(db, b as unknown as Transaction<WorkflowDatabase>, async () => {
      await store.create(e);
      await store.create({ ...e, leaseUntil: null });
      await store.update(e);
      expect(b.where).toHaveBeenCalledWith("revision", "=", 1);
      await store.update({ ...e, leaseUntil: null });
      b.executeTakeFirst.mockResolvedValueOnce({ numUpdatedRows: 0n });
      await expect(store.update(e)).rejects.toThrow("revision conflict");
    });
    expect(kyselyWorkflowProviders(db).executionStore).toBeUndefined();
    expect(kyselyWorkflowProviders(db, { durableExecution: true }).executionStore).toBeInstanceOf(
      KyselyWorkflowExecutionStore,
    );
    const bound = kyselyWorkflowProvidersFromTransaction(b as unknown as Transaction<WorkflowDatabase>, {
      durableExecution: true,
    });
    expect(bound.executionStore).toBeInstanceOf(KyselyWorkflowExecutionStore);
    expect(bound.transactionRunner.isTransactionActive!()).toBe(true);
  });
});
