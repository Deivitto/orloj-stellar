// Explicit manual Testnet acceptance. Managed keys are created/decrypted only by signerService.
// Fixture issuer exists in process memory solely for initial role setup, never in MCP responses.
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import {
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  AuthRequiredFlag,
  AuthRevocableFlag,
  AuthClawbackEnabledFlag,
} from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../dist/src/store.js";
import { Product } from "../dist/src/product.js";
import { Executor } from "../dist/src/executor.js";
import { signerService } from "../dist/src/managed-signer.js";
import { httpServer } from "../dist/src/gateway.js";
import { parseConfig } from "../dist/src/config.js";
import { assetSpec } from "../dist/src/assets.js";
import { ingest } from "../dist/src/ingestion.js";
import { environmentSigner } from "../dist/src/signer.js";
const assert = (v, reason = "Managed acceptance assertion failed") => {
  if (!v) throw Error(reason);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = {
  testedAt: new Date().toISOString(),
  network: "testnet",
  scope:
    "Isolated project-controlled fixture; real MCP HTTP, managed signer and ledger transactions. No browser chat claim.",
  checks: [],
};
const databaseUrl = process.env.TEST_DATABASE_URL;
assert(databaseUrl, "TEST_DATABASE_URL is required");
const wasmMode = process.argv.includes("--wasm");
const schema = "managed_live_" + randomUUID().replaceAll("-", "");
const base = new Store(databaseUrl);
await base.pool.query(`CREATE SCHEMA ${schema}`);
const scoped = new URL(databaseUrl);
scoped.searchParams.set("options", "-c search_path=" + schema);
const store = new Store(scoped.toString()),
  chain = new rpc.Server("https://soroban-testnet.stellar.org", {
    timeout: 20000,
  });
let product, signer, http;
const record = (check, result) => {
  evidence.checks.push({ check, ...result });
  console.log(
    JSON.stringify({
      check,
      ok: result.ok,
      result_status: result.result_status,
      error_code: result.error_code,
      transaction_hash: result.transaction_hash,
    }),
  );
};
try {
  await store.migrate();
  await store.pool.query(
    "CREATE TABLE agent_ownership(agent_id text PRIMARY KEY,user_id text,instance_id uuid,stellar_policy_revision integer NOT NULL DEFAULT 0);CREATE TABLE mcp_api_key(id text PRIMARY KEY,agent_id text,token text,revoked_at timestamptz,owner_id text,instance_id uuid)",
  );
  const issuer = Keypair.random(),
    serviceToken = randomBytes(32).toString("hex");
  const net = await chain.getNetwork();
  assert(net.passphrase === Networks.TESTNET);
  assetSpec(Number(net.protocolVersion));
  const fund = async (address) => {
    const r = await fetch("https://friendbot.stellar.org?addr=" + address, {
      signal: AbortSignal.timeout(60000),
    });
    assert(r.ok, "Friendbot funding failed");
    record("fixture_funding", { ok: true, address });
  };
  await fund(issuer.publicKey());
  signer = await signerService(store, randomBytes(32), serviceToken);
  signer.listen(0, "127.0.0.1");
  await once(signer, "listening");
  const config = parseConfig({
    databaseUrl: scoped.toString(),
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    simulationSource: issuer.publicKey(),
    productMode: true,
    writeMode: true,
    maxFee: "2000000",
    pollTimeoutMs: 90000,
    rateLimit: 1000,
  });
  product = new Product(config, chain, store, {
    serviceToken,
    signerToken: serviceToken,
    signerUrl: "http://127.0.0.1:" + signer.address().port,
    origin: "http://localhost:3000",
  });
  http = httpServer(new Executor(config, chain, store), product);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  product.start();
  const roles = {};
  for (const role of wasmMode ? ["holder"] : ["admin", "holder", "delegate"]) {
    const a = {
        agentId: randomUUID(),
        ownerId: randomUUID(),
        instanceId: randomUUID(),
        credentialId: randomUUID(),
      },
      token = randomBytes(32).toString("hex");
    await store.pool.query(
      "INSERT INTO agent_ownership(agent_id,user_id,instance_id) VALUES($1,$2,$3)",
      [a.agentId, a.ownerId, a.instanceId],
    );
    await store.pool.query(
      "INSERT INTO mcp_api_key VALUES($1,$2,$3,NULL,$4,$5)",
      [a.credentialId, a.agentId, token, a.ownerId, a.instanceId],
    );
    const wallet = await product.managedWallet(a);
    await fund(wallet.address);
    roles[role] = { a, token, address: wallet.address, policies: new Map() };
  }
  evidence.roles = Object.fromEntries(
    Object.entries(roles).map(([r, v]) => [r, v.address]),
  );
  const asset = new Asset("ORLOJTEST", issuer.publicKey()),
    id = wasmMode
      ? "CDE5GSVKUT3KOITP6XL6LLLXXKFNRLC7PN34WUCLG565HC46S6QYPKWB"
      : asset.contractId(Networks.TESTNET);
  evidence.asset = { code: asset.code, issuer: asset.issuer, contract_id: id };
  async function setup(op, prepare = false) {
    let tx = new TransactionBuilder(
      await chain.getAccount(issuer.publicKey()),
      { fee: "100", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(op)
      .setTimeout(60)
      .build();
    if (prepare) tx = await chain.prepareTransaction(tx);
    tx.sign(issuer);
    const hash = Buffer.from(tx.hash()).toString("hex");
    const sent = await chain.sendTransaction(tx);
    assert(sent.status !== "ERROR", "Fixture setup rejected");
    for (let n = 0; n < 90; n++) {
      const r = await chain.getTransaction(hash);
      if (r.status === "SUCCESS") {
        record("fixture_setup", { ok: true, transaction_hash: hash });
        return;
      }
      assert(r.status !== "FAILED", "Fixture setup failed");
      await sleep(1000);
    }
    throw Error("Fixture setup unresolved; never resubmitted");
  }
  if (!wasmMode) {
    await setup(
      Operation.setOptions({
        setFlags:
          AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag,
      }),
    );
    await setup(Operation.createStellarAssetContract({ asset }), true);
  }
  const reads = wasmMode
    ? ["count"]
    : [
        "allowance",
        "balance",
        "authorized",
        "admin",
        "decimals",
        "name",
        "symbol",
      ];
  let i;
  for (const role of Object.values(roles)) {
    i = await product.register(
      role.a,
      wasmMode
        ? { contractId: id }
        : { asset: { kind: "issued", code: asset.code, issuer: asset.issuer } },
    );
    for (const name of reads) role.policies.set(name, { name, mode: "READ" });
    await product.setPolicies(role.a, {
      contractId: id,
      functions: [...role.policies.values()],
    });
  }
  // Initial issuer role transfer is an operator setup step, not an unattended MCP test.
  if (!wasmMode) {
    const setupConfig = {
      ...config,
      signerSecret: issuer.secret(),
      policies: [
        {
          contractId: id,
          function: "set_admin",
          mode: "WRITE",
          principals: ["fixture-setup"],
        },
      ],
    };
    const setupInterface = await ingest(chain, setupConfig, id),
      setupExecutor = new Executor(
        setupConfig,
        chain,
        store,
        environmentSigner(issuer.secret(), Networks.TESTNET),
      );
    const setupResult = await setupExecutor.call(
      setupInterface,
      setupInterface.functions.find((f) => f.sorobanName === "set_admin"),
      { new_admin: roles.admin.address },
      "fixture-setup",
      randomUUID(),
    );
    record("fixture_initial_admin", setupResult);
    assert(setupResult.ok);
  }
  async function call(roleName, name, values = [], expected = true) {
    const role = roles[roleName],
      f = i.inventory.find((m) => m.name === name).signature;
    assert(f, "Declared signature missing");
    const args = Object.fromEntries(
        f.params.map((p, n) => [p.name, values[n]]),
      ),
      write = !reads.includes(name);
    if (write) {
      role.policies.set(name, {
        name,
        mode: "WRITE",
        exactGrant: {
          interfaceHash: i.interfaceHash,
          arguments: args,
          maxCalls: 20,
          maxFee: "3000000000",
          rollingFee: "10000000000",
        },
      });
      await product.setPolicies(role.a, {
        contractId: id,
        functions: [...role.policies.values()],
      });
    }
    const client = new Client({
      name: "orloj-managed-acceptance",
      version: "1",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${http.address().port}/contracts/${id}/mcp`,
          ),
          {
            requestInit: { headers: { authorization: "Bearer " + role.token } },
          },
        ),
      );
      const key = randomUUID(),
        r = await client.callTool({
          name,
          arguments: { ...args, ...(write ? { idempotency_key: key } : {}) },
        });
      let result = r.structuredContent;
      if (write && result.ok) {
        const operation = result.operation_id;
        assert(operation, "Durable operation ID missing");
        for (let n = 0; n < 150; n++) {
          const status = (
            await client.callTool({
              name: "orloj_operation_status",
              arguments: { operation_id: operation },
            })
          ).structuredContent;
          if (
            !["PENDING", "AWAITING_APPROVAL", "PREPARING", "READY"].includes(
              status.result_status,
            )
          ) {
            result = status;
            break;
          }
          await sleep(1000);
        }
        const duplicate = (
          await client.callTool({
            name,
            arguments: { ...args, idempotency_key: key },
          })
        ).structuredContent;
        assert(
          duplicate.operation_id === operation,
          "Duplicate operation changed",
        );
      }
      record(roleName + ":" + name, result);
      if (expected) {
        assert(
          result.ok &&
            (!write || result.result_status === "SUBMITTED_AND_CONFIRMED"),
        );
        if (write) {
          const tx = await chain.getTransaction(result.transaction_hash);
          assert(tx.status === "SUCCESS", "Not confirmed on chain");
        }
      } else
        assert(
          !result.ok && !result.transaction_hash,
          "Unauthorized request was submitted",
        );
      return result;
    } finally {
      await client.close();
    }
  }
  if (wasmMode) {
    const before = (await call("holder", "count")).data;
    await call("holder", "increment");
    assert((await call("holder", "count")).data === before + 1);
    await call("holder", "authorized", [roles.holder.address]);
    await call("holder", "authorized", [issuer.publicKey()], false);
  } else {
    await call("holder", "trust", [roles.holder.address]);
    await call("delegate", "trust", [roles.delegate.address]);
    for (const name of ["name", "symbol", "decimals", "admin"])
      await call("admin", name);
    const auth = await call("admin", "authorized", [roles.holder.address]);
    assert(auth.data === false);
    await call("admin", "set_authorized", [roles.holder.address, true]);
    await call("admin", "set_authorized", [roles.delegate.address, true]);
    await call("admin", "mint", [roles.holder.address, "100000000"]);
    const ledger = await chain.getLatestLedger();
    await call("holder", "approve", [
      roles.holder.address,
      roles.delegate.address,
      "30000000",
      ledger.sequence + 1000,
    ]);
    await call("delegate", "transfer_from", [
      roles.delegate.address,
      roles.holder.address,
      roles.delegate.address,
      "10000000",
    ]);
    assert(
      (
        await call("holder", "allowance", [
          roles.holder.address,
          roles.delegate.address,
        ])
      ).data === "20000000",
    );
    await call("holder", "transfer", [
      roles.holder.address,
      roles.delegate.address,
      "10000000",
    ]);
    await call("holder", "burn", [roles.holder.address, "10000000"]);
    await call("delegate", "burn_from", [
      roles.delegate.address,
      roles.holder.address,
      "10000000",
    ]);
    await call("admin", "clawback", [roles.holder.address, "10000000"]);
    await call("admin", "set_authorized", [roles.holder.address, false]);
    await call(
      "holder",
      "transfer",
      [roles.holder.address, roles.delegate.address, "1"],
      false,
    );
    await call("admin", "set_authorized", [roles.holder.address, true]);
    await call("admin", "set_admin", [roles.delegate.address]);
    await call("admin", "mint", [roles.holder.address, "1"], false);
    await call("delegate", "mint", [roles.holder.address, "1"]);
    assert(
      (await call("holder", "balance", [roles.holder.address])).data ===
        "50000001",
    );
    assert(
      (await call("delegate", "balance", [roles.delegate.address])).data ===
        "20000000",
    );
  }
  evidence.ok = true;
} catch (e) {
  evidence.ok = false;
  evidence.failure = {
    code: e.code ?? "MANAGED_ACCEPTANCE_FAILED",
    message:
      e.message === "Managed acceptance assertion failed"
        ? e.message
        : undefined,
  };
  console.error(JSON.stringify(evidence.failure));
  process.exitCode = 1;
} finally {
  if (product) await product.stop();
  if (http) await new Promise((r) => http.close(r));
  if (signer) await new Promise((r) => signer.close(r));
  evidence.schema = schema; // retained locally for recovery/history; no private signing material is exported.
  await writeFile(
    new URL(
      "../demo-contract/" +
        (wasmMode ? "managed-wasm-evidence" : "managed-calls-evidence") +
        ".json",
      import.meta.url,
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await store.close();
  await base.close();
}
