CREATE TABLE IF NOT EXISTS stellar_interfaces (
 network text NOT NULL, contract_id text NOT NULL, wasm_hash text NOT NULL,
 interface jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(network,contract_id,wasm_hash)
);
CREATE TABLE IF NOT EXISTS stellar_credentials (
 token_hash text PRIMARY KEY, principal text NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS stellar_write_attempts (
 id uuid PRIMARY KEY, principal text NOT NULL, network text NOT NULL, idempotency_key text NOT NULL,
 fingerprint text NOT NULL, source_account text NOT NULL, request jsonb NOT NULL,
 state text NOT NULL, transaction_hash text, response jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(principal,network,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS stellar_account_reservation ON stellar_write_attempts(network,source_account)
 WHERE state IN ('PREPARING','INTENT','PENDING','TIMEOUT');
