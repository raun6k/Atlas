-- Kernel 0060: merchant audit trail, exports, jobs, outbox. Append-only audit via grants.

CREATE TABLE audit_events (
    audit_event_id TEXT PRIMARY KEY,
    record_sequence BIGSERIAL UNIQUE NOT NULL,
    event_kind TEXT NOT NULL CHECK (event_kind IN (
        'BOUNDARY_COMMAND_EVALUATED',
        'COMMERCIAL_REPRESENTATION_ISSUED',
        'COMMERCIAL_DECISION_RECORDED',
        'PROVIDER_EVIDENCE_EVALUATED',
        'ASYNC_DECISION_APPLIED',
        'AUDIT_CORRECTION_RECORDED'
    )),
    schema_version INT NOT NULL DEFAULT 1,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_occurred_at TIMESTAMPTZ,
    environment TEXT NOT NULL DEFAULT 'test',
    request_id TEXT,
    operation_id TEXT,
    caused_by_event_id TEXT,
    supersedes_event_id TEXT,
    initiating_principal_type TEXT NOT NULL,
    initiating_principal_id TEXT,
    executing_component TEXT NOT NULL DEFAULT 'core',
    boundary_type TEXT,
    source_channel TEXT,
    contract_version TEXT,
    action TEXT,
    primary_resource_type TEXT,
    primary_resource_id TEXT,
    primary_resource_version BIGINT,
    event_body JSONB NOT NULL,
    event_body_digest TEXT NOT NULL,
    redaction_policy_revision TEXT NOT NULL DEFAULT 'rp_v1',
    retention_class TEXT NOT NULL CHECK (retention_class IN ('effects_365d', 'representations_90d')),
    attention_code TEXT,
    summary_sentence TEXT
);

CREATE INDEX audit_events_operation_idx ON audit_events (operation_id, record_sequence);
CREATE INDEX audit_events_resource_idx ON audit_events (primary_resource_type, primary_resource_id, record_sequence DESC);
CREATE INDEX audit_events_request_idx ON audit_events (request_id);
CREATE INDEX audit_events_kind_time_idx ON audit_events (event_kind, occurred_at DESC);

CREATE TABLE audit_exports (
    export_id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('CSV_SUMMARY', 'JSON_SAFE_DETAIL')),
    filter_digest TEXT NOT NULL,
    filter_json JSONB NOT NULL,
    projection TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('REQUESTED', 'GENERATING', 'READY', 'EXPIRED', 'FAILED')),
    maximum_record_sequence BIGINT,
    artifact_path TEXT,
    artifact_digest TEXT,
    byte_size BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    operation_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED')),
    dedupe_key TEXT UNIQUE,
    attempt_count INT NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (status, available_at, job_type);

CREATE TABLE outbox_events (
    outbox_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
