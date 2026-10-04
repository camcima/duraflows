-- Optional: required only for providers configured with idempotency: true.
-- migrate:up
CREATE TABLE workflow_event_idempotency (
  workflow_instance_uuid uuid NOT NULL REFERENCES workflow_instances(uuid) ON DELETE CASCADE,
  idempotency_key text COLLATE "C" NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  event_name text NOT NULL,
  fingerprint text COLLATE "C" NULL CHECK (fingerprint IS NULL OR octet_length(fingerprint) BETWEEN 1 AND 256),
  result_json jsonb NULL CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_instance_uuid, idempotency_key)
);

-- migrate:down
DROP TABLE IF EXISTS workflow_event_idempotency;
