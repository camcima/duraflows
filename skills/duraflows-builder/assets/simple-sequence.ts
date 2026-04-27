/**
 * Simple Sequence Workflow
 *
 * Pattern: Linear state progression with commands, error handling, and a timeout.
 * Domain:  Document processing pipeline.
 *
 * Flow:
 *   draft -> submitted -> (onEnter: validate) -> validated -> processing -> completed
 *                                              -> validation_failed -> submitted (retry)
 *   completed -> (timeout 30 days) -> archived
 */

import type { WorkflowDefinition, WorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/core";

// ---------------------------------------------------------------------------
// 1. Workflow Definition
// ---------------------------------------------------------------------------

export const documentWorkflow: WorkflowDefinition = {
  name: "document-processing",
  initialState: "draft",
  states: {
    draft: {
      context: { status: "draft" },
      events: {
        Submit: {
          targetState: "submitted",
        },
      },
    },

    submitted: {
      context: { status: "submitted" },
      events: {
        StartValidation: {
          targetState: "validating",
        },
      },
    },

    // Gateway state: auto-validates on entry
    validating: {
      onEnter: {
        targetState: "validated",
        errorState: "validation_failed",
        commands: [{ name: "validateDocument" }],
      },
    },

    validated: {
      context: { status: "validated" },
      events: {
        Process: {
          targetState: "completed",
          errorState: "processing_failed",
          commands: [{ name: "processDocument" }, { name: "sendConfirmation" }],
        },
      },
    },

    validation_failed: {
      context: { status: "validation_failed" },
      events: {
        Resubmit: {
          targetState: "submitted",
        },
      },
    },

    processing_failed: {
      context: { status: "processing_failed" },
      events: {
        Retry: {
          targetState: "validated", // go back to validated so Process can be triggered again
        },
      },
    },

    completed: {
      context: { status: "completed" },
      events: {
        AutoArchive: {
          targetState: "archived",
          timeout: { afterDays: 30 },
        },
      },
    },

    archived: {
      context: { status: "archived" },
      // terminal state
    },
  },
};

// ---------------------------------------------------------------------------
// 2. Example Command Implementations
// ---------------------------------------------------------------------------

export class ValidateDocumentCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const documentId = ctx.metadata.documentId as string;

    // Example: call a validation service
    // const result = await this.validationService.validate(documentId);

    // Simulate validation logic
    const isValid = true; // replace with real logic

    if (!isValid) {
      ctx.context.validationError = "Document failed schema check";
      return { ok: false, code: "INVALID_DOCUMENT", message: "Schema validation failed" };
    }

    ctx.context.validatedAt = ctx.now.toISOString();
    return { ok: true, code: "VALID" };
  }
}

export class ProcessDocumentCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const documentId = ctx.metadata.documentId as string;

    try {
      // Example: process the document
      // const result = await this.processor.process(documentId);

      ctx.context.processedAt = ctx.now.toISOString();
      return { ok: true, code: "PROCESSED" };
    } catch (err) {
      return { ok: false, code: "PROCESSING_ERROR", message: String(err) };
    }
  }
}

/**
 * v1.0.0: `bestEffort: true` makes this fire-and-forget. A returned ok:false
 * OR a thrown exception is recorded honestly in history but does NOT abort the
 * chain or taint the aggregate `outcome`. Replaces the v0.x pattern of
 * swallowing errors and returning `{ ok: true }` anyway.
 */
export class SendConfirmationCommand implements WorkflowCommand {
  readonly bestEffort = true;

  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const documentId = ctx.metadata.documentId as string;
    const ownerEmail = ctx.metadata.ownerEmail as string;

    // Let the underlying call throw or return ok:false naturally — the runtime captures it.
    // await this.mailer.send({ to: ownerEmail, subject: `Document ${documentId} processed` });

    return { ok: true, code: "CONFIRMATION_SENT" };
  }
}

// ---------------------------------------------------------------------------
// 3. Usage Example
// ---------------------------------------------------------------------------

/*
// Create an instance
const instance = await runtime.createInstance({
  workflowName: "document-processing",
  metadata: { documentId: "DOC-001", ownerEmail: "user@example.com" },
});

const handle = runtime.getHandle(instance.uuid);

// Progress through the workflow
await handle.triggerEvent("Submit");
await handle.triggerEvent("StartValidation");  // auto-validates via onEnter
await handle.triggerEvent("Process");          // runs processDocument + sendConfirmation

// Check final state
const current = await handle.getInstance();
console.log(current?.currentState); // "completed"
*/
