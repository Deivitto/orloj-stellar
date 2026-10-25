import { it, expect, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Store } from "../src/store.js";
import { Product } from "../src/product.js";
import { signerService } from "../src/managed-signer.js";
import { parseConfig } from "../src/config.js";
import { model, encode } from "../src/codec.js";
import { checkedGrant } from "../src/exact-grant.js";
import type { AgentIdentity } from "../src/product-types.js";
import type { ContractInterface, FunctionModel } from "../src/model.js";
const url = process.env.TEST_DATABASE_URL;
let base: Store,
  store: Store,
  product: Product,
  http: Awaited<ReturnType<typeof signerService>>,
  schema: string,
  identity: AgentIdentity,
  address: string,
  endpoint: string,
  serviceToken: string,
  i: ContractInterface,
  f: FunctionModel;
const args = () => ({ beneficiary: Keypair.random().publicKey(), value: "10" });
beforeEach(async () => {
  if (!url) return;
  schema = "exact_" + randomUUID().replaceAll("-", "");
  base = new Store(url);
  await base.pool.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", "-c search_path=" + schema);
  store = new Store(scoped.toString());
  await store.migrate();
  await store.pool.query(
    "CREATE TABLE agent_ownership(agent_id text PRIMARY KEY,user_id text,instance_id uuid,stellar_policy_revision integer NOT NULL DEFAULT 0);CREATE TABLE mcp_api_key(id text PRIMARY KEY,agent_id text,token text,revoked_at timestamptz,owner_id text,instance_id uuid)",
  );
  identity = {
    agentId: randomUUID(),
    instanceId: randomUUID(),
    ownerId: randomUUID(),
    credentialId: randomUUID(),
  };
  await store.pool.query(
    "INSERT INTO agent_ownership(agent_id,user_id,instance_id) VALUES($1,$2,$3)",
    [identity.agentId, identity.ownerId, identity.instanceId],
  );
  await store.pool.query(
    "INSERT INTO mcp_api_key VALUES($1,$2,$3,NULL,$4,$5)",
    [
      identity.credentialId,
      identity.agentId,
      randomUUID(),
      identity.ownerId,
      identity.instanceId,
    ],
  );
  serviceToken = randomBytes(32).toString("hex");
  http = await signerService(store, randomBytes(32), serviceToken);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  endpoint = "http://127.0.0.1:" + (http.address() as { port: number }).port;
  const c = parseConfig({
    rpcUrl: "https://soroban-testnet.stellar.org",
    databaseUrl: scoped.toString(),
    simulationSource: Keypair.random().publicKey(),
    productMode: true,
    writeMode: true,
    maxFee: "2000000",
  });
  product = new Product(c, {} as never, store, {
    origin: "http://localhost:3000",
    serviceToken,
    signerToken: serviceToken,
    signerUrl: endpoint,
  });
  const wallet = await product.managedWallet(identity);
  address = String(wallet.address);
  f = {
    sorobanName: "adjust",
    mcpToolName: "adjust",
    description: "",
    mode: "WRITE",
    params: Object.entries({
      beneficiary: model({ kind: "Address" }),
      value: model({ kind: "i128" }),
    }).map(([name, type]) => ({
      name,
      type,
      sorobanType: type.sorobanType,
      jsonSchema: type.jsonSchema,
      required: true,
      description: "",
      converterId: type.converterId,
    })),
    returns: model({ kind: "void" }),
    writeAllowed: true,
    simulationSafe: false,
  };
  i = {
    network: "testnet",
    contractId: StrKey.encodeContract(Buffer.alloc(32, 8)),
    sourceKind: "wasm",
    encodingVersion: 5,
    wasmHash: "b".repeat(64),
    interfaceHash: "a".repeat(64),
    generatedAt: new Date().toISOString(),
    functions: [],
    inventory: [
      {
        name: f.sorobanName,
        eligible: true,
        policyStatus: "disabled",
        signature: f,
      },
    ],
    excluded: [],
  };
  await store.save(i);
  await store.pool.query(
    "INSERT INTO stellar_contract_owners VALUES($1,$2,$3)",
    [identity.ownerId, "testnet", i.contractId],
  );
});
afterEach(async () => {
  if (!url) return;
  await product.stop();
  await new Promise<void>((r) => http.close(() => r()));
  await store.close();
  await base.pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await base.close();
});
async function grant(a: ReturnType<typeof args>, extra = {}) {
  await product.setPolicies(identity, {
    contractId: i.contractId,
    functions: [
      {
        name: "adjust",
        mode: "WRITE",
        exactGrant: { interfaceHash: i.interfaceHash, arguments: a, ...extra },
      },
    ],
  });
}
async function enqueue(a: ReturnType<typeof args>, key = randomUUID()) {
  return product.enqueue(identity, i, f, a, key);
}
async function prepare(id: unknown) {
  await store.pool.query(
    "UPDATE stellar_operations SET state='PREPARING',lease_owner=$2,lease_until=now()+interval '60 seconds' WHERE id=$1",
    [id, (product as unknown as { workerId: string }).workerId],
  );
  return product.operation(identity, String(id));
}
async function reserve(o: Awaited<ReturnType<typeof prepare>>) {
  const c = await store.pool.connect();
  try {
    await c.query("BEGIN");
    await product.guard(c, o, true);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
it("bounds exact-call configuration without broadening legacy transfer grants", () => {
  expect(
    checkedGrant({ interfaceHash: "a".repeat(64), arguments: {} }),
  ).toMatchObject({
    maxCalls: 1,
    maxFee: "3000000000",
    rollingFee: "10000000000",
  });
  for (const invalid of [
    { maxFee: "3000000001" },
    { rollingFee: "10000000001" },
    { maxCalls: 0 },
  ])
    expect(() =>
      checkedGrant({
        interfaceHash: "a".repeat(64),
        arguments: {},
        ...invalid,
      }),
    ).toThrow();
});
it.skipIf(!url)(
  "requires exact arguments, current code identity, ownership and credentials",
  async () => {
    const a = args();
    await grant(a);
    expect(
      product.callable(
        i,
        await product.policies(identity),
        (await product.wallets(identity)).find((w) => w.active),
      ).functions,
    ).toHaveLength(1);
    await expect(enqueue({ ...a, value: "11" })).rejects.toThrow();
    await expect(
      product.setPolicies(identity, {
        contractId: i.contractId,
        functions: [
          {
            name: "adjust",
            mode: "WRITE",
            exactGrant: { interfaceHash: "c".repeat(64), arguments: a },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      product.callable(
        { ...i, interfaceHash: "f".repeat(64) },
        await product.policies(identity),
        (await product.wallets(identity)).find((w) => w.active),
      ).functions,
    ).toHaveLength(0);
    const op = await prepare((await enqueue(a)).operation_id);
    await store.pool.query(
      "UPDATE mcp_api_key SET revoked_at=now() WHERE id=$1",
      [identity.credentialId],
    );
    await expect(reserve(op)).rejects.toThrow();
    expect(
      (await store.pool.query("SELECT * FROM stellar_spending")).rowCount,
    ).toBe(0);
  },
);
it.skipIf(!url)(
  "reserves once, serializes concurrent quotas and retains older pending exposure",
  async () => {
    const a = args();
    await grant(a);
    const key = randomUUID(),
      one = await enqueue(a, key);
    expect((await enqueue(a, key)).operation_id).toBe(one.operation_id);
    const op1 = await prepare(one.operation_id),
      op2 = await prepare((await enqueue(a)).operation_id);
    const results = await Promise.allSettled([reserve(op1), reserve(op2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = (await store.pool.query("SELECT * FROM stellar_spending"))
      .rows[0];
    expect(row.fee).toBe("3000000000");
    expect(row.amount).toBe("0");
    await store.pool.query(
      "UPDATE stellar_call_reservations SET created_at=now()-interval '2 days'",
    );
    await grant(a);
    const next = await prepare((await enqueue(a)).operation_id);
    await expect(reserve(next)).rejects.toThrow();
  },
);
it.skipIf(!url)(
  "policy edits do not reset confirmed call counts and fee budgets span methods/revisions",
  async () => {
    const a = args();
    await grant(a);
    const o = await prepare((await enqueue(a)).operation_id);
    await reserve(o);
    await store.pool.query(
      "UPDATE stellar_spending SET state='SETTLED',fee=100,settled_at=now() WHERE operation_id=$1",
      [o.id],
    );
    await grant(a);
    await expect(
      reserve(await prepare((await enqueue(a)).operation_id)),
    ).rejects.toThrow();
    await grant(a, { maxCalls: 2, maxFee: "100", rollingFee: "150" });
    await expect(
      reserve(await prepare((await enqueue(a)).operation_id)),
    ).rejects.toThrow();
  },
);
it.skipIf(!url)(
  "isolated signer refuses changed transactions, missing reservations and revoked policies",
  async () => {
    const a = args();
    await grant(a);
    const o = await prepare((await enqueue(a)).operation_id);
    const wallet = (await product.wallets(identity)).find((w) => w.active)!;
    const tx = (value: string) =>
      new TransactionBuilder(new Account(address, "100"), {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          new Contract(i.contractId).call(
            "adjust",
            encode({ kind: "Address" }, a.beneficiary),
            encode({ kind: "i128" }, value),
          ),
        )
        .setTimeout(60)
        .build();
    const sign = async (value: string) => {
      const r = await fetch(endpoint + "/sign", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-orloj-signer": serviceToken,
        },
        body: JSON.stringify({
          walletId: wallet.id,
          operationId: o.id,
          payload: tx(value).toXdr(),
          opts: { networkPassphrase: Networks.TESTNET, address },
        }),
      });
      return { status: r.status, value: await r.json() };
    };
    expect((await sign("10")).status).toBe(403);
    await reserve(o);
    expect((await sign("11")).status).toBe(403);
    const signed = await sign("10");
    expect(signed.status).toBe(200);
    expect(signed.value.signerAddress).toBe(address);
    await grant(a);
    expect((await sign("10")).status).toBe(403);
  },
);
