-- migrate:up
--
-- Idempotent migration from the legacy triggered_by_* columns to trigger_metadata_json.
--
-- Fresh installs: 001 already creates trigger_metadata_json. The DO block body only
-- runs when the legacy columns exist, so this migration is a no-op on fresh schemas.
--
-- Legacy installs: schemas created against a prior 001 still have triggered_by_type /
-- triggered_by_uuid. The body adds trigger_metadata_json, backfills from the legacy
-- columns, and drops them.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_history' AND column_name = 'triggered_by_type'
  ) THEN
    ALTER TABLE workflow_history ADD COLUMN IF NOT EXISTS trigger_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;
    UPDATE workflow_history SET trigger_metadata_json = jsonb_build_object('type', triggered_by_type, 'actorUuid', triggered_by_uuid) WHERE triggered_by_type IS NOT NULL;
    ALTER TABLE workflow_history DROP COLUMN IF EXISTS triggered_by_type;
    ALTER TABLE workflow_history DROP COLUMN IF EXISTS triggered_by_uuid;
  END IF;
END $$;

-- migrate:down
--
-- Reverse migration: add the legacy columns back, backfill from trigger_metadata_json,
-- then drop trigger_metadata_json. Safe to run from either the fresh or legacy state.

ALTER TABLE workflow_history ADD COLUMN IF NOT EXISTS triggered_by_type text;
ALTER TABLE workflow_history ADD COLUMN IF NOT EXISTS triggered_by_uuid uuid NULL;
UPDATE workflow_history SET triggered_by_type = trigger_metadata_json->>'type', triggered_by_uuid = (trigger_metadata_json->>'actorUuid')::uuid WHERE trigger_metadata_json != '{}'::jsonb;
ALTER TABLE workflow_history DROP COLUMN IF EXISTS trigger_metadata_json;
