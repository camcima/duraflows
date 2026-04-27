/**
 * Fan-Out / Fan-In Workflow
 *
 * Pattern: Multi-step processing pipeline using onEnter chains.
 * Domain:  Data enrichment pipeline -- enrich, validate, then notify.
 *
 * Important: duraflows does NOT support true parallel execution. This pattern
 * simulates a pipeline by chaining gateway states via onEnter. Each step
 * executes sequentially within a single transaction.
 *
 * For true parallelism, track sub-tasks in context and use separate events
 * to signal each sub-task's completion.
 *
 * Flow (onEnter chain):
 *   pending -> (Submit) -> enriching -> validating -> notifying -> completed
 *                          |             |
 *                          v             v
 *                       enrich_failed  validation_failed
 *                          |             |
 *                          v             v
 *                       (Retry)       (Retry)
 *
 * v1.0.0: notification step is bestEffort — a failed send is recorded in
 * history but the pipeline still reaches `completed`.
 */

import type { WorkflowDefinition, WorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/core";

// ---------------------------------------------------------------------------
// 1. Workflow Definition
// ---------------------------------------------------------------------------

export const enrichmentPipelineWorkflow: WorkflowDefinition = {
  name: "enrichment-pipeline",
  initialState: "pending",
  states: {
    pending: {
      context: { status: "pending", pipelineStage: null },
      events: {
        Submit: {
          targetState: "enriching",
        },
      },
    },

    // Gateway: auto-enrich on entry
    enriching: {
      context: { pipelineStage: "enriching" },
      onEnter: {
        targetState: "validating",
        errorState: "enrich_failed",
        commands: [{ name: "enrichFromSourceA" }, { name: "enrichFromSourceB" }],
      },
    },

    // Gateway: auto-validate on entry (chained from enriching)
    validating: {
      context: { pipelineStage: "validating" },
      onEnter: {
        targetState: "notifying",
        errorState: "validation_failed",
        commands: [{ name: "validateEnrichedData" }],
      },
    },

    // Gateway: auto-notify on entry (chained from validating).
    // v1.0.0: sendCompletionNotification is bestEffort, so a notification
    // failure no longer blocks the pipeline from reaching `completed`. The
    // legacy `notification_failed` state is removed below.
    notifying: {
      context: { pipelineStage: "notifying" },
      onEnter: {
        targetState: "completed",
        commands: [{ name: "sendCompletionNotification" }],
      },
    },

    completed: {
      context: { status: "completed", pipelineStage: "done" },
      // terminal state
    },

    // Error states with retry capability
    enrich_failed: {
      context: { status: "enrich_failed" },
      events: {
        Retry: {
          targetState: "enriching", // re-enter the onEnter chain
        },
      },
    },

    validation_failed: {
      context: { status: "validation_failed" },
      events: {
        Retry: {
          targetState: "validating",
        },
        // Could also skip validation:
        ForceComplete: {
          targetState: "notifying",
        },
      },
    },

    // (removed in v1.0.0 — sendCompletionNotification is bestEffort, so the
    // pipeline reaches `completed` even if the notification fails. The failure
    // is recorded in workflow_history with code BEST_EFFORT_THROWN or the
    // returned ok:false code, and an observer can fan out a retry job offline.)
  },
};

// ---------------------------------------------------------------------------
// 2. Example Command Implementations
// ---------------------------------------------------------------------------

export class EnrichFromSourceACommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const recordId = ctx.metadata.recordId as string;

    try {
      // const data = await sourceAClient.enrich(recordId);
      // ctx.context.sourceAData = data;
      ctx.context.sourceAEnrichedAt = ctx.now.toISOString();
      return { ok: true, code: "SOURCE_A_ENRICHED" };
    } catch (err) {
      return { ok: false, code: "SOURCE_A_FAILED", message: String(err) };
    }
  }
}

export class EnrichFromSourceBCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const recordId = ctx.metadata.recordId as string;

    try {
      // const data = await sourceBClient.enrich(recordId);
      // ctx.context.sourceBData = data;
      ctx.context.sourceBEnrichedAt = ctx.now.toISOString();
      return { ok: true, code: "SOURCE_B_ENRICHED" };
    } catch (err) {
      return { ok: false, code: "SOURCE_B_FAILED", message: String(err) };
    }
  }
}

export class ValidateEnrichedDataCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    // Validate that enrichment data is consistent
    const hasSourceA = !!ctx.context.sourceAEnrichedAt;
    const hasSourceB = !!ctx.context.sourceBEnrichedAt;

    if (!hasSourceA || !hasSourceB) {
      return { ok: false, code: "INCOMPLETE_ENRICHMENT", message: "Missing enrichment data" };
    }

    ctx.context.validatedAt = ctx.now.toISOString();
    return { ok: true, code: "VALIDATION_PASSED" };
  }
}

/**
 * v1.0.0: bestEffort. A returned ok:false or a thrown notification error
 * is captured in history but does NOT abort the chain — the pipeline still
 * reaches `completed`.
 */
export class SendCompletionNotificationCommand implements WorkflowCommand {
  readonly bestEffort = true;

  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const recordId = ctx.metadata.recordId as string;

    // Let the call throw or return ok:false naturally — the runtime captures it.
    // await notificationService.send({ recordId, status: "enrichment_complete" });
    ctx.context.notifiedAt = ctx.now.toISOString();
    return { ok: true, code: "NOTIFIED" };
  }
}

// ---------------------------------------------------------------------------
// 3. Usage Example
// ---------------------------------------------------------------------------

/*
// The entire pipeline runs in one transaction when Submit is triggered:
// pending -> enriching (onEnter) -> validating (onEnter) -> notifying (onEnter) -> completed

const instance = await runtime.createInstance({
  workflowName: "enrichment-pipeline",
  metadata: { recordId: "REC-001", source: "import-batch-42" },
});

const handle = runtime.getHandle(instance.uuid);
const result = await handle.triggerEvent("Submit");

// If the full chain succeeds:
console.log(result.toState); // "completed"

// If enrichment fails:
// result.toState would be "enrich_failed"
// Then retry:
// await handle.triggerEvent("Retry");
*/
