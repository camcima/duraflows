import { createHash } from "node:crypto";
import type { WorkflowDefinition } from "../types/definition.js";

/**
 * Root-level keys excluded from the content hash:
 * - `version`: the hash exists to detect content changes between versions,
 *   so the version label itself must not affect it.
 * - `versionPolicy`: deployment intent (a later-phase field), not workflow
 *   content. Excluded from day one so its introduction won't change hashes.
 */
const EXCLUDED_ROOT_KEYS = ["version", "versionPolicy"];

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const [key, v] of entries) {
      result[key] = canonicalize(v);
    }
    return result;
  }
  return value;
}

/**
 * Computes the canonical content hash of a workflow definition: SHA-256 over
 * a canonical JSON serialization (recursively sorted keys, `undefined`
 * properties dropped, array order preserved), prefixed with the algorithm
 * name for future agility.
 */
export function computeDefinitionHash(definition: WorkflowDefinition): string {
  const content: Record<string, unknown> = { ...definition };
  for (const key of EXCLUDED_ROOT_KEYS) {
    delete content[key];
  }
  const serialized = JSON.stringify(canonicalize(content));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}
