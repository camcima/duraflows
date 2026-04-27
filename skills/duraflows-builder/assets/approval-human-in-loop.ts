/**
 * Approval / Human-in-the-Loop Workflow
 *
 * Pattern: Waiting states with human decision points and timeout escalation.
 * Domain:  Document approval with review, revision cycles, and auto-escalation.
 *
 * Flow:
 *   draft -> (Submit) -> review_pending -> (Approve) -> approved -> (Publish) -> published
 *                         |      ^          (Reject) -> changes_requested -> (Resubmit) -> review_pending
 *                         |      |
 *                         v      |
 *                    (timeout 48h) -> escalated -> (ForceApprove) -> approved
 *                                                  (ForceReject) -> rejected
 *
 * Key design points:
 * - Waiting states (review_pending) have no onEnter -- they wait for human action
 * - Timeout escalation auto-triggers after 48 hours of inactivity
 * - triggerMetadata tracks who performed each action (stored in history)
 * - Context accumulates revision history
 */

import type { WorkflowDefinition, WorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/core";

// ---------------------------------------------------------------------------
// 1. Workflow Definition
// ---------------------------------------------------------------------------

export const approvalWorkflow: WorkflowDefinition = {
  name: "document-approval",
  initialState: "draft",
  states: {
    draft: {
      context: {
        status: "draft",
        revisionCount: 0,
        reviewers: [],
      },
      events: {
        Submit: {
          targetState: "review_pending",
          commands: [{ name: "notifyReviewers" }],
        },
      },
    },

    // Waiting state: human must approve, reject, or let it escalate
    review_pending: {
      context: { status: "review_pending" },
      events: {
        Approve: {
          targetState: "approved",
          commands: [{ name: "recordApproval" }],
        },
        Reject: {
          targetState: "changes_requested",
          commands: [{ name: "recordRejection" }],
        },
        // Auto-escalate if no action within 48 hours
        Escalate: {
          targetState: "escalated",
          timeout: { afterHours: 48 },
          commands: [{ name: "notifyEscalation" }],
        },
      },
    },

    changes_requested: {
      context: { status: "changes_requested" },
      events: {
        Resubmit: {
          targetState: "review_pending",
          commands: [{ name: "incrementRevision" }, { name: "notifyReviewers" }],
        },
        Withdraw: {
          targetState: "withdrawn",
        },
      },
    },

    // Escalated: requires a manager/admin to force a decision
    escalated: {
      context: { status: "escalated" },
      events: {
        ForceApprove: {
          targetState: "approved",
          commands: [{ name: "recordApproval" }],
        },
        ForceReject: {
          targetState: "rejected",
          commands: [{ name: "recordRejection" }],
        },
        // Allow sending back to review with a new deadline
        SendBackToReview: {
          targetState: "review_pending",
          commands: [{ name: "notifyReviewers" }],
        },
      },
    },

    approved: {
      context: { status: "approved" },
      events: {
        Publish: {
          targetState: "published",
          commands: [{ name: "publishDocument" }],
        },
      },
    },

    // Terminal states
    published: {
      context: { status: "published" },
    },

    rejected: {
      context: { status: "rejected" },
    },

    withdrawn: {
      context: { status: "withdrawn" },
    },
  },
};

// ---------------------------------------------------------------------------
// 2. Example Command Implementations
// ---------------------------------------------------------------------------

export class NotifyReviewersCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const documentId = ctx.metadata.documentId as string;
    const reviewers = ctx.context.reviewers as string[];

    try {
      // await notificationService.notifyAll(reviewers, {
      //   type: "review_requested",
      //   documentId,
      // });

      ctx.context.lastNotifiedAt = ctx.now.toISOString();
      return { ok: true, code: "REVIEWERS_NOTIFIED" };
    } catch (err) {
      // Notification failure shouldn't block the workflow
      return { ok: true, code: "NOTIFICATION_SKIPPED", message: String(err) };
    }
  }
}

export class RecordApprovalCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    // triggerMetadata carries who triggered the event
    const approver = ctx.triggerMetadata.actor as string | undefined;

    ctx.context.approvedBy = approver ?? "unknown";
    ctx.context.approvedAt = ctx.now.toISOString();

    return { ok: true, code: "APPROVAL_RECORDED" };
  }
}

export class RecordRejectionCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const rejector = ctx.triggerMetadata.actor as string | undefined;
    const reason = ctx.triggerMetadata.reason as string | undefined;

    ctx.context.rejectedBy = rejector ?? "unknown";
    ctx.context.rejectedAt = ctx.now.toISOString();
    ctx.context.rejectionReason = reason ?? "No reason provided";

    return { ok: true, code: "REJECTION_RECORDED" };
  }
}

export class IncrementRevisionCommand implements WorkflowCommand {
  execute(_subject: unknown, ctx: WorkflowExecutionContext): CommandResult {
    const count = (ctx.context.revisionCount as number) ?? 0;
    ctx.context.revisionCount = count + 1;
    ctx.context.lastRevisedAt = ctx.now.toISOString();

    return { ok: true, code: "REVISION_INCREMENTED" };
  }
}

export class NotifyEscalationCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const documentId = ctx.metadata.documentId as string;

    try {
      // await notificationService.notifyManagers({
      //   type: "review_escalated",
      //   documentId,
      //   message: "Review pending for over 48 hours",
      // });

      ctx.context.escalatedAt = ctx.now.toISOString();
      return { ok: true, code: "ESCALATION_NOTIFIED" };
    } catch (err) {
      return { ok: true, code: "ESCALATION_NOTIFICATION_SKIPPED", message: String(err) };
    }
  }
}

export class PublishDocumentCommand implements WorkflowCommand {
  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const documentId = ctx.metadata.documentId as string;

    try {
      // await publishingService.publish(documentId);
      ctx.context.publishedAt = ctx.now.toISOString();
      return { ok: true, code: "PUBLISHED" };
    } catch (err) {
      return { ok: false, code: "PUBLISH_FAILED", message: String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Usage Example
// ---------------------------------------------------------------------------

/*
const instance = await runtime.createInstance({
  workflowName: "document-approval",
  metadata: { documentId: "DOC-042", authorId: "USER-001" },
  context: { reviewers: ["reviewer-a@example.com", "reviewer-b@example.com"] },
});

const handle = runtime.getHandle(instance.uuid);

// Author submits for review
await handle.triggerEvent("Submit");

// Reviewer approves (track who via triggerMetadata)
await handle.triggerEvent("Approve", {
  triggerMetadata: { actor: "reviewer-a@example.com" },
});

// Or reviewer rejects with reason
await handle.triggerEvent("Reject", {
  triggerMetadata: { actor: "reviewer-b@example.com", reason: "Needs more detail in section 3" },
});

// After rejection, author resubmits
await handle.triggerEvent("Resubmit");

// If no one acts within 48 hours, the timeout poller triggers Escalate automatically.
// A manager can then force a decision:
await handle.triggerEvent("ForceApprove", {
  triggerMetadata: { actor: "manager@example.com" },
});

// Finally publish
await handle.triggerEvent("Publish");
*/
