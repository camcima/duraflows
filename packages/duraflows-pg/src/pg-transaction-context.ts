import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

const storage = new AsyncLocalStorage<PoolClient>();

export const PgTransactionContext = {
  getClient(): PoolClient | undefined {
    return storage.getStore();
  },

  run<T>(client: PoolClient, callback: () => T): T {
    return storage.run(client, callback);
  },
};
