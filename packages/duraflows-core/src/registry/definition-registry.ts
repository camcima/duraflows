import type { WorkflowDefinition } from "../types/definition.js";
import { WorkflowDefinitionError } from "../errors/index.js";
import type {
  WorkflowValidator,
  WorkflowValidationOptions,
  ValidationError,
} from "../validation/workflow-validator.js";
import type { WorkflowCompiler } from "../compilation/workflow-compiler.js";
import { deepFreeze } from "../util/deep-freeze.js";

export interface WorkflowDefinitionRegistry {
  get(workflowName: string): WorkflowDefinition;
  has(workflowName: string): boolean;
  getAll(): WorkflowDefinition[];
}

export interface InMemoryDefinitionRegistryOptions {
  validator?: WorkflowValidator;
  compiler?: WorkflowCompiler;
  validationOptions?: WorkflowValidationOptions;
  /**
   * Called once per non-fatal validation warning (e.g. unreachable states)
   * at registration time. Without it, warnings are computed and discarded.
   */
  onValidationWarning?: (workflowName: string, warning: ValidationError) => void;
}

export class InMemoryDefinitionRegistry implements WorkflowDefinitionRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly validator?: WorkflowValidator;
  private readonly compiler?: WorkflowCompiler;
  private readonly validationOptions?: WorkflowValidationOptions;
  private readonly onValidationWarning?: (workflowName: string, warning: ValidationError) => void;

  constructor(options?: InMemoryDefinitionRegistryOptions) {
    this.validator = options?.validator;
    this.compiler = options?.compiler;
    this.validationOptions = options?.validationOptions;
    this.onValidationWarning = options?.onValidationWarning;
  }

  register(definition: WorkflowDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new WorkflowDefinitionError(definition.name, "A workflow with this name is already registered");
    }

    const frozen = deepFreeze(structuredClone(definition));

    if (this.validator) {
      const validation = this.validator.validate(frozen, this.validationOptions);
      if (!validation.valid) {
        throw new WorkflowDefinitionError(
          frozen.name,
          `Invalid definition: ${validation.errors.map((e) => e.message).join("; ")}`,
        );
      }
      if (this.onValidationWarning) {
        for (const warning of validation.warnings ?? []) {
          this.onValidationWarning(frozen.name, warning);
        }
      }
    }

    if (this.compiler) {
      this.compiler.compile(frozen);
    }

    this.definitions.set(frozen.name, frozen);
  }

  get(workflowName: string): WorkflowDefinition {
    const definition = this.definitions.get(workflowName);
    if (!definition) {
      throw new WorkflowDefinitionError(workflowName, "Workflow not found in registry");
    }
    return definition;
  }

  has(workflowName: string): boolean {
    return this.definitions.has(workflowName);
  }

  getAll(): WorkflowDefinition[] {
    return Array.from(this.definitions.values());
  }
}
