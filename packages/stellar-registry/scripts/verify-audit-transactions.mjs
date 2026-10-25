// Manual, read-only Testnet verification of hashes from supplied audit evidence.
import { readFile, writeFile } from "node:fs/promises";
import { rpc, Networks } from "@stellar/stellar-sdk";

const files = process.argv.slice(2);
if (!files.length || !process.env.AUDIT_OUTPUT_FILE)
  throw Error("Supply evidence files and AUDIT_OUTPUT_FILE");
const hashes = new Map();
function collect(value, source) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["hash", "transaction_hash"].includes(key) &&
        typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) {
      const sources = hashes.get(item) ?? new Set();
      sources.add(source);
      hashes.set(item, sources);
    } else collect(item, source);
  }
}
for (const file of files) collect(JSON.parse(await readFile(file, "utf8")), file);
if (!hashes.size) throw Error("No transaction hashes found");
const server = new rpc.Server("https://soroban-testnet.stellar.org", { timeout: 20000 });
if ((await server.getNetwork()).passphrase !== Networks.TESTNET)
  throw Error("Wrong network");
const evidence = { verifiedAt: new Date().toISOString(), network: "testnet", transactions: [] };
for (const [hash, sources] of hashes) {
  const result = await server.getTransaction(hash);
  evidence.transactions.push({ hash, sources: [...sources], status: result.status,
    ledger: result.ledger, fee_charged: result.resultXdr?.feeCharged.toString() });
  await writeFile(process.env.AUDIT_OUTPUT_FILE, JSON.stringify(evidence, null, 2) + "\n");
}
evidence.allSuccessful = evidence.transactions.every(t => t.status === "SUCCESS");
await writeFile(process.env.AUDIT_OUTPUT_FILE, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ verified: hashes.size, allSuccessful: evidence.allSuccessful }));
if (!evidence.allSuccessful) process.exitCode = 1;
