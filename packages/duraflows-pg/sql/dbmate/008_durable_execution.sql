-- Optional: required for providers configured with durableExecution: true.
-- migrate:up
CREATE TABLE workflow_executions (
  uuid uuid PRIMARY KEY,
  workflow_instance_uuid uuid NOT NULL REFERENCES workflow_instances(uuid) ON DELETE CASCADE,
  idempotency_key text COLLATE "C" NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status IN ('pending','running','parked','completed','cancelled')),
  available_at timestamptz NOT NULL,
  lease_until timestamptz NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  execution_json jsonb NOT NULL CHECK (jsonb_typeof(execution_json) = 'object'),
  UNIQUE (workflow_instance_uuid, idempotency_key)
);
CREATE UNIQUE INDEX workflow_executions_active_idx ON workflow_executions (workflow_instance_uuid)
  WHERE status IN ('pending','running','parked');
CREATE INDEX workflow_executions_due_idx ON workflow_executions (available_at, uuid)
  WHERE status IN ('pending','running');

-- migrate:down
DROP TABLE IF EXISTS workflow_executions;
