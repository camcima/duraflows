import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromHere = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // Make `@duraflows/*` imports inside tests resolve to source rather than
    // dist. Without this, tests that go through the package barrel are
    // counted as 0% by v8 (because the file path coverage sees does not
    // match the package's compiled file path).
    alias: [
      { find: /^@duraflows\/core\/testing$/, replacement: fromHere("./packages/duraflows-core/src/testing/index.ts") },
      { find: /^@duraflows\/core$/, replacement: fromHere("./packages/duraflows-core/src/index.ts") },
      { find: /^@duraflows\/nestjs$/, replacement: fromHere("./packages/duraflows-nestjs/src/index.ts") },
      { find: /^@duraflows\/pg$/, replacement: fromHere("./packages/duraflows-pg/src/index.ts") },
      { find: /^@duraflows\/kysely$/, replacement: fromHere("./packages/duraflows-kysely/src/index.ts") },
    ],
  },
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  test: {
    globals: true,
    include: ["packages/*/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/duraflows-core/src/index.ts",
        "packages/duraflows-nestjs/src/index.ts",
        "packages/duraflows-nestjs/src/controllers/dto/**",
        "packages/duraflows-core/src/types/**",
      ],
      reporter: ["text", "text-summary", "html", "json"],
      reportsDirectory: "coverage",
      // Set just under the actuals at the time of writing (99.38 / 97.17 / 100
      // / 99.62) so real regressions fail the run while ordinary churn does
      // not. Codecov's project target is the loose backstop; this is the tight
      // local gate. Global, not per-file: per-file thresholds turn a single
      // small uncovered branch into a build failure in an unrelated package.
      thresholds: {
        statements: 99,
        branches: 96,
        functions: 100,
        lines: 99,
      },
    },
  },
});
