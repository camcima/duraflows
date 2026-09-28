import type { WorkflowDefinition } from "../types/definition.js";
import type { StoredWorkflowDefinition, WorkflowDefinitionStore, WorkflowInstanceStore } from "../types/persistence.js";
import type { WorkflowDefinitionRegistry } from "../registry/definition-registry.js";
import type { WorkflowCommandRegistry } from "../registry/command-registry.js";
import type { WorkflowGuardRegistry } from "../registry/guard-registry.js";
import { WorkflowValidator } from "../validation/workflow-validator.js";

/**
 * States an instance never leaves: no events and no onEnter. Instances resting
 * in one never execute their definition again, so they are not "active".
 */
export function terminalStates(definition: WorkflowDefinition): string[] {
  return Object.entries(definition.states)
    .filter(([, state]) => Object.keys(state.events ?? {}).length === 0 && !state.onEnter)
    .map(([name]) => name);
}

/** Every command and guard name the definition references, each once, in definition order. */
export function referencedNames(definition: WorkflowDefinition): { commands: string[]; guards: string[] } {
  const commands = new Set<string>();
  const guards = new Set<string>();
  for (const state of Object.values(definition.states)) {
    for (const event of Object.values(state.events ?? {})) {
      if (event.guard) guards.add(event.guard.name);
      for (const command of event.commands ?? []) commands.add(command.name);
    }
    for (const command of state.onEnter?.commands ?? []) commands.add(command.name);
  }
  return { commands: [...commands], guards: [...guards] };
}

/** Non-terminal instances stamped with the stored version. */
export function countActiveInstances(
  instanceStore: WorkflowInstanceStore,
  stored: StoredWorkflowDefinition,
): Promise<number> {
  return instanceStore.countInstances({
    workflowName: stored.workflowName,
    definitionVersion: stored.version,
    excludeStates: terminalStates(stored.definitionJson),
  });
}

/** "1 active instance", "12 active instances". */
export function activeInstancesLabel(count: number): string {
  return `${count} active instance${count === 1 ? "" : "s"}`;
}

export interface UnresolvableVersion {
  workflowName: string;
  /**
   * e.g. `Workflow "order": version 3 (12 active instances) references unregistered commands [a], guards [b]`,
   * or `... (1 active instance) is invalid: <validation errors>`.
   */
  description: string;
}

/**
 * Stored versions that still have active instances but cannot execute: they
 * reference a command or guard that is not registered, or their snapshot is
 * structurally invalid (validated as `DefinitionResolver` does, structure only).
 * Workflows whose registered definition uses `versionPolicy: "latest"` are
 * skipped: their instances never execute a stored snapshot. Without a guard
 * registry, every guard reference is missing.
 */
export async function findUnresolvableVersions(deps: {
  definitionRegistry: WorkflowDefinitionRegistry;
  definitionStore: WorkflowDefinitionStore;
  instanceStore: WorkflowInstanceStore;
  commandRegistry: WorkflowCommandRegistry;
  guardRegistry?: WorkflowGuardRegistry;
}): Promise<UnresolvableVersion[]> {
  const validator = new WorkflowValidator();
  const problems: UnresolvableVersion[] = [];
  for (const registered of deps.definitionRegistry.getAll()) {
    if (registered.versionPolicy === "latest") continue;
    for (const stored of await deps.definitionStore.listVersions(registered.name)) {
      const active = await countActiveInstances(deps.instanceStore, stored);
      if (active === 0) continue;
      const refs = referencedNames(stored.definitionJson);
      const commands = refs.commands.filter((name) => !deps.commandRegistry.has(name));
      const guards = refs.guards.filter((name) => !deps.guardRegistry?.has(name));
      const validation = validator.validate(stored.definitionJson);
      const reasons: string[] = [];
      if (commands.length > 0 || guards.length > 0) {
        const missing = [
          ...(commands.length > 0 ? [`commands [${commands.join(", ")}]`] : []),
          ...(guards.length > 0 ? [`guards [${guards.join(", ")}]`] : []),
        ].join(", ");
        reasons.push(`references unregistered ${missing}`);
      }
      if (!validation.valid) {
        reasons.push(`is invalid: ${validation.errors.map((e) => e.message).join("; ")}`);
      }
      if (reasons.length === 0) continue;
      problems.push({
        workflowName: registered.name,
        description:
          `Workflow "${registered.name}": version ${stored.version} (${activeInstancesLabel(active)}) ` +
          reasons.join(" and "),
      });
    }
  }
  return problems;
}
