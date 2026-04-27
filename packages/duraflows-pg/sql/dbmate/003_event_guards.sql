-- migrate:up
--
-- Allow workflow_history.outcome = 'guard-rejected' and persist rejected_by.

ALTER TABLE workflow_history
  DROP CONSTRAINT IF EXISTS workflow_history_outcome_check;

ALTER TABLE workflow_history
  ADD CONSTRAINT workflow_history_outcome_check
  CHECK (outcome IN ('success', 'failure', 'guard-rejected'));

ALTER TABLE workflow_history
  ADD COLUMN IF NOT EXISTS rejected_by text;

-- migrate:down
--
-- WARNING: this down-step will fail if any rows in workflow_history have
-- outcome = 'guard-rejected'. The new CHECK constraint forbids that value, and
-- PostgreSQL validates the constraint against existing rows before applying
-- it. Before running this rollback, either delete or re-label any
-- 'guard-rejected' rows (e.g., DELETE FROM workflow_history WHERE outcome =
-- 'guard-rejected'). Note that doing so loses audit history of guard
-- rejections.

ALTER TABLE workflow_history
  DROP CONSTRAINT IF EXISTS workflow_history_outcome_check;

ALTER TABLE workflow_history
  ADD CONSTRAINT workflow_history_outcome_check
  CHECK (outcome IN ('success', 'failure'));

ALTER TABLE workflow_history
  DROP COLUMN IF EXISTS rejected_by;
