import { describe, it, expect, vi } from "vitest";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionRunner } from "../../src/pg-transaction-runner.js";
import { PgTransactionContext } from "../../src/pg-transaction-context.js";
import type { Pool, PoolClient } from "pg";

function createMocks() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return { pool, client };
}

function queriedSql(client: PoolClient): string[] {
  return (client.query as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
}

describe("PgTransactionRunner", () => {
  it("detects only its own active transaction and clears the scope after commit", async () => {
    const { pool } = createMocks();
    const runner = new PgTransactionRunner(pool);
    expect(runner.isTransactionActive()).toBe(false);
    await runner.runInTransaction(async () => {
      expect(runner.isTransactionActive()).toBe(true);
      const other = createMocks();
      expect(new PgTransactionRunner(other.pool).isTransactionActive()).toBe(false);
    });
    expect(runner.isTransactionActive()).toBe(false);
  });

  it("begins, runs callback, commits, and releases client on success", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);

    const result = await runner.runInTransaction(async () => "done");

    expect(result).toBe("done");
    const queryCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(queryCalls[0][0]).toBe("BEGIN");
    expect(queryCalls[1][0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("begins, rolls back, releases client, and rethrows on error", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const error = new Error("boom");

    await expect(
      runner.runInTransaction(async () => {
        throw error;
      }),
    ).rejects.toThrow("boom");

    const queryCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(queryCalls[0][0]).toBe("BEGIN");
    expect(queryCalls[1][0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  it("runs a nested call in a savepoint on the existing client (no nested BEGIN)", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const existingClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient;

    const result = await PgTransactionContext.run(pool, existingClient, () =>
      runner.runInTransaction(async () => "nested"),
    );

    expect(result).toBe("nested");
    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(queriedSql(existingClient)).toEqual(["SAVEPOINT duraflows_sp_1", "RELEASE SAVEPOINT duraflows_sp_1"]);
  });

  it("rolls a failed nested call back to its savepoint and rethrows", async () => {
    const { pool } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const existingClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient;

    await expect(
      PgTransactionContext.run(pool, existingClient, () =>
        runner.runInTransaction(async () => {
          throw new Error("inner boom");
        }),
      ),
    ).rejects.toThrow("inner boom");

    expect(queriedSql(existingClient)).toEqual([
      "SAVEPOINT duraflows_sp_1",
      "ROLLBACK TO SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
    ]);
  });

  it("gives sibling nested calls distinct savepoint names", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);

    await runner.runInTransaction(async () => {
      await runner.runInTransaction(async () => "first");
      await runner.runInTransaction(async () => "second");
    });

    expect(queriedSql(client)).toEqual([
      "BEGIN",
      "SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
      "SAVEPOINT duraflows_sp_2",
      "RELEASE SAVEPOINT duraflows_sp_2",
      "COMMIT",
    ]);
  });

  it("runs afterCommit callbacks after COMMIT and after releasing the client", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const seen: string[] = [];

    await runner.runInTransaction(async () => {
      runner.afterCommit(async () => {
        seen.push(`callback (released: ${(client.release as ReturnType<typeof vi.fn>).mock.calls.length > 0})`);
      });
    });

    expect(queriedSql(client)).toEqual(["BEGIN", "COMMIT"]);
    expect(seen).toEqual(["callback (released: true)"]);
  });

  it("does not run afterCommit callbacks when COMMIT fails", async () => {
    const { pool, client } = createMocks();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw new Error("could not serialize access");
      return { rows: [] };
    });
    const runner = new PgTransactionRunner(pool);
    const callback = vi.fn(async () => {});

    await expect(
      runner.runInTransaction(async () => {
        runner.afterCommit(callback);
      }),
    ).rejects.toThrow("could not serialize access");

    expect(callback).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("rejects when PostgreSQL answers COMMIT with ROLLBACK, without running callbacks", async () => {
    const { pool, client } = createMocks();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) =>
      sql === "COMMIT" ? { command: "ROLLBACK", rows: [] } : { rows: [] },
    );
    const runner = new PgTransactionRunner(pool);
    const callback = vi.fn(async () => {});

    const outcome = runner.runInTransaction(async () => {
      runner.afterCommit(callback);
    });

    await expect(outcome).rejects.toThrow(WorkflowError);
    await expect(outcome).rejects.toThrow(
      "COMMIT was rolled back by PostgreSQL because an earlier statement in the transaction failed",
    );
    expect(callback).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("PgTransactionContext.transaction inside an active transaction joins it in a savepoint", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const order: string[] = [];

    await runner.runInTransaction(async () => {
      const value = await PgTransactionContext.transaction(pool, async (txClient) => {
        expect(txClient).toBe(client);
        runner.afterCommit(async () => {
          order.push("callback");
        });
        return "inner";
      });
      expect(value).toBe("inner");
      expect(order).toEqual([]);
    });

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(queriedSql(client)).toEqual([
      "BEGIN",
      "SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
      "COMMIT",
    ]);
    expect(order).toEqual(["callback"]);
  });

  it("PgTransactionContext.transaction inside an active transaction rolls back only its savepoint", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const callback = vi.fn(async () => {});

    await runner.runInTransaction(async () => {
      await expect(
        PgTransactionContext.transaction(pool, async () => {
          runner.afterCommit(callback);
          throw new Error("inner failure");
        }),
      ).rejects.toThrow("inner failure");
    });

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(queriedSql(client)).toEqual([
      "BEGIN",
      "SAVEPOINT duraflows_sp_1",
      "ROLLBACK TO SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
      "COMMIT",
    ]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("PgTransactionContext.transaction owns BEGIN/COMMIT and fires callbacks after commit", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const order: string[] = [];

    const result = await PgTransactionContext.transaction(pool, async (txClient) => {
      expect(txClient).toBe(client);
      await runner.runInTransaction(async () => {
        runner.afterCommit(async () => {
          order.push("callback");
        });
      });
      order.push("body done");
      return "value";
    });

    expect(result).toBe("value");
    expect(order).toEqual(["body done", "callback"]);
    expect(queriedSql(client)).toEqual([
      "BEGIN",
      "SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
      "COMMIT",
    ]);
  });

  it("PgTransactionContext.transaction rolls back and drops callbacks on error", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const callback = vi.fn(async () => {});

    await expect(
      PgTransactionContext.transaction(pool, async () => {
        await runner.runInTransaction(async () => runner.afterCommit(callback));
        throw new Error("app failure");
      }),
    ).rejects.toThrow("app failure");

    expect(queriedSql(client)).toContain("ROLLBACK");
    expect(callback).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("rethrows the callback error even when ROLLBACK fails, and still releases the client", async () => {
    const { pool, client } = createMocks();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [] };
    });
    const runner = new PgTransactionRunner(pool);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runner.runInTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(client.release).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rollback failed"));
    warnSpy.mockRestore();
  });

  it("runs afterCommit callbacks outside the finished transaction (no active client)", async () => {
    const { pool } = createMocks();
    const runner = new PgTransactionRunner(pool);
    let clientSeenByCallback: PoolClient | undefined | "unset" = "unset";

    await runner.runInTransaction(async () => {
      runner.afterCommit(async () => {
        clientSeenByCallback = PgTransactionContext.getClient(pool);
      });
    });

    expect(clientSeenByCallback).toBeUndefined();
  });

  it("evicts the client from the pool when ROLLBACK fails, instead of returning it", async () => {
    const { pool, client } = createMocks();
    const rollbackError = new Error("rollback failed");
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw rollbackError;
      return { rows: [] };
    });
    const runner = new PgTransactionRunner(pool);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runner.runInTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // pg destroys a client released with an error rather than pooling it.
    expect(client.release).toHaveBeenCalledWith(rollbackError);
    warnSpy.mockRestore();
  });

  it("returns the client to the pool (no error) after a successful ROLLBACK", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);

    await expect(
      runner.runInTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(client.release).toHaveBeenCalledWith(undefined);
  });
});

