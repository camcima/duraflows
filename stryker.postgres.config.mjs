import baseConfig from "./stryker.config.mjs";

if (!process.env.STRYKER_POSTGRES_DATABASE_PREFIX) {
  throw new Error("Use pnpm test:mutation:postgres to provision and clean up isolated worker databases.");
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...baseConfig,
  vitest: { configFile: "vitest.mutation.postgres.config.ts", related: false },
  // Focus the database-backed pass on persistence and durable worker guarantees.
  mutate: [
    "packages/duraflows-pg/src/**/*.ts",
    "packages/duraflows-kysely/src/**/*.ts",
    "!packages/*/src/index.ts",
    "packages/duraflows-core/src/runtime/durable-execution.ts",
  ],
  ignorePatterns: [...baseConfig.ignorePatterns, "!packages/duraflows-pg/sql/dbmate/*.sql"],
  // Each runner receives its own disposable database before Vitest loads.
  testRunnerNodeArgs: ["--import", new URL("./scripts/stryker-postgres-worker.mjs", import.meta.url).href],
  concurrency: 4,
  incrementalFile: "reports/mutation/postgres/incremental.json",
  htmlReporter: { fileName: "reports/mutation/postgres/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/postgres/mutation.json" },
};
