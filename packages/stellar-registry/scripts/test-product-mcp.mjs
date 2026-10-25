import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const agentId = process.argv[2],
  recipient = process.argv[3],
  mode = process.argv[4] ?? "freighter";
const id = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const assert = (v) => {
  if (!v) throw new Error("Product MCP acceptance assertion failed");
};
async function main() {
  assert(agentId && recipient && ["freighter", "managed"].includes(mode));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const evidence = {
    testedAt: new Date().toISOString(),
    network: "testnet",
    agentId,
    mode,
    checks: [],
  };
  const client = new Client({
    name: "orloj-local-product-acceptance",
    version: "1.0.0",
  });
  try {
    const row = (
      await pool.query(
        "SELECT k.token,w.address FROM mcp_api_key k JOIN agent_ownership a ON a.agent_id=k.agent_id AND a.instance_id=k.instance_id AND a.user_id=k.owner_id JOIN stellar_wallets w ON w.agent_id=a.agent_id AND w.instance_id=a.instance_id AND w.owner_id=a.user_id AND w.active WHERE k.agent_id=$1 AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 1",
        [agentId],
      )
    ).rows[0];
    assert(row);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:3002/contracts/${id}/mcp`),
        { requestInit: { headers: { authorization: "Bearer " + row.token } } },
      ),
    );
    const record = (check, r) => {
      evidence.checks.push({ check, ...r });
      console.log(JSON.stringify(evidence.checks.at(-1)));
    };
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return r.structuredContent ?? JSON.parse(r.content[0].text);
    };
    const tools = await client.listTools();
    assert(tools.tools.some((t) => t.name === "transfer"));
    record("actual_app_token_discovery", {
      ok: true,
      tools: tools.tools.map((t) => t.name),
    });
    const before = await call("balance", { addr: recipient });
    record("recipient_before", before);
    assert(before.ok);
    if (mode === "managed") {
      const denied = await call("transfer", {
        from: row.address,
        to_mux: row.address,
        amount: "1",
        idempotency_key: randomUUID(),
      });
      assert(denied.error_code === "WRITE_NOT_PERMITTED");
      record("recipient_policy_denial", denied);
      const tooMuch = await call("transfer", {
        from: row.address,
        to_mux: recipient,
        amount: "1000000000000000",
        idempotency_key: randomUUID(),
      });
      assert(tooMuch.error_code === "WRITE_NOT_PERMITTED");
      record("amount_policy_denial", tooMuch);
    }
    const key = randomUUID(),
      args = {
        from: row.address,
        to_mux: recipient,
        amount: "1",
        idempotency_key: key,
      };
    const queued = await call("transfer", args);
    record("queued_write", queued);
    assert(queued.ok && queued.operation_id);
    let result = queued;
    for (let n = 0; n < 240; n++) {
      result = await call("orloj_operation_status", {
        operation_id: queued.operation_id,
      });
      if (result.result_status === "SUBMITTED_AND_CONFIRMED") break;
      if (result.ok === false) {
        record("terminal_error", result);
        throw new Error("Product write did not confirm");
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    record("confirmed_write", result);
    assert(result.ok && result.result_status === "SUBMITTED_AND_CONFIRMED");
    const duplicate = await call("transfer", args);
    record("duplicate_reconciled", duplicate);
    assert(
      duplicate.operation_id === queued.operation_id &&
        duplicate.transaction_hash === result.transaction_hash,
    );
    const after = await call("balance", { addr: recipient });
    record("recipient_after", after);
    assert(after.ok && BigInt(after.data) === BigInt(before.data) + 1n);
    evidence.ok = true;
  } finally {
    await client.close();
    await pool.end();
    await writeFile(
      new URL(
        `../demo-contract/local-product-${mode}-evidence.json`,
        import.meta.url,
      ),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
}
main().catch(() => {
  console.error('{"ok":false,"error_code":"PRODUCT_ACCEPTANCE_FAILED"}');
  process.exitCode = 1;
});
