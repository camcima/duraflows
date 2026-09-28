import type { WorkflowInstance } from "../types/runtime.js";
import type { StateEnterEvent } from "../types/observer.js";
import { deepFreeze } from "../util/deep-freeze.js";

/**
 * Builds the post-commit observer payload for a state entry. Context and
 * metadata are cloned and frozen so an observer cannot reach back into the live
 * instance. `triggerMetadata` is frozen in place, so callers must pass an object
 * they own — a fresh literal or a clone, never the caller's input directly.
 */
export function buildStateEnterEvent(
  instance: WorkflowInstance,
  params: {
    fromState: string | null;
    toState: string;
    transitionUuid: string;
    triggerEvent: string | null;
    triggerMetadata: Record<string, unknown>;
    occurredAt: Date;
  },
): StateEnterEvent {
  return {
    workflowName: instance.workflowName,
    instanceUuid: instance.uuid,
    state: params.toState,
    fromState: params.fromState,
    toState: params.toState,
    transitionUuid: params.transitionUuid,
    triggerEvent: params.triggerEvent,
    context: deepFreeze(structuredClone(instance.context)),
    metadata: deepFreeze(structuredClone(instance.metadata)),
    triggerMetadata: deepFreeze(params.triggerMetadata),
    occurredAt: params.occurredAt,
  };
}
