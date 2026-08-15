import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["**/dist/", "**/node_modules/", "**/*.js", "!eslint.config.js"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Kept at "warn" so editors surface it inline rather than as a red error,
      // but the `lint` script runs with `--max-warnings=0`, so it still blocks
      // CI. Use a narrowly-scoped eslint-disable with a reason for the rare
      // place a genuine `any` is unavoidable.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
