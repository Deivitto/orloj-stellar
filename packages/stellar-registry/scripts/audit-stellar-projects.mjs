import { readFile, writeFile, mkdir } from "node:fs/promises";
import { rpc } from "@stellar/stellar-sdk";
import { parseConfig } from "../dist/src/config.js";
import { ingest } from "../dist/src/ingestion.js";
import { envelope } from "../dist/src/errors.js";
const targets = JSON.parse(await readFile(process.argv[2], "utf8"));
const c = parseConfig({
  network: process.env.AUDIT_NETWORK ?? "mainnet",
  rpcUrl:
    process.env.AUDIT_RPC ?? "https://soroban-rpc.mainnet.stellar.gateway.fm",
  databaseUrl: process.env.DATABASE_URL,
  simulationSource: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
});
const server = new rpc.Server(c.rpcUrl, { timeout: 20000 });
const network = await server.getNetwork();
if (network.passphrase !== c.networkPassphrase) throw Error("Network mismatch");
const out = {
  testedAt: new Date().toISOString(),
  network: c.network,
  protocol: network.protocolVersion,
  targets: [],
};
await mkdir(new URL("../demo-contract/top10-audit/", import.meta.url), {
  recursive: true,
});
for (const t of targets) {
  try {
    const i = await ingest(server, c, t.contractId);
    out.targets.push({ ...t, interface: i });
    console.log(
      JSON.stringify({
        project: t.project,
        eligible: i.inventory.filter((x) => x.eligible).length,
        total: i.inventory.length,
        methods: i.inventory
          .filter((x) => x.eligible)
          .map((x) => ({
            name: x.name,
            params: x.signature.params.map((p) => ({
              name: p.name,
              type: p.sorobanType,
            })),
            returns: x.signature.returns.sorobanType,
          })),
      }),
    );
  } catch (e) {
    const error = envelope(e);
    out.targets.push({ ...t, error });
    console.log(JSON.stringify({ project: t.project, ...error }));
  }
  await writeFile(
    process.argv[3] ??
      new URL(
        "../demo-contract/top10-audit/discovery-" + c.network + ".json",
        import.meta.url,
      ),
    JSON.stringify(out, null, 2) + "\n",
  );
}
