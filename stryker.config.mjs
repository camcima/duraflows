/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: {
    configFile: "vitest.mutation.config.ts",
    related: false,
  },
  mutate: [
    "packages/*/src/**/*.ts",
    "!packages/*/src/index.ts",
    "!packages/duraflows-core/src/types/**",
    "!packages/duraflows-core/src/testing/**",
    "!packages/duraflows-nestjs/src/controllers/dto/**",
  ],
  ignorePatterns: [
    "**",
    "!packages/*/src/**/*.ts",
    "!packages/*/tests/**/*.ts",
    "!packages/*/tsconfig*.json",
    "!vitest*.ts",
    "!tsconfig*.json",
    "!package.json",
    "!pnpm-workspace.yaml",
  ],
  concurrency: 4,
  timeoutMS: 5_000,
  reporters: ["clear-text", "progress", "html", "json"],
  clearTextReporter: { reportTests: false, reportMutants: false },
  incremental: true,
  incrementalFile: "reports/mutation/incremental.json",
  thresholds: { high: 80, low: 60, break: null },
};
