ALTER TABLE IF EXISTS agent_ownership ADD COLUMN IF NOT EXISTS instance_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE IF EXISTS agent_ownership ADD COLUMN IF NOT EXISTS stellar_policy_revision integer NOT NULL DEFAULT 0;
ALTER TABLE stellar_write_attempts ADD COLUMN signed_sequence numeric(30,0);
ALTER TABLE stellar_write_attempts ADD COLUMN signed_max_time numeric(30,0);
CREATE TABLE stellar_contract_owners(owner_id text NOT NULL,network text NOT NULL,contract_id text NOT NULL,PRIMARY KEY(owner_id,network,contract_id));
CREATE TABLE stellar_wallets(
 id uuid PRIMARY KEY, agent_id text NOT NULL, instance_id uuid NOT NULL, owner_id text NOT NULL,
 network text NOT NULL CHECK(network='testnet'), mode text NOT NULL CHECK(mode IN ('freighter','managed')),
 address text NOT NULL, active boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 encrypted_key jsonb, key_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(agent_id,instance_id,network,mode)
);
CREATE UNIQUE INDEX stellar_active_wallet ON stellar_wallets(agent_id,instance_id,network) WHERE active;
CREATE TABLE stellar_wallet_challenges(id uuid PRIMARY KEY,agent_id text NOT NULL,instance_id uuid NOT NULL,owner_id text NOT NULL,address text NOT NULL,message text NOT NULL,expires_at timestamptz NOT NULL,used boolean NOT NULL DEFAULT false);
CREATE TABLE stellar_tool_policies(
 agent_id text NOT NULL,instance_id uuid NOT NULL,owner_id text NOT NULL,network text NOT NULL CHECK(network='testnet'),
 contract_id text NOT NULL,function_name text NOT NULL,mode text NOT NULL CHECK(mode IN ('READ','WRITE')),
 revision integer NOT NULL DEFAULT 1,limits jsonb,PRIMARY KEY(agent_id,instance_id,network,contract_id,function_name)
);
CREATE TABLE stellar_operations(
 id uuid PRIMARY KEY,agent_id text NOT NULL,instance_id uuid NOT NULL,owner_id text NOT NULL,credential_id text NOT NULL,
 network text NOT NULL CHECK(network='testnet'),contract_id text NOT NULL,function_name text NOT NULL,
 interface_hash text NOT NULL,function_model jsonb NOT NULL,arguments jsonb NOT NULL,request_fingerprint text NOT NULL,
 idempotency_key text NOT NULL,wallet_id uuid NOT NULL REFERENCES stellar_wallets(id),wallet_revision integer NOT NULL,policy_revision integer NOT NULL,
 state text NOT NULL,result jsonb,lease_owner uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(agent_id,instance_id,network,idempotency_key)
);
CREATE TABLE stellar_spending(
 operation_id uuid PRIMARY KEY REFERENCES stellar_operations(id),agent_id text NOT NULL,instance_id uuid NOT NULL,wallet_id uuid NOT NULL,
 contract_id text NOT NULL,amount numeric(78,0) NOT NULL,fee numeric(78,0) NOT NULL,
 state text NOT NULL CHECK(state IN ('RESERVED','SETTLED','RELEASED')),settled_at timestamptz
);
CREATE TABLE stellar_local_agents(id text PRIMARY KEY,name text NOT NULL,description text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
