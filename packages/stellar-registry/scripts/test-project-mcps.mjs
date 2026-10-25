import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { rpc } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../dist/src/config.js";
import { classicInterface } from "../dist/src/classic.js";
import { ingest } from "../dist/src/ingestion.js";
import { Store } from "../dist/src/store.js";
import { Executor } from "../dist/src/executor.js";
import { httpServer } from "../dist/src/gateway.js";
const source = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const discovery = JSON.parse(
  await readFile(
    process.env.AUDIT_DISCOVERY_FILE ??
      new URL(
        "../demo-contract/top10-audit/discovery-mainnet.json",
        import.meta.url,
      ),
    "utf8",
  ),
);
const cases = {
  "Defa By InvoiceMate": [["get_active_tvl", {}], ["get_tvl", {}], ["read_version", {}]],
  "Blend Pools V2": [
    ["reward_zone", {}],
    ["backstop_token", {}],
  ],
  "Stellar DeFi Hub": [
    ["name", {}],
    ["query_asset", {}],
    ["total_assets", {}],
  ],
  "Aquarius Stellar": [
    ["version", {}],
    ["contract_name", {}],
    ["get_tokens_sets_count", {}],
    ["get_pools_for_tokens_range", { start: "0", end: "1" }],
  ],
  Upshift: [
    ["name", {}],
    ["query_asset", {}],
    ["total_assets", {}],
    ["get_strategy_balances", {}],
  ],
  "Gami Labs": [
    ["name", {}],
    ["query_asset", {}],
    ["total_assets", {}],
  ],
  DeFindex: [
    ["name", {}],
    ["decimals", {}],
    ["get_fees", {}],
    ["get_assets", {}],
    ["fetch_total_managed_funds", {}],
    ["quote", { amount_a: "100", reserve_a: "1000", reserve_b: "2000" }],
  ],
  "Templar Protocol": [
    ["asset", {}],
    ["total_assets", {}],
    ["name", {}],
  ],
  "Stellar DEX": [
    ["account_balances", { account: source }],
    ["offers", { account: source, limit: 5 }],
    ["orderbook", { selling: "native", buying: "AQUA:" + source, limit: 5 }],
  ],
  "Stellar AMM": [
    ["liquidity_pool", { pool_id: process.env.AUDIT_MAINNET_POOL_ID ?? "" }],
  ],
  "Sushi Stellar": [
    ["get_owner", {}],
    ["get_pool_wasm_hash", {}],
    ["get_protocol_fee_0", {}],
  ],
};
const policies = discovery.targets.flatMap((t) =>
  (cases[t.project] ?? []).map(([fn]) => ({
    contractId: t.contractId,
    function: fn,
    mode: "READ",
    principals: ["top10-audit"],
  })),
);
const config = parseConfig({
  network: "mainnet",
  rpcUrl: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  databaseUrl: process.env.DATABASE_URL,
  simulationSource: source,
  policies,
  writeMode: false,
  port: 3012,
  rateLimit: 300,
});
const store = new Store(config.databaseUrl),
  server = new rpc.Server(config.rpcUrl, { timeout: 20000 });
let submissions = 0;
server.sendTransaction = async () => {
  submissions++;
  throw Error("Mainnet submission disabled");
};
const token = randomBytes(32).toString("base64url"),
  out = {
    testedAt: new Date().toISOString(),
    network: "mainnet",
    writeMode: false,
    projects: [],
  };
await store.migrate();
await store.credential(token, "top10-audit");
const http = httpServer(new Executor(config, server, store));
http.listen(0, "127.0.0.1");
await once(http, "listening");
try {
  for (const target of discovery.targets) {
    const result = {
      project: target.project,
      contractId: target.contractId,
      source: target.source,
      checks: [],
      excluded: target.interface?.inventory
        .filter((m) => !m.eligible)
        .map((m) => ({
          name: m.name,
          reason: m.error_code ?? m.exclusionReason ?? m.reason,
        })),
    };
    out.projects.push(result);
    const client = new Client({ name: "orloj-project-audit", version: "1.0" });
    try {
      const i = target.contractId.startsWith("classic:")
        ? classicInterface(config, target.contractId)
        : await ingest(server, config, target.contractId);
      await store.save(i);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${http.address().port}/contracts/${i.contractId}/mcp`,
          ),
          { requestInit: { headers: { authorization: "Bearer " + token } } },
        ),
      );
      const tools = await client.listTools();
      result.tools = tools.tools.map((t) => t.name);
      result.eligible = i.inventory.filter((x) => x.eligible).length;
      result.declared = i.inventory.length;
      for (const [name, args] of cases[target.project] ?? []) {
        if (!result.tools.includes(name)) {
          result.checks.push({
            name,
            ok: false,
            reason: "Tool excluded by interface or policy",
          });
          continue;
        }
        const response = await client.callTool({ name, arguments: args });
        const data = response.structuredContent;
        result.checks.push({ name, ...data });
        console.log(
          JSON.stringify({
            project: target.project,
            name,
            ok: data?.ok,
            error_code: data?.error_code,
          }),
        );
      }
    } catch (e) {
      result.error = { name: e.name, message: String(e.message).slice(0, 180) };
      console.log(
        JSON.stringify({ project: target.project, error: result.error }),
      );
    } finally {
      await client.close().catch(() => {});
    }
    await writeFile(
      process.env.AUDIT_OUTPUT_FILE ??
        new URL(
          "../demo-contract/top10-audit/mcp-mainnet-results.json",
          import.meta.url,
        ),
      JSON.stringify({ ...out, submissionAttempts: submissions }, null, 2) +
        "\n",
    );
  }
  if (process.env.AUDIT_EPHEMERAL !== "true") {
  // Persist the read-only operator gateway and private client configuration. No app wallet grants change.
  const env = {
    DATABASE_URL: config.databaseUrl,
    STELLAR_NETWORK: "mainnet",
    STELLAR_RPC_URL: config.rpcUrl,
    SIMULATION_SOURCE: source,
    WRITE_MODE: "false",
    PRODUCT_MODE: "false",
    PORT: "3012",
    RATE_LIMIT: "300",
    STELLAR_POLICIES: JSON.stringify(policies),
  };
  await writeFile(
    ".local/top10-mainnet.env",
    Object.entries(env)
      .map(
        ([k, v]) =>
          k +
          "=" +
          (k === "STELLAR_POLICIES" ? "'" + v + "'" : JSON.stringify(v)),
      )
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await writeFile(".local/top10-mainnet.token", token, { mode: 0o600 });
  await writeFile(
    ".local/top10-mainnet.mcp.json",
    JSON.stringify(
      {
        mcpServers: Object.fromEntries(
          out.projects
            .filter((p) => p.tools?.length)
            .map((p) => [
              p.project,
              {
                url: `http://127.0.0.1:3012/contracts/${p.contractId}/mcp`,
                headers: { Authorization: "Bearer " + token },
              },
            ]),
        ),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      projects: out.projects.length,
      submissionAttempts: submissions,
      privateMcpConfig: ".local/top10-mainnet.mcp.json",
    }),
  );
  }
} finally {
  await new Promise((resolve) => http.close(resolve));
  await store.close();
}
