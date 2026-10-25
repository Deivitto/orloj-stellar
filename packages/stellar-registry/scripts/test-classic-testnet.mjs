// Manual live acceptance only. Uses new, disposable Friendbot accounts; never imports user wallet material.
import { writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  Asset,
  Keypair,
  Networks,
  rpc,
  Horizon,
  TransactionBuilder,
  Operation,
  LiquidityPoolAsset,
} from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { classicInterface } from "../dist/src/classic.js";
import { parseConfig } from "../dist/src/config.js";
import { environmentSigner } from "../dist/src/signer.js";
import { Executor } from "../dist/src/executor.js";
import { Store } from "../dist/src/store.js";
import { httpServer } from "../dist/src/gateway.js";
const pair = Keypair.random(),
  issuer = Keypair.random(),
  address = pair.publicKey();
const dex = "classic:stellar-dex",
  amm = "classic:stellar-amm",
  principal = "classic-manual-audit-" + randomUUID();
const policy = {
  [dex]: {
    account_balances: "READ",
    offers: "READ",
    orderbook: "READ",
    change_trust: "WRITE",
    manage_offer: "WRITE",
  },
  [amm]: {
    account_balances: "READ",
    liquidity_pool: "READ",
    trust_pool: "WRITE",
    pool_deposit: "WRITE",
    pool_withdraw: "WRITE",
  },
};
const config = parseConfig({
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  databaseUrl: process.env.DATABASE_URL,
  simulationSource: address,
  writeMode: true,
  externalSignerAddress: address,
  maxFee: "100000",
  policies: Object.entries(policy).flatMap(([contractId, fs]) =>
    Object.entries(fs).map(([functionName, mode]) => ({
      contractId,
      function: functionName,
      mode,
      principals: [principal],
    })),
  ),
});
const rpcServer = new rpc.Server(config.rpcUrl),
  horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
if ((await rpcServer.getNetwork()).passphrase !== Networks.TESTNET)
  throw Error("Wrong network");
const out = {
  testedAt: new Date().toISOString(),
  network: "testnet",
  wallet: address,
  issuer: issuer.publicKey(),
  funding: [],
  checks: [],
  transactions: [],
  assertions: {},
  mainnetSubmissions: 0,
};
const output =
  process.env.AUDIT_OUTPUT_FILE ??
  new URL(
    "../demo-contract/top10-audit/classic-testnet-results.json",
    import.meta.url,
  );
