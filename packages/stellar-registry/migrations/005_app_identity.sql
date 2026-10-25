ALTER TABLE IF EXISTS mcp_api_key ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE IF EXISTS mcp_api_key ADD COLUMN IF NOT EXISTS instance_id uuid;
CREATE OR REPLACE FUNCTION stellar_rotate_agent_instance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
   NEW.instance_id=gen_random_uuid();
   NEW.stellar_policy_revision=0;
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF to_regclass('agent_ownership') IS NOT NULL THEN
  CREATE OR REPLACE TRIGGER stellar_owner_instance BEFORE UPDATE OF user_id ON agent_ownership FOR EACH ROW EXECUTE FUNCTION stellar_rotate_agent_instance();
 END IF;
 IF to_regclass('agent_ownership') IS NOT NULL AND to_regclass('mcp_api_key') IS NOT NULL THEN
  UPDATE mcp_api_key k SET owner_id=a.user_id,instance_id=a.instance_id FROM agent_ownership a WHERE k.agent_id=a.agent_id AND k.owner_id IS NULL AND k.instance_id IS NULL;
 END IF;
END $$;
