import { Inject, Injectable } from "@nestjs/common";
import { WorkflowHandle } from "@duraflows/core";
import type {
  WorkflowRuntime,
  CreateWorkflowInstanceInput,
  TriggerWorkflowEventInput,
  GetAvailableEventsInput,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowExecutionResult,
  AvailableWorkflowEvent,
  WorkflowHistoryRecord,
} from "@duraflows/core";
import { WORKFLOW_RUNTIME } from "../providers/injection-tokens.js";

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_RUNTIME)
    private readonly runtime: WorkflowRuntime,
  ) {}

  async createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance> {
    return this.runtime.createInstance(input);
  }

  /**
   * Type-safe variant of {@link createInstance} that binds the resulting
   * instance's `currentState` to the state union of the supplied
   * `WorkflowDefinition`. Use when the caller has a typed definition in
   * hand and wants to avoid widening `currentState` to `string`.
   *
   * The `workflowName` is read from the definition; callers pass only the
   * non-name portion of `CreateWorkflowInstanceInput`.
   */
  async createInstanceFor<TState extends string>(
    definition: WorkflowDefinition<TState>,
    input: Omit<CreateWorkflowInstanceInput, "workflowName"> = {},
  ): Promise<WorkflowInstance<TState>> {
    const instance = await this.runtime.createInstance({
      ...input,
      workflowName: definition.name,
    });
    // The runtime initialises `currentState` from `definition.initialState`,
    // which is `TState`. Narrowing here is justified by that invariant.
    return instance as WorkflowInstance<TState>;
  }

  async triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult> {
    return this.runtime.triggerEvent(input);
  }

  async getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]> {
    return this.runtime.getAvailableEvents(input);
  }

  async getInstance(uuid: string): Promise<WorkflowInstance | null> {
    return this.runtime.getInstance(uuid);
  }

  async getHistory(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    return this.runtime.getHistory(workflowInstanceUuid, options);
  }

  getHandle(uuid: string): WorkflowHandle {
    return new WorkflowHandle(uuid, this);
  }
}
