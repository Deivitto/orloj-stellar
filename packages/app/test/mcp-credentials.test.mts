import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
// Tests run on pinned Node 24; the app retains its existing Node 20 type package.
const { registerHooks } = nodeModule as unknown as {
  registerHooks(hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      next: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }): { deregister(): void };
};
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
const database = process.env.TEST_DATABASE_URL;
test(
  "real app credential rotation fences old tokens, failed owners and ownership changes",
  { skip: !database },
  async () => {
    const schema = "app_credentials_" + randomUUID().replaceAll("-", ""),
      base = new Pool({ connectionString: database });
    await base.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(database!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = scoped.toString();
    process.env.DATABASE_SSL = "false";
    process.env.STELLAR_REGISTRY_URL = "http://registry.invalid";
    process.chdir(fileURLToPath(new URL("..", import.meta.url)));
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === "@/lib/db")
          return {
            url: new URL("../lib/db.ts", import.meta.url).href,
            shortCircuit: true,
          };
        return next(specifier, context);
      },
    });
    const setup = new Pool({ connectionString: scoped.toString() });
    let pool: Pool | undefined;
    try {
      await setup.query('CREATE TABLE "user"(id text PRIMARY KEY)');
      const { getPool } = await import("../lib/db.ts");
      pool = await getPool();
      const {
        issueTokenForAgent,
        getActiveTokenForAgent,
        rotateTokenForAgent,
      } = await import("../lib/mcp-tokens.ts");
      const owner = randomUUID(),
        other = randomUUID(),
        agent = randomUUID();
      await pool.query('INSERT INTO "user" VALUES($1),($2)', [owner, other]);
      await pool.query(
        "INSERT INTO agent_ownership(agent_id,user_id) VALUES($1,$2)",
        [agent, owner],
      );
      const first = await issueTokenForAgent(agent, owner);
      assert.equal(await getActiveTokenForAgent(agent), first.token);
      const rotated = await rotateTokenForAgent(agent, owner);
      assert.notEqual(rotated.token, first.token);
      assert.equal(await getActiveTokenForAgent(agent), rotated.token);
      assert(
        (
          await pool.query("SELECT revoked_at FROM mcp_api_key WHERE id=$1", [
            first.id,
          ])
        ).rows[0].revoked_at,
      );
      await assert.rejects(rotateTokenForAgent(agent, other));
      assert.equal(await getActiveTokenForAgent(agent), rotated.token);
      const instance = (
        await pool.query(
          "SELECT instance_id FROM agent_ownership WHERE agent_id=$1",
          [agent],
        )
      ).rows[0].instance_id;
      await pool.query(
        "UPDATE agent_ownership SET user_id=$2 WHERE agent_id=$1",
        [agent, other],
      );
      assert.notEqual(
        (
          await pool.query(
            "SELECT instance_id FROM agent_ownership WHERE agent_id=$1",
            [agent],
          )
        ).rows[0].instance_id,
        instance,
      );
      assert.equal(await getActiveTokenForAgent(agent), null);
      await assert.rejects(issueTokenForAgent(agent, owner));
      const next = await issueTokenForAgent(agent, other);
      assert.equal(await getActiveTokenForAgent(agent), next.token);
    } finally {
      hooks.deregister();
      await pool?.end();
      await setup.end();
      await base.query(`DROP SCHEMA ${schema} CASCADE`);
      await base.end();
    }
  },
);
