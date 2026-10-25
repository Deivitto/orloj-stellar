import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Asset, Networks, rpc } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../dist/src/config.js";
import { ingestAsset } from "../dist/src/assets.js";
import { Store } from "../dist/src/store.js";
import { Executor } from "../dist/src/executor.js";
import { httpServer } from "../dist/src/gateway.js";
const wallet = process.argv[2];
const assert = (v) => {
  if (!v) throw new Error("Asset test assertion failed");
};
async function main() {
  assert(wallet);
  const local = await readFile(
    new URL("../.env.demo", import.meta.url),
    "utf8",
  );
  const databaseUrl =
    process.env.DATABASE_URL ?? /^DATABASE_URL=(.+)$/m.exec(local)?.[1];
  const descriptors = [
    { kind: "native" },
    {
      kind: "issued",
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
  ];
  const ids = descriptors.map((a) =>
    (a.kind === "native"
      ? Asset.native()
      : new Asset(a.code, a.issuer)
    ).contractId(Networks.TESTNET),
  );
  const config = parseConfig({
    databaseUrl,
    simulationSource: wallet,
    rpcUrl: "https://soroban-testnet.stellar.org",
    policies: ids.flatMap((contractId) =>
      ["name", "symbol", "decimals", "balance", "transfer", "mint"].map(
        (fn) => ({
          contractId,
          function: fn,
          mode: "READ",
          principals: ["asset-read-test"],
        }),
      ),
    ),
  });
  const server = new rpc.Server(config.rpcUrl, { timeout: 15000 }),
    store = new Store(databaseUrl);
  const token = randomBytes(32).toString("base64url");
  let http;
  const evidence = {
    network: "testnet",
    testedAt: new Date().toISOString(),
    wallet,
    checks: [],
  };
  try {
    await store.migrate();
    await store.credential(token, "asset-read-test");
    http = httpServer(new Executor(config, server, store));
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    for (const descriptor of descriptors) {
      const i = await ingestAsset(server, config, descriptor);
      await store.save(i);
      const client = new Client({ name: "orloj-asset-test", version: "1.0.0" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(
              `http://127.0.0.1:${http.address().port}/contracts/${i.contractId}/mcp`,
            ),
            { requestInit: { headers: { authorization: `Bearer ${token}` } } },
          ),
        );
        const resources = await client.listResources();
        const resource = await client.readResource({
          uri: resources.resources[0].uri,
        });
        assert(JSON.parse(resource.contents[0].text).inventory.length === 17);
        for (const fn of ["name", "symbol", "decimals", "balance"]) {
          const signature = i.functions.find((f) => f.sorobanName === fn);
          const args =
            fn === "balance" ? { [signature.params[0].name]: wallet } : {};
          const r = await client.callTool({ name: fn, arguments: args });
          const result = r.structuredContent;
          evidence.checks.push({
            asset: descriptor.kind === "native" ? "XLM" : descriptor.code,
            function: fn,
            ...result,
          });
          console.log(JSON.stringify(evidence.checks.at(-1)));
          assert(
            result.ok &&
              result.result_status === "SIMULATED" &&
              !("wasm_hash" in result),
          );
        }
        if (descriptor.kind === "issued") {
          for (const [name, args, expected] of [
            [
              "transfer",
              { from: wallet, to_mux: wallet, amount: "1000000000000000" },
              "ASSET_BALANCE_ERROR",
            ],
            [
              "transfer",
              {
                from: wallet,
                to_mux:
                  "GCMTGOQNSDPXONMWAB4Z7RTICCOPXNLFTQ2JEHY4HBWYFYRMFZNJ7MB5",
                amount: "1",
              },
              "ASSET_TRUSTLINE_REQUIRED",
            ],
            ["mint", { to: wallet, amount: "1" }, "AUTHORIZATION_REQUIRED"],
          ]) {
            const r = await client.callTool({ name, arguments: args });
            const result = r.structuredContent;
            evidence.checks.push({
              asset: "USDC",
              check: "safe_failure",
              ...result,
            });
            console.log(JSON.stringify(evidence.checks.at(-1)));
            assert(result.error_code === expected);
          }
        }
      } finally {
        await client.close();
      }
    }
    await writeFile(
      new URL("../demo-contract/assets-read-evidence.json", import.meta.url),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  } finally {
    if (http) await new Promise((r) => http.close(r));
    await store.revoke(token);
    await store.close();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      error_code: e.code ?? "ASSET_READ_TEST_FAILED",
    }),
  );
  process.exitCode = 1;
});
