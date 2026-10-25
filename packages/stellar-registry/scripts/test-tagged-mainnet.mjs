// Manual read-only compatibility probe. It cannot sign or submit transactions.
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { httpServer } from "../dist/src/gateway.js";
import { writeFile } from "node:fs/promises";
import { rpc } from "@stellar/stellar-sdk";
import { loadConfig, parseConfig } from "../dist/src/config.js";
import { Store } from "../dist/src/store.js";
import { ingest } from "../dist/src/ingestion.js";
import { Executor } from "../dist/src/executor.js";
const id = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
  base = loadConfig();
if (base.network !== "mainnet" || base.writeMode)
  throw Error("Mainnet read-only configuration required");
const config = parseConfig({
  ...Object.fromEntries(
    Object.entries(base).filter(([k]) => k !== "networkPassphrase"),
  ),
  signerSecret: undefined,
  externalSignerAddress: undefined,
  policies: [
    {
      contractId: id,
      function: "get_info",
      mode: "READ",
      principals: ["tagged-audit"],
    },
  ],
});
const chain = new rpc.Server(config.rpcUrl, { timeout: 20000 }),
  store = new Store(config.databaseUrl);
const token = randomBytes(32).toString("hex");
let http, client;
try {
  const i = await ingest(chain, config, id),
    f = i.functions.find((f) => f.sorobanName === "get_info");
  if (!f) throw Error("Declared get_info not eligible");
  await store.migrate();
  await store.save(i);
  await store.credential(token, "tagged-audit");
  http = httpServer(new Executor(config, chain, store));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  client = new Client({ name: "orloj-tagged-acceptance", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${http.address().port}/contracts/${id}/mcp`),
      { requestInit: { headers: { authorization: "Bearer " + token } } },
    ),
  );
  const result = (
    await client.callTool({
      name: f.mcpToolName,
      arguments: {
        tokens: [
          "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
          "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK",
        ],
        pool_index:
          "0b607c211d1f2f4e74c00e1ecf8024603bf5971a1af9d638ca06713393ee9651",
      },
    })
  ).structuredContent;
  const evidence = {
    verifiedAt: new Date().toISOString(),
    project: "Aquarius",
    contract_id: id,
    encodingVersion: i.encodingVersion,
    interface_hash: i.interfaceHash,
    eligible: i.inventory.filter((m) => m.eligible).length,
    total: i.inventory.length,
    submissionCount: 0,
    transport: "Authenticated MCP HTTP",
    result,
  };
  await writeFile(
    new URL(
      "../demo-contract/top10-audit/tagged-mainnet-results.json",
      import.meta.url,
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
  if (!result.ok) process.exitCode = 1;
} finally {
  if (client) await client.close();
  if (http) await new Promise((r) => http.close(r));
  await store.revoke(token);
  await store.close();
}
