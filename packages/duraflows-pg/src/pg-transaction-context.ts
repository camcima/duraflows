import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";

// One context per Pool: a transaction on pool A is invisible to stores and
// runners bound to pool B, so multi-database deployments cannot cross wires.
const storages = new WeakMap<Pool, AsyncLocalStorage<PoolClient>>();

function storageFor(pool: Pool): AsyncLocalStorage<PoolClient> {
  let storage = storages.get(pool);
  if (!storage) {
    storage = new AsyncLocalStorage<PoolClient>();
    storages.set(pool, storage);
  }
  return storage;
}

export const PgTransactionContext = {
  getClient(pool: Pool): PoolClient | undefined {
    return storages.get(pool)?.getStore();
  },

  run<T>(pool: Pool, client: PoolClient, callback: () => T): T {
    return storageFor(pool).run(client, callback);
  },
};
