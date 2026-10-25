// Live protocol audit. Private signing material stays inside this process's Signer implementation.
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { rpc, Keypair, Networks, Asset } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../dist/src/config.js";
import { ingest } from "../dist/src/ingestion.js";
import { ingestAsset } from "../dist/src/assets.js";
import { Store } from "../dist/src/store.js";
import { Executor } from "../dist/src/executor.js";
import { environmentSigner } from "../dist/src/signer.js";
import { httpServer } from "../dist/src/gateway.js";
const privateSigner = () => {
  const pair = Keypair.random();
  return environmentSigner(pair.secret(), Networks.TESTNET);
};
const signer = privateSigner(),
  address = signer.address;
const targets = JSON.parse(
  await readFile(
    new URL(
      "../demo-contract/top10-audit/discovery-testnet.json",
      import.meta.url,
    ),
    "utf8",
  ),
).targets;
const functions = {
  "Blend Pools V2": {
    get_reserve_list: "READ",
    get_positions: "READ",
    submit: "WRITE",
  },
  DeFindex: {
    name: "READ",
    get_fees: "READ",
    get_assets: "READ",
    balance: "READ",
    deposit: "WRITE",
    withdraw: "WRITE",
  },
  "Aquarius Stellar": {
    version: "READ",
    get_tokens_sets_count: "READ",
    get_tokens: "READ",
    get_pools_for_tokens_range: "READ",
    estimate_swap: "READ",
    swap: "WRITE",
  },
};
const native = Asset.native().contractId(Networks.TESTNET);
const policies = targets.flatMap((t) =>
  Object.entries(functions[t.project]).map(([fn, mode]) => ({
    contractId: t.contractId,
    function: fn,
    mode,
    principals: ["top10-testnet-audit"],
  })),
);
policies.push({
  contractId: native,
  function: "balance",
  mode: "READ",
  principals: ["top10-testnet-audit"],
});
const config = parseConfig({
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  databaseUrl: process.env.DATABASE_URL,
  simulationSource: address,
  writeMode: true,
  externalSignerAddress: address,
  maxFee: process.env.AUDIT_TESTNET_MAX_FEE ?? "2000000",
  rateLimit: 300,
  policies,
});
if (BigInt(config.maxFee) > 3000000000n) throw Error("Audit fee cap exceeded");
const server = new rpc.Server(config.rpcUrl, { timeout: 20000 });
let submissionCount = 0,
  envelopeSignCount = 0;
const send = server.sendTransaction.bind(server);
server.sendTransaction = async (...args) => {
  submissionCount++;
  return send(...args);
};
const sign = signer.sign_transaction_envelope;
signer.sign_transaction_envelope = async (...args) => {
  envelopeSignCount++;
  return sign(...args);
};
if ((await server.getNetwork()).passphrase !== Networks.TESTNET)
  throw Error("Wrong network");
const out = {
  testedAt: new Date().toISOString(),
  network: "testnet",
  maximumFeeStroops: config.maxFee,
  instructionLeeway: config.instructionLeeway,
  wallet: address,
  funding: [],
  projects: [],
  transactions: [],
  safetyChecks: [],
};
const persist = () =>
  writeFile(
    process.env.AUDIT_OUTPUT_FILE ??
      new URL(
        "../demo-contract/top10-audit/testnet-results.json",
        import.meta.url,
      ),
    JSON.stringify(out, null, 2) + "\n",
  );
const fundingResponse = await fetch(
  "https://friendbot.stellar.org?addr=" + address,
  { signal: AbortSignal.timeout(45000) },
);
const funding = await fundingResponse.json();
if (!fundingResponse.ok) throw Error("Friendbot failed");
out.funding.push({ source: "Stellar Friendbot", hash: funding.hash, address });
await persist();
const fundingTx = await server.getTransaction(funding.hash);
out.funding[0].rpcStatus = fundingTx.status;
await persist();
const store = new Store(config.databaseUrl),
  token = randomBytes(32).toString("base64url");
await store.migrate();
await store.credential(token, "top10-testnet-audit");
for (const t of targets)
  if (t.interface) {
    t.interface = await ingest(server, config, t.contractId);
    await store.save(t.interface);
  }
