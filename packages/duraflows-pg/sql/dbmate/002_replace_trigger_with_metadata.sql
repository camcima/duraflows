-- migrate:up
ALTER TABLE workflow_history ADD COLUMN trigger_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE workflow_history SET trigger_metadata_json = jsonb_build_object('type', triggered_by_type, 'actorUuid', triggered_by_uuid) WHERE triggered_by_type IS NOT NULL;
ALTER TABLE workflow_history DROP COLUMN triggered_by_type;
ALTER TABLE workflow_history DROP COLUMN triggered_by_uuid;

-- migrate:down
ALTER TABLE workflow_history ADD COLUMN triggered_by_type text;
ALTER TABLE workflow_history ADD COLUMN triggered_by_uuid uuid NULL;
UPDATE workflow_history SET triggered_by_type = trigger_metadata_json->>'type', triggered_by_uuid = (trigger_metadata_json->>'actorUuid')::uuid WHERE trigger_metadata_json != '{}'::jsonb;
ALTER TABLE workflow_history DROP COLUMN trigger_metadata_json;
