import { randomUUID } from "node:crypto";
import { getOneclawClient } from "./oneclaw";
import { getPool } from "./db";
export async function getAgentClient(): ReturnType<typeof getOneclawClient> {
  if (process.env.AGENT_PROVIDER !== "local") return getOneclawClient();
  const pool = await getPool();
  const client = {
    agents: {
      list: async () => ({
        data: {
          agents: (
            await pool.query(
              "SELECT * FROM stellar_local_agents ORDER BY created_at DESC",
            )
          ).rows,
        },
        error: null,
      }),
      create: async (input: {
        name: string;
        description?: string;
        scopes?: string[];
      }) => {
        const r = await pool.query(
          "INSERT INTO stellar_local_agents(id,name,description) VALUES($1,$2,$3) RETURNING *",
          [randomUUID(), input.name, input.description ?? ""],
        );
        return { data: { agent: r.rows[0] }, error: null };
      },
      get: async (id: string) => ({
        data:
          (
            await pool.query("SELECT * FROM stellar_local_agents WHERE id=$1", [
              id,
            ])
          ).rows[0] ?? null,
        error: null,
      }),
      delete: async (id: string) => {
        await pool.query("DELETE FROM stellar_local_agents WHERE id=$1", [id]);
        return { data: {}, error: null };
      },
    },
  };
  return client as unknown as Awaited<ReturnType<typeof getOneclawClient>>;
}
