// Isolated testnet fixture. Private keys live only inside this process; evidence contains public data.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  AuthRevocableFlag,
  AuthClawbackEnabledFlag,
} from "@stellar/stellar-sdk";
import { parseConfig } from "../dist/src/config.js";
import { ingestAsset, assetSpec } from "../dist/src/assets.js";
import { Store } from "../dist/src/store.js";
import { Executor } from "../dist/src/executor.js";
import { environmentSigner } from "../dist/src/signer.js";
const assert = (v) => {
  if (!v) throw new Error("Asset write assertion failed");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const local = await readFile(
    new URL("../.env.demo", import.meta.url),
    "utf8",
  );
  const databaseUrl =
    process.env.DATABASE_URL ?? /^DATABASE_URL=(.+)$/m.exec(local)?.[1];
  const server = new rpc.Server("https://soroban-testnet.stellar.org", {
      timeout: 15000,
    }),
    store = new Store(databaseUrl);
  const net = await server.getNetwork();
  assert(net.passphrase === Networks.TESTNET);
  assetSpec(Number(net.protocolVersion));
  const issuer = Keypair.random(),
    holder = Keypair.random(),
    spender = Keypair.random();
  const descriptor = {
      kind: "issued",
      code: "ORLOJTEST",
      issuer: issuer.publicKey(),
    },
    asset = new Asset(descriptor.code, descriptor.issuer),
    id = asset.contractId(Networks.TESTNET);
  const principal = "asset-write-test:" + randomUUID();
  const evidence = {
    network: "testnet",
    testedAt: new Date().toISOString(),
    asset: descriptor,
    contract_id: id,
    holder: holder.publicKey(),
    spender: spender.publicKey(),
    checks: [],
  };
  function record(check, result) {
    evidence.checks.push({ check, ...result });
    console.log(JSON.stringify({ check, ...result }));
  }
  // Setup operations are separate from registry registration and MCP execution.
  async function setup(key, op, prepare = false) {
    const a = await server.getAccount(key.publicKey());
    let tx = new TransactionBuilder(a, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();
    if (prepare) tx = await server.prepareTransaction(tx);
    tx.sign(key);
    const hash = Buffer.from(tx.hash()).toString("hex");
    const sent = await server.sendTransaction(tx);
    assert(sent.status !== "ERROR");
    for (let n = 0; n < 60; n++) {
      const r = await server.getTransaction(hash);
      if (r.status === "SUCCESS") {
        record("fixture_setup", { ok: true, transaction_hash: hash });
        return;
      }
      assert(r.status !== "FAILED");
      await sleep(1000);
    }
    throw new Error("Fixture setup unresolved; not resubmitted");
  }
  try {
    await store.migrate();
    for (const key of [issuer, holder, spender]) {
      const r = await fetch(
        `https://friendbot.stellar.org?addr=${key.publicKey()}`,
      );
      assert(r.ok);
    }
    await setup(
      issuer,
      Operation.setOptions({
        setFlags: AuthRevocableFlag | AuthClawbackEnabledFlag,
      }),
    );
    await setup(issuer, Operation.createStellarAssetContract({ asset }), true);
    const reads = new Set([
      "allowance",
      "balance",
      "authorized",
      "admin",
      "decimals",
      "name",
      "symbol",
    ]);
    const configFor = (key) =>
      parseConfig({
        databaseUrl,
        network: "testnet",
        rpcUrl: "https://soroban-testnet.stellar.org",
        simulationSource: key.publicKey(),
        writeMode: true,
        signerSecret: key.secret(),
        maxFee: "2000000",
        policies: assetSpec(Number(net.protocolVersion))
          .funcs()
          .map((f) => ({
            contractId: id,
            function: f.name.toString(),
            mode: reads.has(f.name.toString()) ? "READ" : "WRITE",
            principals: [principal],
          })),
      });
    const base = configFor(issuer),
      i = await ingestAsset(server, base, descriptor);
    await store.save(i);
    async function call(key, name, values = [], expected = true) {
      const config = configFor(key),
        executor = new Executor(
          config,
          server,
          store,
          environmentSigner(key.secret(), Networks.TESTNET),
        );
      const f = i.functions.find((f) => f.sorobanName === name);
      assert(f);
      const args = Object.fromEntries(
        f.params.map((p, n) => [p.name, values[n]]),
      );
      const requestKey = randomUUID();
      const r = await executor.call(i, f, args, principal, requestKey);
      record(name, r);
      if (expected)
        assert(
          r.ok &&
            (f.mode === "READ" ||
              r.result_status === "SUBMITTED_AND_CONFIRMED"),
        );
      else assert(!r.ok);
      if (expected && name === "transfer") {
        const duplicate = await executor.call(
          i,
          f,
          args,
          principal,
          requestKey,
        );
        assert(duplicate.transaction_hash === r.transaction_hash);
        record("duplicate_reconciled", duplicate);
      }
      return r;
    }
    await call(holder, "trust", [holder.publicKey()]);
    await call(spender, "trust", [spender.publicKey()]);
    for (const name of ["name", "symbol", "decimals", "admin"])
      await call(issuer, name);
    await call(issuer, "authorized", [holder.publicKey()]);
    await call(issuer, "mint", [holder.publicKey(), "100000000"]);
    await call(holder, "balance", [holder.publicKey()]);
    const ledger = await server.getLatestLedger();
    await call(holder, "approve", [
      holder.publicKey(),
      spender.publicKey(),
      "30000000",
      ledger.sequence + 1000,
    ]);
    await call(holder, "allowance", [holder.publicKey(), spender.publicKey()]);
    await call(holder, "transfer", [
      holder.publicKey(),
      spender.publicKey(),
      "10000000",
    ]);
    await call(spender, "transfer_from", [
      spender.publicKey(),
      holder.publicKey(),
      spender.publicKey(),
      "10000000",
    ]);
    await call(holder, "burn", [holder.publicKey(), "10000000"]);
    await call(spender, "burn_from", [
      spender.publicKey(),
      holder.publicKey(),
      "10000000",
    ]);
    await call(issuer, "clawback", [holder.publicKey(), "10000000"]);
    await call(issuer, "set_authorized", [holder.publicKey(), false]);
    await call(
      holder,
      "transfer",
      [holder.publicKey(), spender.publicKey(), "1"],
      false,
    );
    await call(issuer, "set_authorized", [holder.publicKey(), true]);
    await call(issuer, "set_admin", [spender.publicKey()]);
    await call(issuer, "mint", [holder.publicKey(), "1"], false);
    await call(spender, "mint", [holder.publicKey(), "1"]);
    await call(spender, "set_admin", [issuer.publicKey()]);
    await call(holder, "balance", [holder.publicKey()]);
    evidence.ok = true;
  } finally {
    await writeFile(
      new URL("../demo-contract/assets-write-evidence.json", import.meta.url),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    await store.close();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      error_code: e.code ?? "ASSET_WRITE_TEST_FAILED",
      message:
        e.message === "Asset write assertion failed" ? e.message : undefined,
    }),
  );
  process.exitCode = 1;
});
