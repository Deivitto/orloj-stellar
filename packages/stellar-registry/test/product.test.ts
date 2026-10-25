import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { Keypair, Asset, Networks, rpc, hash } from "@stellar/stellar-sdk";
import { Store } from "../src/store.js";
import { Product } from "../src/product.js";
import { parseConfig } from "../src/config.js";
import { assetInterface } from "../src/assets.js";
import {
  encryptKey,
  decryptKey,
  signerService,
  rotateMasterKey,
  initializeEpoch,
} from "../src/managed-signer.js";
import type { AgentIdentity, ProductOperation } from "../src/product-types.js";
import { once } from "node:events";
const url = process.env.TEST_DATABASE_URL;
const schema = "product_" + randomUUID().replaceAll("-", "");
let base: Store, store: Store;
const testMaster = randomBytes(32);
const source = Keypair.random(),
  recipient = Keypair.random().publicKey(),
  owner = randomUUID(),
  agent = randomUUID(),
  instance = randomUUID(),
  credential = randomUUID(),
  token = randomUUID();
const identity: AgentIdentity = {
  agentId: agent,
  instanceId: instance,
  ownerId: owner,
  credentialId: credential,
};
const config = parseConfig({
  rpcUrl: "https://soroban-testnet.stellar.org",
  databaseUrl: url ?? "postgres://localhost/test",
  simulationSource: source.publicKey(),
  productMode: true,
  writeMode: true,
  maxFee: "20",
});
const server = {} as rpc.Server;
let product: Product;
const contractId = Asset.native().contractId(Networks.TESTNET);
beforeAll(async () => {
  if (!url) return;
  base = new Store(url);
  await base.pool.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  store = new Store(scoped.toString());
  await store.migrate();
  await store.pool.query(
    "CREATE TABLE agent_ownership(agent_id text PRIMARY KEY,user_id text,instance_id uuid,stellar_policy_revision integer NOT NULL DEFAULT 0);CREATE TABLE mcp_api_key(id text PRIMARY KEY,agent_id text,token text,revoked_at timestamptz,owner_id text,instance_id uuid)",
  );
  await store.pool.query(
    "INSERT INTO agent_ownership(agent_id,user_id,instance_id) VALUES($1,$2,$3)",
    [agent, owner, instance],
  );
  await store.pool.query(
    "INSERT INTO mcp_api_key(id,agent_id,token,owner_id,instance_id) VALUES($1,$2,$3,$4,$5)",
    [credential, agent, token, owner, instance],
  );
  product = new Product(config, server, store, {
    origin: "http://localhost:3000",
    serviceToken: "s".repeat(32),
    signerUrl: "http://localhost:3005",
    signerToken: "t".repeat(32),
  });
  await store.save(assetInterface(config, contractId, 29));
  await store.pool.query(
    "INSERT INTO stellar_contract_owners VALUES($1,$2,$3)",
    [owner, "testnet", contractId],
  );
});
afterAll(async () => {
  if (!url) return;
  await product.stop();
  await store.close();
  await base.pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await base.close();
});
it("binds encrypted signing keys to agent identity and key version", () => {
  const key = randomBytes(32),
    secret = Keypair.random().secret();
  const c = encryptKey(secret, key, "agent:testnet:1");
  expect(decryptKey(c, key, "agent:testnet:1")).toBe(secret);
  expect(() => decryptKey(c, key, "other:testnet:1")).toThrow("signing");
  expect(encryptKey(secret, key, "agent:testnet:1").iv).not.toBe(c.iv);
});
it.skipIf(!url)(
  "shares current app identity, rejects cross-owner access and revoked credentials",
  async () => {
    expect(await product.identity(token)).toEqual(identity);
    await expect(product.owner("stranger", agent)).rejects.toThrow();
    await store.pool.query(
      "UPDATE mcp_api_key SET revoked_at=now() WHERE id=$1",
      [credential],
    );
    expect(await product.identity(token)).toBeUndefined();
    await store.pool.query(
      "UPDATE mcp_api_key SET revoked_at=NULL WHERE id=$1",
      [credential],
    );
  },
);
it.skipIf(!url)(
  "links a wallet using a one-use expiring owner-bound challenge",
  async () => {
    const kp = Keypair.random(),
      challenge = await product.challenge(identity, kp.publicKey());
    const signature = Buffer.from(
      kp.sign(
        hash(
          Buffer.concat([
            Buffer.from("Stellar Signed Message:\n"),
            Buffer.from(challenge.message),
          ]),
        ),
      ),
    ).toString("base64");
    await product.link(identity, challenge.id, signature);
    expect(
      (await product.wallets(identity)).find((w) => w.active)?.address,
    ).toBe(kp.publicKey());
    await expect(
      product.link(identity, challenge.id, signature),
    ).rejects.toThrow();
  },
);
it.skipIf(!url)(
  "creates a managed wallet once without exporting its private key",
  async () => {
    const token = "t".repeat(32);
    const http = await signerService(store, testMaster, token);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    try {
      const endpoint = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
      const invoke = () =>
        fetch(endpoint + "/wallet", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-orloj-signer": token,
          },
          body: JSON.stringify({
            agentId: agent,
            instanceId: instance,
            ownerId: owner,
          }),
        }).then((r) => r.json());
      const a = await invoke(),
        b = await invoke();
      expect(a).toEqual(b);
      expect(Object.keys(a).sort()).toEqual(["address", "id"]);
      await product.activate(identity, a.id);
      expect(
        (await product.wallets(identity)).find((w) => w.active)?.mode,
      ).toBe("managed");
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);
const limits = {
  recipients: [recipient],
  perTransfer: "100",
  rollingAmount: "100",
  rollingFee: "100",
};
async function grant() {
  await product.setPolicies(identity, {
    contractId,
    functions: [{ name: "transfer", mode: "WRITE", limits }],
  });
}
async function enqueue(amount: string, key: string = randomUUID()) {
  const i = (await store.get("testnet", contractId))!,
    policies = await product.policies(identity),
    f = product
      .interface(i, policies)
      .functions.find((f) => f.sorobanName === "transfer")!,
    wallet = (await product.wallets(identity)).find((w) => w.active)!;
  return product.enqueue(
    identity,
    i,
    f,
    { from: wallet.address, to_mux: recipient, amount },
    key,
  );
}
async function prepare(id: string) {
  await store.pool.query(
    "UPDATE stellar_operations SET state='PREPARING',lease_owner=$2,lease_until=now()+interval '30 seconds' WHERE id=$1",
    [id, (product as unknown as { workerId: string }).workerId],
  );
  return product.operation(identity, id);
}
async function reserve(o: ProductOperation) {
  const client = await store.pool.connect();
  try {
    await client.query("BEGIN");
    await product.guard(client, o, true);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
it.skipIf(!url)(
  "requires explicit policy/limits, rejects recipients and amounts, and deduplicates requests",
  async () => {
    await grant();
    const key = randomUUID(),
      a = await enqueue("10", key),
      b = await enqueue("10", key);
    expect(a.operation_id).toBe(b.operation_id);
    await expect(enqueue("11", key)).rejects.toThrow("idempotency");
    await expect(enqueue("101")).rejects.toThrow();
    const i = (await store.get("testnet", contractId))!,
      f = product.interface(i, await product.policies(identity)).functions[0],
      w = (await product.wallets(identity)).find((w) => w.active)!;
    await expect(
      product.enqueue(
        identity,
        i,
        f,
        { from: w.address, to_mux: source.publicKey(), amount: "1" },
        randomUUID(),
      ),
    ).rejects.toThrow();
  },
);
it.skipIf(!url)(
  "reserves pending exposure atomically across concurrent requests and releases only terminal failures",
  async () => {
    const a = await prepare(String((await enqueue("60")).operation_id)),
      b = await prepare(String((await enqueue("60")).operation_id));
    const results = await Promise.allSettled([reserve(a), reserve(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const used = (
      await store.pool.query(
        "SELECT * FROM stellar_spending WHERE state='RESERVED'",
      )
    ).rows;
    expect(used).toHaveLength(1);
    await product.settle(used[0].operation_id === a.id ? a : b, {
      result_status: "TIMEOUT",
    });
    expect(
      (
        await store.pool.query(
          "SELECT * FROM stellar_spending WHERE state='RESERVED'",
        )
      ).rowCount,
    ).toBe(1);
    await product.settle(used[0].operation_id === a.id ? a : b, {
      result_status: "FAILED_ON_CHAIN",
      fee_charged: "3",
    });
    expect(
      (
        await store.pool.query(
          "SELECT amount::text,fee::text FROM stellar_spending WHERE operation_id=$1",
          [used[0].operation_id],
        )
      ).rows[0],
    ).toEqual({ amount: "0", fee: "3" });
  },
);
it.skipIf(!url)(
  "blocks intent after revocation, wallet changes, policy replacement and agent ownership changes",
  async () => {
    const o = await prepare(String((await enqueue("5")).operation_id));
    await reserve(o);
    const check = async () => {
      const client = await store.pool.connect();
      try {
        await client.query("BEGIN");
        await product.guard(client, o, false);
        await client.query("ROLLBACK");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    };
    await store.pool.query(
      "UPDATE mcp_api_key SET revoked_at=now() WHERE id=$1",
      [credential],
    );
    await expect(check()).rejects.toThrow();
    await store.pool.query(
      "UPDATE mcp_api_key SET revoked_at=NULL WHERE id=$1",
      [credential],
    );
    await store.pool.query(
      "UPDATE agent_ownership SET user_id=$2 WHERE agent_id=$1",
      [agent, "other"],
    );
    await expect(check()).rejects.toThrow();
    await store.pool.query(
      "UPDATE agent_ownership SET user_id=$2 WHERE agent_id=$1",
      [agent, owner],
    );
    await grant();
    await expect(check()).rejects.toThrow();
  },
);
it.skipIf(!url)(
  "cancels a queued write and denies operation status to another agent instance",
  async () => {
    const r = await enqueue("1");
    await product.approve(identity, String(r.operation_id), false);
    expect(
      (await product.status(identity, String(r.operation_id))).result_status,
    ).toBe("CANCELLED");
    await expect(
      product.status(
        { ...identity, instanceId: randomUUID() },
        String(r.operation_id),
      ),
    ).rejects.toThrow();
  },
);
it.skipIf(!url)(
  "serves instance-scoped app credentials through real HTTP MCP discovery, reads and async writes",
  async () => {
    const { Account, SorobanDataBuilder, xdr } =
      await import("@stellar/stellar-sdk");
    const { Executor } = await import("../src/executor.js");
    const { httpServer } = await import("../src/gateway.js");
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    Object.assign(server, {
      getNetwork: async () => ({
        passphrase: Networks.TESTNET,
        protocolVersion: "29",
      }),
      getContractInstance: async () => ({
        executable: { type: "contractExecutableStellarAsset" },
      }),
      getAccount: async (address: string) => new Account(address, "1"),
      simulateTransaction: vi.fn(async () => ({
        id: "test",
        _parsed: true,
        latestLedger: 1,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "1",
        result: {
          auth: [],
          retval: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 55n })),
        },
      })),
    });
    await product.setPolicies(identity, {
      contractId,
      functions: [
        { name: "balance", mode: "READ" },
        { name: "transfer", mode: "WRITE", limits },
      ],
    });
    const http = httpServer(new Executor(config, server, store), product);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const endpoint = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const client = new Client({
      name: "product-integration",
      version: "1.0.0",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(endpoint + `/contracts/${contractId}/mcp`),
          { requestInit: { headers: { authorization: "Bearer " + token } } },
        ),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "balance",
          "transfer",
          "orloj_operation_status",
        ]),
      );
      const balance = await client.callTool({
        name: "balance",
        arguments: { addr: source.publicKey() },
      });
      expect(balance.structuredContent).toMatchObject({
        ok: true,
        data: "55",
        result_status: "SIMULATED",
      });
      const wallet = (await product.wallets(identity)).find((w) => w.active)!;
      const write = await client.callTool({
        name: "transfer",
        arguments: {
          from: wallet.address,
          to_mux: recipient,
          amount: "1",
          idempotency_key: randomUUID(),
        },
      });
      expect(write.structuredContent).toMatchObject({
        ok: true,
        result_status: "PENDING",
      });
      const status = await client.callTool({
        name: "orloj_operation_status",
        arguments: {
          operation_id: (write.structuredContent as Record<string, unknown>)
            .operation_id,
        },
      });
      expect(status.structuredContent).toMatchObject({
        operation_id: (write.structuredContent as Record<string, unknown>)
          .operation_id,
      });
      const manifest = await fetch(endpoint + "/mcp", {
        headers: { authorization: "Bearer " + token },
      }).then((r) => r.json());
      expect(manifest[0].name).toBe(`stellar_testnet_${contractId}`);
      await store.pool.query(
        "UPDATE mcp_api_key SET revoked_at=now() WHERE id=$1",
        [credential],
      );
      const revoked = await fetch(endpoint + "/mcp", {
        headers: { authorization: "Bearer " + token },
      });
      expect(revoked.status).toBe(403);
      await store.pool.query(
        "UPDATE mcp_api_key SET revoked_at=NULL WHERE id=$1",
        [credential],
      );
    } finally {
      await client.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
);
it.skipIf(!url)(
  "keeps spending reserved for a post-intent error and settles only after authoritative confirmation",
  async () => {
    const { Executor } = await import("../src/executor.js");
    const { agentPrincipal } = await import("../src/product-types.js");
    const { xdr } = await import("@stellar/stellar-sdk");
    const o = await prepare(String((await enqueue("1")).operation_id));
    const wallet = (await product.wallets(identity)).find((w) => w.active)!;
    const spy = vi
      .spyOn(Executor.prototype, "call")
      .mockImplementation(async () => {
        await store.lock("testnet", wallet.address, async (client) => {
          const attempt = await store.begin(client, {
            principal: agentPrincipal(identity),
            network: "testnet",
            idempotency_key: o.idempotency_key,
            fingerprint: "fault",
            source_account: wallet.address,
            request: {
              returns: o.function_model.returns,
              network: "testnet",
              contract_id: contractId,
              function_name: "transfer",
            },
          });
          await store.intent(client, attempt.id, "ambiguous-hash", "3", "1000");
        });
        return {
          ok: false,
          error_code: "INTERNAL_ERROR",
          transaction_hash: "ambiguous-hash",
        };
      });
    try {
      await product.run(o);
    } finally {
      spy.mockRestore();
    }
    expect((await product.status(identity, o.id)).result_status).toBe(
      "TIMEOUT",
    );
    expect(
      (
        await store.pool.query(
          "SELECT state FROM stellar_spending WHERE operation_id=$1",
          [o.id],
        )
      ).rows[0].state,
    ).toBe("RESERVED");
    Object.assign(server, {
      getTransaction: async () => ({
        status: "SUCCESS",
        ledger: 2,
        resultXdr: { feeCharged: 4n },
        returnValue: xdr.ScVal.scvVoid(),
      }),
    });
    expect(await product.reconcile(identity, o.id)).toMatchObject({
      ok: true,
      result_status: "SUBMITTED_AND_CONFIRMED",
    });
    expect(
      (
        await store.pool.query(
          "SELECT state,amount::text,fee::text FROM stellar_spending WHERE operation_id=$1",
          [o.id],
        )
      ).rows[0],
    ).toEqual({ state: "SETTLED", amount: "1", fee: "4" });
  },
);
it.skipIf(!url)(
  "rolls back interrupted-operation classification if reservation recovery fails",
  async () => {
    await grant();
    const queued = await enqueue("1", "recovery-atomic");
    const o = await prepare(String(queued.operation_id));
    await reserve(o);
    await store.pool.query(
      "UPDATE stellar_operations SET lease_until=now()-interval '1 minute' WHERE id=$1",
      [o.id],
    );
    const connect = store.pool.connect.bind(store.pool);
    const client = await connect();
    const query = client.query.bind(client);
    let injected = false;
    const queryMock = vi.spyOn(client, "query").mockImplementation(((
      ...args: unknown[]
    ) => {
      if (!injected && String(args[0]).startsWith("UPDATE stellar_spending")) {
        injected = true;
        return Promise.reject(new Error("database interruption"));
      }
      return (query as (...args: unknown[]) => unknown)(...args);
    }) as typeof client.query);
    const connectMock = vi
      .spyOn(store.pool, "connect")
      .mockResolvedValue(client as never);
    try {
      await expect(product.recoverExpired()).rejects.toThrow(
        "database interruption",
      );
    } finally {
      queryMock.mockRestore();
      connectMock.mockRestore();
    }
    expect((await product.operation(identity, o.id)).state).toBe("PREPARING");
    expect(
      (
        await store.pool.query(
          "SELECT state FROM stellar_spending WHERE operation_id=$1",
          [o.id],
        )
      ).rows[0].state,
    ).toBe("RESERVED");
    await product.recoverExpired();
    expect((await product.operation(identity, o.id)).state).toBe("INTERRUPTED");
    expect(
      (
        await store.pool.query(
          "SELECT state FROM stellar_spending WHERE operation_id=$1",
          [o.id],
        )
      ).rows[0].state,
    ).toBe("RELEASED");
  },
);
it.skipIf(!url)(
  "does not inherit attempt hashes or operation access when an agent ID is reused",
  async () => {
    const { agentPrincipal } = await import("../src/product-types.js");
    const old = await enqueue("1", "reused-id-key");
    const wallet = (await product.wallets(identity)).find((w) => w.active)!;
    await store.lock("testnet", wallet.address, async (client) => {
      const a = await store.begin(client, {
        principal: agentPrincipal(identity),
        network: "testnet",
        idempotency_key: "reused-id-key",
        fingerprint: "old",
        source_account: wallet.address,
        request: {},
      });
      await store.intent(client, a.id, "old-instance-hash", "4", "1000");
    });
    const next = {
      ...identity,
      instanceId: randomUUID(),
      credentialId: randomUUID(),
    };
    await store.pool.query(
      "UPDATE agent_ownership SET instance_id=$2 WHERE agent_id=$1",
      [agent, next.instanceId],
    );
    await store.pool.query(
      "INSERT INTO mcp_api_key(id,agent_id,token,owner_id,instance_id) VALUES($1,$2,$3,$4,$5)",
      [next.credentialId, agent, "new-instance-token", owner, next.instanceId],
    );
    await store.pool.query(
      "INSERT INTO stellar_wallets(id,agent_id,instance_id,owner_id,network,mode,address,active) VALUES($1,$2,$3,$4,'testnet','managed',$5,true)",
      [
        randomUUID(),
        agent,
        next.instanceId,
        owner,
        Keypair.random().publicKey(),
      ],
    );
    await product.setPolicies(next, {
      contractId,
      functions: [{ name: "transfer", mode: "WRITE", limits }],
    });
    const i = (await store.get("testnet", contractId))!,
      f = product.interface(i, await product.policies(next)).functions[0],
      w = (await product.wallets(next)).find((w) => w.active)!;
    const queued = await product.enqueue(
      next,
      i,
      f,
      { from: w.address, to_mux: recipient, amount: "1" },
      "reused-id-key",
    );
    expect(queued.operation_id).not.toBe(old.operation_id);
    expect(
      await store.find(agentPrincipal(next), "testnet", "reused-id-key"),
    ).toBeUndefined();
    expect(await product.identity(token)).toBeUndefined();
    await expect(
      product.status(next, String(old.operation_id)),
    ).rejects.toThrow();
  },
);
it.skipIf(!url)(
  "requires a fresh post-expiry account snapshot and preserves legacy ambiguous reservations",
  async () => {
    const { agentPrincipal } = await import("../src/product-types.js");
    const { xdr } = await import("@stellar/stellar-sdk");
    const a = (await product.identity("new-instance-token"))!;
    const make = async (key: string, metadata = true) => {
      const i = (await store.get("testnet", contractId))!,
        f = product
          .interface(i, await product.policies(a))
          .functions.find((f) => f.sorobanName === "transfer")!,
        wallet = (await product.wallets(a)).find((w) => w.active)!;
      const queued = await product.enqueue(
        a,
        i,
        f,
        { from: wallet.address, to_mux: recipient, amount: "1" },
        key,
      );
      const id = String(queued.operation_id);
      await store.pool.query(
        "UPDATE stellar_operations SET state='PREPARING',lease_owner=$2,lease_until=now()+interval '30 seconds' WHERE id=$1",
        [id, (product as unknown as { workerId: string }).workerId],
      );
      const o = await product.operation(a, id);
      await reserve(o);
      await store.lock("testnet", wallet.address, async (client) => {
        const attempt = await store.begin(client, {
          principal: agentPrincipal(a),
          network: "testnet",
          idempotency_key: key,
          fingerprint: key,
          source_account: wallet.address,
          request: { returns: f.returns },
        });
        if (metadata) await store.intent(client, attempt.id, key, "10", "1000");
        else await store.update(attempt.id, "INTENT", undefined, key);
      });
      return { id, wallet };
    };
    const current = await make("expiry-proof");
    const account = new xdr.AccountEntry({
      accountId: Keypair.fromPublicKey(current.wallet.address).xdrAccountId(),
      balance: 100000000n,
      seqNum: 9n,
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: new Uint8Array(4),
      signers: [],
      ext: xdr.AccountEntryExt.v0(),
    });
    Object.assign(server, {
      getTransaction: async () => ({ status: "NOT_FOUND" }),
      getNetwork: async () => ({
        passphrase: Networks.TESTNET,
        protocolVersion: "29",
      }),
      getLatestLedger: async () => ({ sequence: 100 }),
      getLedgers: async () => ({
        ledgers: [{ sequence: 100, ledgerCloseTime: "2000" }],
      }),
      getLedgerEntries: async () => ({
        latestLedger: 99,
        entries: [{ val: xdr.LedgerEntryData.account(account) }],
      }),
    });
    expect(await product.reconcile(a, current.id, true)).toMatchObject({
      result_status: "TIMEOUT",
    });
    expect(
      (
        await store.pool.query(
          "SELECT state FROM stellar_spending WHERE operation_id=$1",
          [current.id],
        )
      ).rows[0].state,
    ).toBe("RESERVED");
    Object.assign(server, {
      getLedgerEntries: async () => ({
        latestLedger: 100,
        entries: [{ val: xdr.LedgerEntryData.account(account) }],
      }),
    });
    expect(await product.reconcile(a, current.id, true)).toMatchObject({
      result_status: "EXPIRED_UNSUBMITTED",
    });
    expect(
      (
        await store.pool.query(
          "SELECT state FROM stellar_spending WHERE operation_id=$1",
          [current.id],
        )
      ).rows[0].state,
    ).toBe("RELEASED");
    const legacy = await make("legacy-no-proof", false);
    expect(await product.reconcile(a, legacy.id, true)).toMatchObject({
      result_status: "TIMEOUT",
    });
    expect(
      (
        await store.pool.query(
          "SELECT state FROM stellar_spending WHERE operation_id=$1",
          [legacy.id],
        )
      ).rows[0].state,
    ).toBe("RESERVED");
  },
);

it.skipIf(!url)(
  "rekeys encrypted wallets atomically and refuses old master keys without replacing wallet identities",
  async () => {
    const before = (
      await store.pool.query(
        "SELECT * FROM stellar_wallets WHERE encrypted_key IS NOT NULL",
      )
    ).rows;
    const next = randomBytes(32);
    const rotated = await rotateMasterKey(store, testMaster, next);
    expect(rotated.wallets).toBe(before.length);
    expect(rotated.key_version).toBe(2);
    await expect(initializeEpoch(store, testMaster)).rejects.toThrow();
    expect(await initializeEpoch(store, next)).toBe(2);
    for (const old of before) {
      const row = (
        await store.pool.query("SELECT * FROM stellar_wallets WHERE id=$1", [
          old.id,
        ])
      ).rows[0];
      expect(row.address).toBe(old.address);
      expect(row.encrypted_key.iv).not.toBe(old.encrypted_key.iv);
      expect(
        Keypair.fromSecret(
          decryptKey(
            row.encrypted_key,
            next,
            `${row.agent_id}:${row.instance_id}:testnet:2`,
          ),
        ).publicKey(),
      ).toBe(row.address);
    }
  },
);
