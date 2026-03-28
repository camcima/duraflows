import { defineConfig } from "vitest/config";

export default defineConfig({
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
    },
  },
});
