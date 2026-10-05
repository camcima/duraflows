import type {
  EnqueueWorkflowEventInput,
  DurableWorkflowExecution,
  ProcessPendingExecutionsInput,
  ProcessPendingExecutionsResult,
} from "@duraflows/core";
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
  DefinitionVersionSummary,
  MigrateInstancesInput,
  MigrateInstancesResult,
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

  /**
   * Type-safe variant of {@link triggerEvent} that narrows the resulting
   * `fromState`/`toState` to the state union of the supplied
   * `WorkflowDefinition`. Use when the caller has a typed definition in
   * hand and wants to avoid widening to `string`.
   *
   * Does not validate at runtime that the instance belongs to the given
   * definition — that is the caller's responsibility (typically enforced
   * upstream when the instance was created via `createInstanceFor`).
   */
  async triggerEventFor<TState extends string>(
    definition: WorkflowDefinition<TState>,
    input: TriggerWorkflowEventInput,
  ): Promise<WorkflowExecutionResult<TState>> {
    // `definition` is consumed at type level only -- it is what infers TState.
    // The runtime resolves the instance by uuid and reads its workflowName from
    // the live row, so there is nothing to do with the value at runtime.
    const result = await this.runtime.triggerEvent(input);
    return result as WorkflowExecutionResult<TState>;
  }

  async enqueueEvent(input: EnqueueWorkflowEventInput): Promise<DurableWorkflowExecution> {
    return this.runtime.enqueueEvent(input);
  }
  async getExecution(uuid: string): Promise<DurableWorkflowExecution | null> {
    return this.runtime.getExecution(uuid);
  }
  async processPendingExecutions(input?: ProcessPendingExecutionsInput): Promise<ProcessPendingExecutionsResult> {
    return this.runtime.processPendingExecutions(input);
  }
  async retryExecution(uuid: string): Promise<DurableWorkflowExecution> {
    return this.runtime.retryExecution(uuid);
  }
  async cancelExecution(uuid: string): Promise<DurableWorkflowExecution> {
    return this.runtime.cancelExecution(uuid);
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

  async listDefinitionVersions(workflowName: string): Promise<DefinitionVersionSummary[]> {
    return this.runtime.listDefinitionVersions(workflowName);
  }

  async migrateInstances(input: MigrateInstancesInput): Promise<MigrateInstancesResult> {
    return this.runtime.migrateInstances(input);
  }

  getHandle(uuid: string): WorkflowHandle {
    return new WorkflowHandle(uuid, this);
  }
}
