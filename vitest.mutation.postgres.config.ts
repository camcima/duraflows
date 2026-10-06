import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

if (!process.env.DATABASE_URL) {
  throw new Error("The PostgreSQL mutation pass requires DATABASE_URL pointing to a disposable test database.");
}

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    fsModuleCache: true,
    // Instrumented multi-row database cases need more headroom than unit tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Keep schema setup/cleanup serial within the single Stryker worker, too.
    fileParallelism: false,
    maxWorkers: 1,
    env: { REQUIRE_INTEGRATION_DB: "1" },
  },
});