describe("PgTransactionRunner timeouts", () => {
  it("emits no SET LOCAL when no timeouts are configured", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("emits no SET LOCAL when an empty options object is passed", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, {});

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("emits SET LOCAL lock_timeout inside the transaction, after BEGIN and before the callback", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { lockTimeoutMs: 3000 });

    await runner.runInTransaction(async () => {
      // The setting must already be in force by the time the callback's own
      // statements (lockByUuid's FOR UPDATE) run.
      expect(queriedSql(client)).toEqual(["BEGIN", "SET LOCAL lock_timeout = 3000"]);
    });

    expect(queriedSql(client)).toEqual(["BEGIN", "SET LOCAL lock_timeout = 3000", "COMMIT"]);
  });

  it("emits both SET LOCAL statements when both timeouts are configured", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { lockTimeoutMs: 3000, statementTimeoutMs: 30000 });

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = 3000",
      "SET LOCAL statement_timeout = 30000",
      "COMMIT",
    ]);
  });

  it("accepts 0 (PostgreSQL's own 'disabled' value)", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { statementTimeoutMs: 0 });

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual(["BEGIN", "SET LOCAL statement_timeout = 0", "COMMIT"]);
  });

  it("does not re-emit SET LOCAL when reusing an existing transaction", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { lockTimeoutMs: 3000 });
    const existingClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient;

    await PgTransactionContext.run(pool, existingClient, () => runner.runInTransaction(async () => "nested"));

    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(queriedSql(existingClient).some((sql) => sql.startsWith("SET LOCAL"))).toBe(false);
  });

  it.each([
    ["a negative value", { lockTimeoutMs: -1 }],
    ["a fractional value", { lockTimeoutMs: 1.5 }],
    ["NaN", { lockTimeoutMs: Number.NaN }],
    ["Infinity", { lockTimeoutMs: Number.POSITIVE_INFINITY }],
    ["a value beyond the safe integer range", { lockTimeoutMs: 1e21 }],
  ])("rejects %s for lockTimeoutMs at construction time", (_label, options) => {
    const { pool } = createMocks();

    expect(() => new PgTransactionRunner(pool, options)).toThrow(WorkflowError);
    expect(() => new PgTransactionRunner(pool, options)).toThrow(/lockTimeoutMs must be a non-negative integer/);
  });

  it("rejects an invalid statementTimeoutMs at construction time", () => {
    const { pool } = createMocks();

    expect(() => new PgTransactionRunner(pool, { statementTimeoutMs: -5 })).toThrow(
      /statementTimeoutMs must be a non-negative integer/,
    );
  });
});
