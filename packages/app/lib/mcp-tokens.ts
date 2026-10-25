import { randomBytes, randomUUID } from "node:crypto";
import { getPool } from "@/lib/db";

const TOKEN_PREFIX = "mcpk_live_";
const PREFIX_DISPLAY_LEN = 16;

export const generateMcpToken = (): string =>
  `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;

export type IssuedToken = {
  id: string;
  token: string;
  tokenPrefix: string;
};

export const issueTokenForAgent = async (
  agentId: string,
  ownerId?: string,
): Promise<IssuedToken> => {
  const pool = await getPool();
  const id = randomUUID();
  const token = generateMcpToken();
  const tokenPrefix = token.slice(0, PREFIX_DISPLAY_LEN);
  const inserted = await pool.query(
    `INSERT INTO mcp_api_key (id, agent_id, token, token_prefix,owner_id,instance_id) SELECT $1,agent_id,$3,$4,user_id,instance_id FROM agent_ownership WHERE agent_id=$2 AND ($5::text IS NULL OR user_id=$5)`,
    [id, agentId, token, tokenPrefix, ownerId ?? null],
  );
  if (!inserted.rowCount) throw new Error("Agent ownership changed");
  return { id, token, tokenPrefix };
};

export const getActiveTokenForAgent = async (
  agentId: string,
): Promise<string | null> => {
  const pool = await getPool();
  const { rows } = await pool.query<{ token: string }>(
    `SELECT k.token
       FROM mcp_api_key k JOIN agent_ownership a ON a.agent_id=k.agent_id AND a.user_id=k.owner_id AND a.instance_id=k.instance_id
      WHERE k.agent_id = $1
        AND k.revoked_at IS NULL
      ORDER BY k.created_at DESC
      LIMIT 1`,
    [agentId],
  );
  return rows[0]?.token ?? null;
};

export const revokeAllTokensForAgent = async (
  agentId: string,
): Promise<number> => {
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE mcp_api_key
        SET revoked_at = now()
      WHERE agent_id = $1
        AND revoked_at IS NULL`,
    [agentId],
  );
  return result.rowCount ?? 0;
};

export const rotateTokenForAgent = async (
  agentId: string,
  ownerId: string,
): Promise<IssuedToken> => {
  const pool = await getPool(),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT agent_id FROM agent_ownership WHERE agent_id=$1 AND user_id=$2 FOR UPDATE",
      [agentId, ownerId],
    );
    const id = randomUUID(),
      token = generateMcpToken(),
      tokenPrefix = token.slice(0, PREFIX_DISPLAY_LEN);
    await client.query(
      "UPDATE mcp_api_key SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL",
      [agentId],
    );
    const inserted = await client.query(
      "INSERT INTO mcp_api_key(id,agent_id,token,token_prefix,owner_id,instance_id) SELECT $1,agent_id,$3,$4,user_id,instance_id FROM agent_ownership WHERE agent_id=$2 AND user_id=$5",
      [id, agentId, token, tokenPrefix, ownerId],
    );
    if (!inserted.rowCount) throw new Error("Agent ownership changed");
    await client.query("COMMIT");
    return { id, token, tokenPrefix };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};
