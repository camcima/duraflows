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

ALTER TABLE workflow_history
  DROP CONSTRAINT IF EXISTS workflow_history_outcome_check;

ALTER TABLE workflow_history
  ADD CONSTRAINT workflow_history_outcome_check
  CHECK (outcome IN ('success', 'failure'));

ALTER TABLE workflow_history
  DROP COLUMN IF EXISTS rejected_by;
