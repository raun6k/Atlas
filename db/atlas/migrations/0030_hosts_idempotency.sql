-- Kernel 0030: approved hosts, keys, replay nonces, idempotency.

CREATE TABLE approved_hosts (
    host_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
    credential_salt BYTEA NOT NULL,
    credential_hash BYTEA NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT ARRAY['mcp']::TEXT[],
    environment TEXT NOT NULL DEFAULT 'test',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE host_keys (
    host_id TEXT NOT NULL REFERENCES approved_hosts (host_id),
    key_id TEXT NOT NULL,
    algorithm TEXT NOT NULL CHECK (algorithm = 'ES256'),
    public_jwk JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, key_id)
);

CREATE TABLE replay_nonces (
    host_id TEXT NOT NULL REFERENCES approved_hosts (host_id),
    nonce TEXT NOT NULL,
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (host_id, nonce)
);

CREATE TABLE idempotency_records (
    host_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response_status TEXT NOT NULL,
    response_body JSONB NOT NULL,
    resource_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
    original_audit_event_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, scope, idempotency_key)
);

CREATE TABLE operator_credentials (
    operator_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    credential_salt BYTEA NOT NULL,
    credential_hash BYTEA NOT NULL,
    scopes TEXT[] NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')) DEFAULT 'ACTIVE'
);

CREATE TABLE fixture_control_credentials (
    credential_id TEXT PRIMARY KEY,
    credential_salt BYTEA NOT NULL,
    credential_hash BYTEA NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')) DEFAULT 'ACTIVE'
);

CREATE TABLE fixture_state (
    singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'current'),
    fixture_snapshot_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
