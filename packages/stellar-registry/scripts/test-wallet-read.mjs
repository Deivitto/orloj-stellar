import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { rpc } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../dist/src/config.js";
import { Store } from "../dist/src/store.js";
import { ingest } from "../dist/src/ingestion.js";
import { Executor } from "../dist/src/executor.js";
import { httpServer } from "../dist/src/gateway.js";
async function main() {
  const address = process.argv[2];
  if (!address) throw new Error("Public address required");
  const deployment = JSON.parse(
    await readFile(
      new URL("../demo-contract/deployment.json", import.meta.url),
      "utf8",
    ),
  );
  const local = await readFile(
    new URL("../.env.demo", import.meta.url),
    "utf8",
  );
  const databaseUrl =
    process.env.DATABASE_URL ?? /^DATABASE_URL=(.+)$/m.exec(local)?.[1];
  const config = parseConfig({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    databaseUrl,
    simulationSource: address,
    writeMode: false,
    policies: ["count", "echo_address", "authorized"].map((fn) => ({
      contractId: deployment.contractId,
      function: fn,
      mode: "READ",
      principals: ["wallet-read-test"],
    })),
  });
  const store = new Store(config.databaseUrl),
    server = new rpc.Server(config.rpcUrl, { timeout: 10000 });
  const executor = new Executor(config, server, store);
  const client = new Client({
    name: "orloj-wallet-read-test",
    version: "1.0.0",
  });
  let http;
  const token = randomBytes(32).toString("base64url");
  const evidence = {
    testedAt: new Date().toISOString(),
    network: "testnet",
    wallet: address,
    contractId: deployment.contractId,
    checks: [],
  };
  function record(check, result) {
    evidence.checks.push({ check, ...result });
    console.log(JSON.stringify({ check, ...result }));
  }
  function assert(x) {
    if (!x) throw new Error("Wallet test failed");
  }
  try {
    const net = await server.getNetwork();
    assert(net.passphrase === config.networkPassphrase);
    await server.getAccount(address);
    const accountResponse = await fetch(
      `https://horizon-testnet.stellar.org/accounts/${address}`,
    );
    assert(accountResponse.ok);
    const account = await accountResponse.json();
    record("wallet_assets", {
      ok: true,
      balances: account.balances.map((b) => ({
        asset: b.asset_type === "native" ? "XLM" : b.asset_code,
        issuer: b.asset_issuer,
        balance: b.balance,
      })),
    });
    await store.migrate();
    const i = await ingest(server, config, deployment.contractId);
    await store.save(i);
    await store.credential(token, "wallet-read-test");
    http = httpServer(executor);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const endpoint = `http://127.0.0.1:${http.address().port}/contracts/${i.contractId}/mcp`;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const tools = await client.listTools();
    assert(tools.tools.every((t) => t.name !== "increment"));
    record("mcp_discovery", {
      ok: true,
      tools: tools.tools.map((t) => t.name),
      simulation_source: address,
    });
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return r.structuredContent ?? JSON.parse(r.content[0].text);
    };
    const count = await call("count", {});
    assert(count.ok && count.result_status === "SIMULATED");
    record("contract_read", count);
    const echo = await call("echo_address", { v: address });
    assert(echo.ok && echo.data === address);
    record("wallet_address_round_trip", echo);
    const auth = await call("authorized", { user: address });
    assert(auth.error_code === "AUTHORIZATION_REQUIRED");
    record("authorization_guard", auth);
    record("signing_boundary", {
      ok: true,
      signer_configured: false,
      transactions_submitted: 0,
    });
    await writeFile(
      new URL("../demo-contract/wallet-read-evidence.json", import.meta.url),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  } finally {
    await client.close();
    if (http) await new Promise((r) => http.close(r));
    await store.revoke(token);
    await store.close();
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({ ok: false, error_code: "WALLET_READ_TEST_FAILED" }),
  );
  process.exitCode = 1;
});