const persist = () => writeFile(output, JSON.stringify(out, null, 2) + "\n");
async function verify(hash) {
  for (let n = 0; n < 30; n++) {
    const r = await rpcServer.getTransaction(hash);
    if (r.status !== "NOT_FOUND")
      return {
        hash,
        status: r.status,
        ledger: r.ledger,
        feeCharged: r.resultXdr.feeCharged.toString(),
      };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { hash, status: "NOT_FOUND" };
}
for (const wallet of [address, issuer.publicKey()]) {
  const r = await fetch("https://friendbot.stellar.org?addr=" + wallet);
  if (!r.ok) throw Error("Friendbot failed");
  const f = await r.json();
  out.funding.push({ address: wallet, ...(await verify(f.hash)) });
  await persist();
}
const store = new Store(config.databaseUrl);
await store.migrate();
const token = randomBytes(32).toString("base64url");
await store.credential(token, principal);
for (const id of [dex, amm]) await store.save(classicInterface(config, id));
const http = httpServer(
  new Executor(
    config,
    rpcServer,
    store,
    environmentSigner(pair.secret(), Networks.TESTNET),
  ),
);
http.listen(0, "127.0.0.1");
await once(http, "listening");
const clients = [];
async function connect(id) {
  const c = new Client({ name: "orloj-classic-acceptance", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${http.address().port}/contracts/${id}/mcp`),
      { requestInit: { headers: { authorization: "Bearer " + token } } },
    ),
  );
  clients.push(c);
  return c;
}
async function call(client, name, args = {}, write = false, key) {
  const r = await client.callTool({
    name,
    arguments: {
      ...args,
      ...(write ? { idempotency_key: key ?? randomUUID() } : {}),
    },
  });
  const result = r.structuredContent;
  out.checks.push({ name, args, result });
  if (
    result.transaction_hash &&
    !out.transactions.some((t) => t.hash === result.transaction_hash)
  )
    out.transactions.push({ name, ...(await verify(result.transaction_hash)) });
  await persist();
  if (result.ok !== true)
    throw Error(
      "Classic acceptance failed at " + name + ": " + result.error_code,
    );
  return result;
}
try {
  const d = await connect(dex),
    a = await connect(amm);
  const asset = new Asset("ORLOJTEST", issuer.publicKey()),
    assetText = asset.getCode() + ":" + asset.getIssuer();
  await call(d, "account_balances", { account: address });
  await call(
    d,
    "change_trust",
    { asset: assetText, limit: "10000000000" },
    true,
  );
  // Issue only this disposable fixture asset. Record/confirm setup separately from adapter execution.
  const issuerAccount = await horizon.loadAccount(issuer.publicKey());
  const issue = new TransactionBuilder(issuerAccount, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: address, asset, amount: "100" }),
    )
    .setTimeout(60)
    .build();
  issue.sign(issuer);
  await rpcServer.sendTransaction(issue);
  out.transactions.push({
    name: "fixture_asset_issuance",
    ...(await verify(Buffer.from(issue.hash()).toString("hex"))),
  });
  await persist();
  const key = randomUUID();
  const offered = await call(
    d,
    "manage_offer",
    {
      selling: assetText,
      buying: "native",
      amount: "10000000",
      price: { n: 1, d: 1 },
      offer_id: "0",
    },
    true,
    key,
  );
  const duplicate = await call(
    d,
    "manage_offer",
    {
      selling: assetText,
      buying: "native",
      amount: "10000000",
      price: { n: 1, d: 1 },
      offer_id: "0",
    },
    true,
    key,
  );
  out.assertions.duplicateReconciled =
    offered.transaction_hash === duplicate.transaction_hash;
  const offers = await call(d, "offers", { account: address, limit: 10 });
  out.assertions.offerCreated = offers.data.length === 1;
  await call(d, "orderbook", {
    selling: assetText,
    buying: "native",
    limit: 10,
  });
  if (!offers.data[0]) throw Error("Offer not observed");
  await call(
    d,
    "manage_offer",
    {
      selling: assetText,
      buying: "native",
      amount: "0",
      price: { n: 1, d: 1 },
      offer_id: offers.data[0].id,
    },
    true,
  );
  const cancelled = await call(d, "offers", { account: address, limit: 10 });
  out.assertions.offerCancelled = cancelled.data.length === 0;
  const p = new LiquidityPoolAsset(Asset.native(), asset, 30),
    poolId = p.toString().split(":")[1];
  await call(
    a,
    "trust_pool",
    { asset_a: "native", asset_b: assetText, limit: "10000000000" },
    true,
  );
  await call(
    a,
    "pool_deposit",
    {
      pool_id: poolId,
      max_amount_a: "10000000",
      max_amount_b: "10000000",
      min_price: { n: 99, d: 100 },
      max_price: { n: 101, d: 100 },
    },
    true,
  );
  const before = await call(a, "liquidity_pool", { pool_id: poolId });
  out.assertions.poolDepositObserved = BigInt(before.data.total_shares) > 0n;
  await call(
    a,
    "pool_withdraw",
    {
      pool_id: poolId,
      amount: "5000000",
      min_amount_a: "4900000",
      min_amount_b: "4900000",
    },
    true,
  );
  const after = await call(a, "liquidity_pool", { pool_id: poolId });
  out.assertions.poolWithdrawalObserved =
    BigInt(after.data.total_shares) < BigInt(before.data.total_shares);
  await call(d, "account_balances", { account: address });
  await persist();
  console.log(
    JSON.stringify({
      ok: Object.values(out.assertions).every(Boolean),
      assertions: out.assertions,
      transactions: out.transactions.length,
    }),
  );
} finally {
  await store.revoke(token);
  for (const c of clients) await c.close().catch(() => {});
  await new Promise((r) => http.close(r));
  await store.close();
}
