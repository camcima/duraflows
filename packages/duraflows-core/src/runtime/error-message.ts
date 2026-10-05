import type { CommandResult } from "../types/runtime.js";

/**
 * Pulls the operator-facing message out of a failed transition. Only the last
 * command result matters — the executor stops at the first failure, so every
 * earlier result succeeded.
 */
export function extractErrorMessage(
  outcome: "success" | "failure" | "guard-rejected",
  commandResults: readonly CommandResult[],
): string | undefined {
  if (outcome !== "failure" || commandResults.length === 0) {
    return undefined;
  }
  const lastResult = commandResults[commandResults.length - 1];
  // `ok` here is defensive: the executor stops at the first failure, so a
  // "failure" outcome always ends on a failed result.
  return lastResult.ok ? undefined : (lastResult.message ?? lastResult.code ?? "Command failed");
}
