import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { rpc } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../dist/src/config.js";
import { Store } from "../dist/src/store.js";
import { ingest } from "../dist/src/ingestion.js";
import { Executor } from "../dist/src/executor.js";
import { environmentSigner } from "../dist/src/signer.js";
import { httpServer } from "../dist/src/gateway.js";
async function main() {
  const env = Object.fromEntries(
    (await readFile(new URL("../.env.demo", import.meta.url), "utf8"))
      .trim()
      .split("\n")
      .map((s) => {
        const i = s.indexOf("=");
        return [s.slice(0, i), s.slice(i + 1)];
      }),
  );
  const deployment = JSON.parse(
    await readFile(
      new URL("../demo-contract/deployment.json", import.meta.url),
      "utf8",
    ),
  );
  const policies = [
    "count",
    "authorized",
    "echo_u64",
    "echo_i128",
    "echo_record",
    "echo_vec",
  ].map((fn) => ({
    contractId: deployment.contractId,
    function: fn,
    mode: "READ",
    principals: ["demo"],
  }));
  policies.push({
    contractId: deployment.contractId,
    function: "increment",
    mode: "WRITE",
    principals: ["demo"],
  });
  const config = parseConfig({
    network: "testnet",
    rpcUrl: env.STELLAR_RPC_URL,
    databaseUrl: env.DATABASE_URL,
    simulationSource: env.SIMULATION_SOURCE,
    writeMode: true,
    signerSecret: env.STELLAR_SIGNER_SECRET,
    maxFee: env.MAX_FEE,
    policies,
  });
  const store = new Store(config.databaseUrl);
  const rpcServer = new rpc.Server(config.rpcUrl, { timeout: 15000 });
  const executor = new Executor(
    config,
    rpcServer,
    store,
    environmentSigner(config.signerSecret, config.networkPassphrase),
  );
  const client = new Client({ name: "orloj-demo", version: "1.0.0" });
  let http;
  const started = Date.now();
  const events = [];
  const evidence = {
    recordedAt: new Date().toISOString(),
    deployment,
    checks: [],
  };
  function record(name, value) {
    const line = JSON.stringify({ check: name, ...value });
    console.log(line);
    events.push([(Date.now() - started) / 1000, "o", line + "\r\n"]);
    evidence.checks.push({ check: name, ...value });
  }
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  try {
    await store.migrate();
    const net = await rpcServer.getNetwork();
    assert(net.passphrase === config.networkPassphrase, "Network mismatch");
    const i = await ingest(rpcServer, config, deployment.contractId);
    await store.save(i);
    record("ingest", {
      ok: true,
      functions: i.functions.map((f) => f.sorobanName),
      excluded: i.excluded,
    });
    const token = randomBytes(32).toString("base64url");
    await store.credential(token, "demo");
    http = httpServer(executor);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const url = new URL(
      `http://127.0.0.1:${http.address().port}/contracts/${i.contractId}/mcp`,
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const listed = await client.listTools();
    assert(
      listed.tools.some((t) => t.name === "increment"),
      "Missing write tool",
    );
    record("mcp_discovery", {
      ok: true,
      tools: listed.tools.map((t) => t.name),
    });
    async function call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      return r.structuredContent ?? JSON.parse(r.content[0].text);
    }
    const before = await call("count", {});
    assert(before.ok && before.result_status === "SIMULATED", "Read failed");
    record("read_before", before);
    const large = await call("echo_u64", { v: "18446744073709551615" });
    assert(
      large.ok && large.data === "18446744073709551615",
      "u64 precision failed",
    );
    record("u64_max", large);
    const auth = await call("authorized", { user: config.simulationSource });
    assert(
      auth.error_code === "AUTHORIZATION_REQUIRED",
      "Auth read rejection failed",
    );
    record("auth_required", auth);
    const key = randomUUID();
    const write = await call("increment", { idempotency_key: key });
    record("confirmed_write", write);
    assert(
      write.ok && write.result_status === "SUBMITTED_AND_CONFIRMED",
      "Write confirmation failed",
    );
    const duplicate = await call("increment", { idempotency_key: key });
    assert(
      duplicate.ok && duplicate.transaction_hash === write.transaction_hash,
      "Duplicate reconciliation failed",
    );
    record("duplicate_write", duplicate);
    const after = await call("count", {});
    assert(
      after.ok && after.data === before.data + 1,
      "Counter changed unexpectedly",
    );
    record("read_after", after);
    await store.revoke(token);
    await writeFile(
      new URL("../demo-contract/evidence.json", import.meta.url),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    await writeFile(
      new URL("../demo-contract/fallback.cast", import.meta.url),
      [
        JSON.stringify({
          version: 2,
          width: 140,
          height: 32,
          timestamp: Math.floor(started / 1000),
          title: "Orloj Stellar — recorded testnet MCP demo",
        }),
        ...events.map((e) => JSON.stringify(e)),
      ].join("\n") + "\n",
    );
  } finally {
    await client.close();
    if (http) await new Promise((r) => http.close(r));
    await store.close();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ ok: false, error_code: "DEMO_FAILED" }));
  process.exitCode = 1;
});
