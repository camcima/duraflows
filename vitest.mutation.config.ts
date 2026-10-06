import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      fsModuleCache: true,
      // These suites need a real database. Keep the mutation baseline independent
      // of DATABASE_URL; all unit and in-memory integration tests still run.
      exclude: [
        ...configDefaults.exclude,
        "packages/duraflows-pg/tests/integration/pg-adapter.integration.test.ts",
        "packages/duraflows-pg/tests/integration/pg-migrations-sequential.integration.test.ts",
        "packages/duraflows-kysely/tests/integration/kysely-adapter.integration.test.ts",
      ],
    },
  }),
);
