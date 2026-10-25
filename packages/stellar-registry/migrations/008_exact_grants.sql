ALTER TABLE stellar_operations ADD COLUMN fee_limit numeric(78,0);
ALTER TABLE stellar_tool_policies ADD COLUMN exact_grant jsonb;
CREATE TABLE stellar_call_reservations (
 operation_id uuid PRIMARY KEY REFERENCES stellar_operations(id),
 wallet_id uuid NOT NULL REFERENCES stellar_wallets(id),
 contract_id text NOT NULL, function_name text NOT NULL, policy_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stellar_call_budget ON stellar_call_reservations(wallet_id,contract_id,function_name);