await store.save(await ingestAsset(server, config, { kind: "native" }));
const http = httpServer(new Executor(config, server, store, signer));
http.listen(0, "127.0.0.1");
await once(http, "listening");
const clients = [];
const connect = async (id) => {
  const client = new Client({
    name: "orloj-live-protocol-audit",
    version: "1",
  });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${http.address().port}/contracts/${id}/mcp`),
      { requestInit: { headers: { authorization: "Bearer " + token } } },
    ),
  );
  clients.push(client);
  return client;
};
async function call(client, project, name, args = {}, write = false) {
  const key = write ? "top10-" + randomUUID() : undefined;
  const response = await client.callTool({
    name,
    arguments: { ...args, ...(key ? { idempotency_key: key } : {}) },
  });
  const result = response.structuredContent;
  project.checks.push({ name, args, ...result });
  if (result?.transaction_hash) {
    const independent = await server.getTransaction(result.transaction_hash);
    out.transactions.push({
      project: project.project,
      function: name,
      hash: result.transaction_hash,
      executorStatus: result.result_status,
      rpcStatus: independent.status,
      ledger: independent.ledger,
    });
  }
  if (process.env.AUDIT_DEEP === "true" && write && result?.transaction_hash) {
    const sendsBefore = submissionCount, signsBefore = envelopeSignCount;
    const duplicate = (await client.callTool({name, arguments: {...args, idempotency_key: key}})).structuredContent;
    const ok = duplicate?.transaction_hash === result.transaction_hash && submissionCount === sendsBefore && envelopeSignCount === signsBefore;
    out.safetyChecks.push({project: project.project, check: "duplicate_reconciles_without_signing_or_sending", name, ok, hash: result.transaction_hash});
    if (!ok) throw Error("Duplicate request changed signing/submission");
  }
  await persist();
  console.log(
    JSON.stringify({
      project: project.project,
      name,
      ok: result?.ok,
      error_code: result?.error_code,
      hash: result?.transaction_hash,
    }),
  );
  return result;
}
async function reject(client, project, name, args, expected) {
  const sendsBefore = submissionCount, signsBefore = envelopeSignCount;
  const result = (await client.callTool({name, arguments: {...args, idempotency_key: randomUUID()}})).structuredContent;
  const ok = result?.ok === false && !result.transaction_hash && submissionCount === sendsBefore && envelopeSignCount === signsBefore && (!expected || expected.includes(result.error_code));
  out.safetyChecks.push({project:project.project, check:"rejected_before_signing_and_submission", name, error_code:result?.error_code, transaction_hash:result?.transaction_hash, result_status:result?.result_status, expected, ok});
  await persist();
  if (!ok) throw Error("Negative protocol test did not fail safely");
}
try {
  for (const t of targets) {
    const p = {
      project: t.project,
      contractId: t.contractId,
      source: t.source,
      checks: [],
    };
    out.projects.push(p);
    if (!t.interface) {
      p.blocker = t.error;
      continue;
    }
    const client = await connect(t.contractId),
      tools = (await client.listTools()).tools.map((x) => x.name);
    p.tools = tools;
    if (process.env.AUDIT_DEEP === "true") {
      const read = Object.entries(functions[t.project]).find(([,mode])=>mode === "READ")[0];
      await reject(client,p,read,{unexpected_property:true},["INVALID_ARGUMENT"]);
    }
    if (t.project === "Blend Pools V2") {
      const reserves = await call(client, p, "get_reserve_list");
      await call(client, p, "get_positions", { address });
      if (reserves.ok && reserves.data.includes(native)) {
        const args = {
          from: address,
          spender: address,
          to: address,
          requests: [{ address: native, amount: "10000000", request_type: 0 }],
        };
        const deposit = await call(client, p, "submit", args, true);
        if (deposit.ok) {
          const deposited = await call(client, p, "get_positions", { address });
          const withdrawal = await call(
            client,
            p,
            "submit",
            {
              ...args,
              requests: [
                { address: native, amount: "5000000", request_type: 1 },
              ],
            },
            true,
          );
          const withdrawn = await call(client, p, "get_positions", { address });
          p.depositPositionIncreased =
            deposited.ok && deposited.data.supply.length > 0;
          if (process.env.AUDIT_DEEP === "true") await reject(client,p,"submit",{...args,from:Keypair.random().publicKey(),requests:[{address:native,amount:"1",request_type:1}]});
          p.withdrawalConfirmed = withdrawal.ok === true;
          p.withdrawalPositionDecreased =
            withdrawn.ok &&
            deposited.ok &&
            BigInt(withdrawn.data.supply[0]?.[1] ?? "0") <
              BigInt(deposited.data.supply[0]?.[1] ?? "0");
        }
      } else p.blocker = "Official test pool does not list native XLM";
    } else if (t.project === "DeFindex") {
      await call(client, p, "name");
      await call(client, p, "get_fees");
      const assets = await call(client, p, "get_assets");
      const supportedAssets = assets.ok ? assets.data.values[0] : [];
      if (
        tools.includes("deposit") &&
        tools.includes("withdraw") &&
        supportedAssets.length === 1 &&
        supportedAssets[0].address === native
      ) {
        const before = await call(client, p, "balance", { id: address });
        const deposit = await call(
          client,
          p,
          "deposit",
          {
            amounts_desired: ["10000000"],
            amounts_min: ["9900000"],
            from: address,
            invest: false,
          },
          true,
        );
        const after = await call(client, p, "balance", { id: address });
        p.depositSharesIncreased = !!(
          before.ok &&
          deposit.ok &&
          after.ok &&
          BigInt(after.data) > BigInt(before.data)
        );
        if (deposit.ok && after.ok && BigInt(after.data) > 0n) {
          const withdrawal = await call(
            client,
            p,
            "withdraw",
            {
              withdraw_shares: (BigInt(after.data) / 2n).toString(),
              min_amounts_out: ["0"],
              from: address,
            },
            true,
          );
          if (process.env.AUDIT_DEEP === "true") await reject(client,p,"withdraw",{withdraw_shares:"999999999999999999999",min_amounts_out:["0"],from:address});
          const final = await call(client, p, "balance", { id: address });
          p.withdrawalConfirmed = withdrawal.ok === true;
          p.withdrawalSharesDecreased = !!(
            final.ok &&
            withdrawal.ok &&
            BigInt(final.data) < BigInt(after.data)
          );
        }
      } else
        p.assetRestriction =
          "Deposit live test requires a verified single-native-XLM vault and complete signatures.";
      p.blocker = Object.keys(functions[t.project])
        .filter((fn) => !tools.includes(fn))
        .map((fn) => ({
          function: fn,
          reason:
            t.interface.inventory.find((m) => m.name === fn)?.error_code ??
            "Not declared",
        }));
    } else if (t.project === "Aquarius Stellar") {
      await call(client, p, "version");
      const count = await call(client, p, "get_tokens_sets_count");
      let pair;
      for (let n = 0; n < Math.min(Number(count.data ?? 0), 10); n++) {
        const pools = await call(client, p, "get_pools_for_tokens_range", {
          start: String(n),
          end: String(n + 1),
        });
        if (!pools.ok) break;
        pair = pools.data.find(([tokens]) => tokens.includes(native));
        if (pair) break;
      }
      if (pair) {
        p.availableNativePair = pair;
        const [tokens, pools] = pair,
          other = tokens.find((t) => t !== native),
          pool = pools[0]?.[0];
        if (pool) {
          const quote = await call(client, p, "estimate_swap", {
            tokens,
            token_in: native,
            token_out: other,
            pool_index: pool,
            in_amount: "100000",
          });
          p.swapQuote = quote;
          if (quote?.ok && BigInt(quote.data) > 0n) {
            config.policies.push({
              contractId: other,
              function: "balance",
              mode: "READ",
              principals: ["top10-testnet-audit"],
            });
            let tokenInterface = await ingest(server, config, other);
            if (tokenInterface.sourceKind === "stellar_asset")
              config.policies.push({
                contractId: other,
                function: "trust",
                mode: "WRITE",
                principals: ["top10-testnet-audit"],
              });
            tokenInterface = await ingest(server, config, other);
            await store.save(tokenInterface);
            const tokenClient = await connect(other);
            let ready = true;
            if (tokenInterface.sourceKind === "stellar_asset") {
              const trust = await call(
                tokenClient,
                p,
                "trust",
                { addr: address },
                true,
              );
              ready = !!trust.ok;
            }
            if (ready) {
              const param = tokenInterface.functions.find(
                (f) => f.sorobanName === "balance",
              )?.params[0]?.name;
              if (!param) {
                p.blocker = "Output token balance method unavailable";
              } else {
                const before = await call(tokenClient, p, "balance", {
                  [param]: address,
                });
                if (process.env.AUDIT_DEEP === "true") await reject(client,p,"swap",{user:address,tokens,token_in:native,token_out:other,pool_index:pool,in_amount:"100000",out_min:"999999999999999999999"});
                const swap = await call(
                  client,
                  p,
                  "swap",
                  {
                    user: address,
                    tokens,
                    token_in: native,
                    token_out: other,
                    pool_index: pool,
                    in_amount: "100000",
                    out_min: ((BigInt(quote.data) * 98n) / 100n).toString(),
                  },
                  true,
                );
                const after = await call(tokenClient, p, "balance", {
                  [param]: address,
                });
                p.outputBalanceIncreased = !!(
                  swap.ok &&
                  before.ok &&
                  after.ok &&
                  BigInt(after.data) > BigInt(before.data)
                );
              }
            } else p.blocker = "Output trustline creation failed";
          } else p.blocker = "No executable swap quote";
        }
      } else
        p.blocker =
          "No native XLM pool found in first ten official testnet token sets";
    }
    await persist();
  }
  const nativeClient = await connect(native);
  out.finalNativeBalance = await nativeClient
    .callTool({ name: "balance", arguments: { addr: address } })
    .then((r) => r.structuredContent);
  out.submissionCount = submissionCount;
  out.envelopeSignCount = envelopeSignCount;
  out.allSafetyChecksPassed = out.safetyChecks.every((x) => x.ok);
  await persist();
  if (process.env.AUDIT_DEEP === "true" && out.projects.some((p) =>
    p.project === "Aquarius Stellar"
      ? !p.outputBalanceIncreased
      : !p.withdrawalConfirmed || !(p.depositPositionIncreased ?? p.depositSharesIncreased) || !(p.withdrawalPositionDecreased ?? p.withdrawalSharesDecreased)
  )) throw Error("Protocol state checks incomplete");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await new Promise((resolve) => http.close(resolve));
  await store.close();
}
