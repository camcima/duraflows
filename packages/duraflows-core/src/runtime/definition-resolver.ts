import type { WorkflowDefinition } from "../types/definition.js";
import type { WorkflowInstance } from "../types/runtime.js";
import type { WorkflowDefinitionStore } from "../types/persistence.js";
import type { WorkflowDefinitionRegistry } from "../registry/definition-registry.js";
import type { CompiledWorkflow, WorkflowCompiler } from "../compilation/workflow-compiler.js";
import { WorkflowValidator } from "../validation/workflow-validator.js";
import { IncompatibleDefinitionError, WorkflowDefinitionError } from "../errors/index.js";
import { deepFreeze } from "../util/deep-freeze.js";

export interface ResolvedDefinition {
  definition: WorkflowDefinition;
  compiled: CompiledWorkflow;
}

export interface DefinitionResolverOptions {
  definitionRegistry: WorkflowDefinitionRegistry;
  compiler: WorkflowCompiler;
  definitionStore?: WorkflowDefinitionStore;
  validator?: WorkflowValidator;
}

/**
 * Decides which definition governs an operation. New instances always start
 * on the latest registered definition. An existing instance follows the latest
 * definition's `versionPolicy`: pinned instances execute the version they were
 * stamped with (older versions load from the definition store), and "latest"
 * instances execute the latest definition if it still has their state.
 */
export class DefinitionResolver {
  private readonly definitionRegistry: WorkflowDefinitionRegistry;
  private readonly compiler: WorkflowCompiler;
  private readonly definitionStore?: WorkflowDefinitionStore;
  private readonly validator: WorkflowValidator;
  // Resolved snapshots of older versions, keyed "name@version". Failures are
  // not cached, so a transient store error is retried on the next call.
  private readonly snapshots = new Map<string, ResolvedDefinition>();
  private warnedNoStore = false;

  constructor(options: DefinitionResolverOptions) {
    this.definitionRegistry = options.definitionRegistry;
    this.compiler = options.compiler;
    this.definitionStore = options.definitionStore;
    this.validator = options.validator ?? new WorkflowValidator();
  }

  forNewInstance(workflowName: string): ResolvedDefinition {
    return this.latest(workflowName);
  }

  async forInstance(instance: WorkflowInstance): Promise<ResolvedDefinition> {
    const latest = this.latest(instance.workflowName);
    if (!this.definitionStore) {
      this.warnIfPinningInactive();
      return latest;
    }
    // Legacy rows from before 5.0 adopt the latest version on their next transition.
    if (instance.definitionVersion === null) {
      return latest;
    }
    const latestVersion = latest.definition.version ?? 1;
    if (latest.definition.versionPolicy === "latest") {
      if (!Object.hasOwn(latest.definition.states, instance.currentState)) {
        throw new IncompatibleDefinitionError(
          instance.uuid,
          instance.workflowName,
          instance.currentState,
          latestVersion,
        );
      }
      return latest;
    }
    if (instance.definitionVersion === latestVersion) {
      return latest;
    }
    return this.snapshot(this.definitionStore, instance);
  }

  private latest(workflowName: string): ResolvedDefinition {
    const definition = this.definitionRegistry.get(workflowName);
    return { definition, compiled: this.compiler.compile(definition) };
  }

  private async snapshot(store: WorkflowDefinitionStore, instance: WorkflowInstance): Promise<ResolvedDefinition> {
    const { workflowName } = instance;
    const version = instance.definitionVersion as number;
    const key = `${workflowName}@${version}`;
    const cached = this.snapshots.get(key);
    if (cached) return cached;

    const stored = await store.findByNameAndVersion(workflowName, version);
    if (!stored) {
      throw new WorkflowDefinitionError(
        workflowName,
        `instance ${instance.uuid} is pinned to version ${version}, which is not in the definition store`,
      );
    }
    const definition = deepFreeze(structuredClone(stored.definitionJson));
    // Structure only: whether its commands and guards are registered is the
    // startup executability check's job.
    const validation = this.validator.validate(definition);
    if (!validation.valid) {
      throw new WorkflowDefinitionError(
        workflowName,
        `stored version ${version} is invalid: ${validation.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const resolved = { definition, compiled: this.compiler.compile(definition) };
    this.snapshots.set(key, resolved);
    return resolved;
  }

  private warnIfPinningInactive(): void {
    if (this.warnedNoStore) return;
    if (this.definitionRegistry.getAll().some((d) => d.versionPolicy !== "latest")) {
      this.warnedNoStore = true;
      console.warn(
        "[duraflows] definition version pinning is inactive because no definition store is configured; " +
          "every instance executes the latest registered definition",
      );
    }
  }
}
