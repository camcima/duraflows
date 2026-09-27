import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ScopedTransactionContext,
  runAfterCommitCallbacks,
  type TransactionScope,
} from "../../src/transaction/scoped-transaction-context.js";
import { WorkflowError } from "../../src/errors/index.js";

interface FakeConnection {
  name: string;
}

function recorder() {
  const statements: string[] = [];
  const execute = async (sql: string): Promise<void> => {
    statements.push(sql);
  };
  return { statements, execute };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScopedTransactionContext", () => {
  it("current() is undefined outside run() and the scope inside it", () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const root = ctx.createRoot({ name: "c1" });

    expect(ctx.current(owner)).toBeUndefined();
    ctx.run(owner, root, () => {
      expect(ctx.current(owner)).toBe(root);
      expect(ctx.current(owner)?.connection).toEqual({ name: "c1" });
    });
    expect(ctx.current(owner)).toBeUndefined();
  });

  it("keeps scopes separate per owner", () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const ownerA = {};
    const ownerB = {};
    const root = ctx.createRoot({ name: "a" });

    ctx.run(ownerA, root, () => {
      expect(ctx.current(ownerA)).toBe(root);
      expect(ctx.current(ownerB)).toBeUndefined();
    });
  });

  it("afterCommit() outside a scope throws WorkflowError", () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();

    expect(() => ctx.afterCommit({}, async () => {})).toThrow(WorkflowError);
    expect(() => ctx.afterCommit({}, async () => {})).toThrow("afterCommit requires an active transaction");
  });

  it("runInSavepoint releases on success and hands its callbacks to the parent", async () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const root = ctx.createRoot({ name: "c" });
    const { statements, execute } = recorder();
    const inner = async () => {};

    const result = await ctx.run(owner, root, () =>
      ctx.runInSavepoint(
        owner,
        root,
        async () => {
          expect(ctx.current(owner)).not.toBe(root);
          expect(ctx.current(owner)?.connection).toBe(root.connection);
          ctx.afterCommit(owner, inner);
          return "ok";
        },
        execute,
      ),
    );

    expect(result).toBe("ok");
    expect(statements).toEqual(["SAVEPOINT duraflows_sp_1", "RELEASE SAVEPOINT duraflows_sp_1"]);
    expect(root.callbacks).toEqual([inner]);
  });

  it("runInSavepoint rolls back, drops its callbacks and rethrows on failure", async () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const root = ctx.createRoot({ name: "c" });
    const { statements, execute } = recorder();

    await expect(
      ctx.run(owner, root, () =>
        ctx.runInSavepoint(
          owner,
          root,
          async () => {
            ctx.afterCommit(owner, async () => {});
            throw new Error("inner boom");
          },
          execute,
        ),
      ),
    ).rejects.toThrow("inner boom");

    expect(statements).toEqual([
      "SAVEPOINT duraflows_sp_1",
      "ROLLBACK TO SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
    ]);
    expect(root.callbacks).toEqual([]);
  });

  it("runInSavepoint rethrows the original error when ROLLBACK TO fails", async () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const root = ctx.createRoot({ name: "c" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execute = async (sql: string): Promise<void> => {
      if (sql.startsWith("ROLLBACK TO")) throw new Error("connection lost");
    };

    await expect(
      ctx.run(owner, root, () =>
        ctx.runInSavepoint(
          owner,
          root,
          async () => {
            throw new Error("inner boom");
          },
          execute,
        ),
      ),
    ).rejects.toThrow("inner boom");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("connection lost"));
  });

  it("gives sibling savepoints in one transaction distinct names", async () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const root = ctx.createRoot({ name: "c" });
    const { statements, execute } = recorder();

    await ctx.run(owner, root, async () => {
      await ctx.runInSavepoint(owner, root, async () => "first", execute);
      await ctx.runInSavepoint(owner, root, async () => "second", execute);
    });

    expect(statements).toEqual([
      "SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
      "SAVEPOINT duraflows_sp_2",
      "RELEASE SAVEPOINT duraflows_sp_2",
    ]);
  });

  it("runSeeded runs callbacks after an async callback resolves, inside the seeded scope", async () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const connection = { name: "c" };
    const order: string[] = [];
    let seenScopeInCallback: TransactionScope<FakeConnection> | undefined;

    const value = await ctx.runSeeded(owner, connection, async () => {
      ctx.afterCommit(owner, async () => {
        seenScopeInCallback = ctx.current(owner);
        order.push("callback");
      });
      order.push("body");
      return 42;
    });

    expect(value).toBe(42);
    expect(order).toEqual(["body", "callback"]);
    // The caller's transaction is still open, so duraflows calls made from the
    // callback must join it rather than open a second connection.
    expect(seenScopeInCallback).toBeDefined();
    expect(seenScopeInCallback?.connection).toBe(connection);
  });

  it("runSeeded drains callbacks queued by a running callback in the same pass, in order", async () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const order: string[] = [];

    await ctx.runSeeded(owner, { name: "c" }, async () => {
      ctx.afterCommit(owner, async () => {
        order.push("first");
        ctx.afterCommit(owner, async () => {
          order.push("queued by first");
        });
      });
      ctx.afterCommit(owner, async () => {
        order.push("second");
      });
    });

    expect(order).toEqual(["first", "second", "queued by first"]);
  });

  it("runSeeded drops callbacks when the async callback rejects", async () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const callback = vi.fn(async () => {});

    await expect(
      ctx.runSeeded(owner, { name: "c" }, async () => {
        ctx.afterCommit(owner, callback);
        throw new Error("app rollback");
      }),
    ).rejects.toThrow("app rollback");
    expect(callback).not.toHaveBeenCalled();
  });

  it("runSeeded warns and drops callbacks queued by a synchronous callback", () => {
    const ctx = new ScopedTransactionContext<object, FakeConnection>();
    const owner = {};
    const callback = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const value = ctx.runSeeded(owner, { name: "c" }, () => {
      ctx.afterCommit(owner, callback);
      return "sync";
    });

    expect(value).toBe("sync");
    expect(callback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("synchronous"));
  });
});

describe("runAfterCommitCallbacks", () => {
  it("runs callbacks in order and keeps going past one that throws", async () => {
    const order: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAfterCommitCallbacks([
      async () => {
        order.push("first");
      },
      async () => {
        throw new Error("observer exploded");
      },
      async () => {
        order.push("third");
      },
    ]);

    expect(order).toEqual(["first", "third"]);
    expect(warn).toHaveBeenCalledWith("[duraflows] afterCommit callback failed: observer exploded");
  });
});
