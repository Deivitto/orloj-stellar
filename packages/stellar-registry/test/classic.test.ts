import { afterEach, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  rpc,
} from "@stellar/stellar-sdk";
import { randomUUID } from "node:crypto";
import {
  refreshClassicInterfaces,
  classicAsset,
  classicInterface,
  classicOperation,
  classicRead,
  prepareClassic,
} from "../src/classic.js";
import { parseConfig } from "../src/config.js";
import { Executor } from "../src/executor.js";
import { Store } from "../src/store.js";
import { environmentSigner } from "../src/signer.js";
const pair = Keypair.random(),
  id = "classic:stellar-dex",
  principal = "classic-" + randomUUID();
const c = () =>
  parseConfig({
    rpcUrl: "https://soroban-testnet.stellar.org",
    databaseUrl: process.env.TEST_DATABASE_URL ?? "postgres://localhost/test",
    simulationSource: pair.publicKey(),
    writeMode: true,
    signerSecret: pair.secret(),
    maxFee: "10000",
    pollTimeoutMs: 20,
    policies: [
      {
        contractId: id,
        function: "manage_offer",
        mode: "WRITE",
        principals: [principal],
      },
      {
        contractId: id,
        function: "account_balances",
        mode: "READ",
        principals: [principal],
      },
    ],
  });
afterEach(() => vi.restoreAllMocks());
it("identifies classic adapters without fabricated contract addresses, preserving explicit modes", () => {
  const config = c(),
    i = classicInterface(config, id);
  expect(i.sourceKind).toBe("classic_dex");
  expect(i.wasmHash).toBeUndefined();
  expect(i.functions.map((f) => f.sorobanName)).toEqual([
    "account_balances",
    "manage_offer",
  ]);
  expect(() =>
    classicInterface(
      {
        ...config,
        policies: [
          {
            contractId: id,
            function: "manage_offer",
            mode: "READ",
            principals: [principal],
          },
        ],
      },
      id,
    ),
  ).toThrow();
  expect(() => classicAsset("USD:C" + "A".repeat(55))).toThrow();
  expect(classicAsset("native").equals(Asset.native())).toBe(true);
});
it("builds exact bounded classic operations and rejects malformed rational prices, limits and assets", () => {
  const asset = "TEST:" + Keypair.random().publicKey();
  const args = {
    selling: asset,
    buying: "native",
    amount: "10000001",
    price: { n: 1, d: 3 },
    offer_id: "0",
  };
  expect(classicOperation("manage_offer", args).body.type).toBe(
    "manageSellOffer",
  );
  for (const price of [
    { n: 0, d: 1 },
    { n: 1, d: 0 },
    { n: 2147483648, d: 1 },
  ])
    expect(() =>
      classicOperation("manage_offer", { ...args, price }),
    ).toThrow();
  expect(() =>
    classicOperation("manage_offer", {
      ...args,
      amount: "9223372036854775808",
    }),
  ).toThrow();
  expect(() =>
    classicOperation("change_trust", { asset: "native", limit: "1" }),
  ).toThrow();
  expect(() =>
    classicOperation("pool_deposit", {
      pool_id: "00".repeat(32),
      max_amount_a: "1",
      max_amount_b: "1",
      min_price: { n: 2, d: 1 },
      max_price: { n: 1, d: 1 },
    }),
  ).toThrow();
});
it("validates classic read results rather than returning arbitrary Horizon data", async () => {
  const i = classicInterface(c(), id),
    f = i.functions.find((f) => f.sorobanName === "account_balances")!;
  const h = {
    loadAccount: vi.fn(async () => ({
      balances: [
        {
          asset_type: "native",
          balance: "1.0000001",
          buying_liabilities: "0",
          selling_liabilities: "0",
        },
      ],
    })),
  };
  expect(
    await classicRead(c(), f, { account: pair.publicKey() }, h as never),
  ).toEqual([
    {
      asset: "native",
      balance: "10000001",
      buying_liabilities: "0",
      selling_liabilities: "0",
      authorized: true,
    },
  ]);
  h.loadAccount.mockResolvedValue({
    balances: [
      {
        asset_type: "native",
        balance: "1e10",
        buying_liabilities: "0",
        selling_liabilities: "0",
      },
    ],
  });
  await expect(
    classicRead(c(), f, { account: pair.publicKey() }, h as never),
  ).rejects.toThrow();
});
function horizon() {
  const source = Object.assign(new Account(pair.publicKey(), "100"), {
    balances: [
      {
        asset_type: "native",
        balance: "10000.0000000",
        selling_liabilities: "0",
      },
    ],
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    signers: [{ key: pair.publicKey(), weight: 1 }],
    thresholds: { med_threshold: 1 },
  });
  vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
    source as never,
  );
  vi.spyOn(Horizon.Server.prototype, "root").mockResolvedValue({
    network_passphrase: Networks.TESTNET,
  } as never);
  vi.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
  const builder = {
    order() {
      return this;
    },
    limit() {
      return this;
    },
    call: async () => ({ records: [{ base_reserve_in_stroops: 5000000 }] }),
  };
  vi.spyOn(Horizon.Server.prototype, "ledgers").mockReturnValue(
    builder as never,
  );
  return source;
}
it("rejects modified signatures, wrong networks and insufficient source authorization before intent", async () => {
  horizon();
  const config = c(),
    f = classicInterface(config, id).functions.find(
      (f) => f.sorobanName === "manage_offer",
    )!;
  const signer = environmentSigner(pair.secret(), Networks.TESTNET);
  const args = {
    selling: "native",
    buying: "TEST:" + pair.publicKey(),
    amount: "1",
    price: { n: 1, d: 1 },
    offer_id: "0",
  };
  await expect(
    prepareClassic(
      { ...config, network: "mainnet" },
      id,
      f,
      args,
      signer,
      principal,
    ),
  ).rejects.toThrow();
  signer.sign_transaction_envelope = async () => ({
    signedTxXdr: "invalid",
    signerAddress: pair.publicKey(),
  });
  await expect(
    prepareClassic(config, id, f, args, signer, principal),
  ).rejects.toThrow();
});
it.skipIf(!process.env.TEST_DATABASE_URL)(
  "uses the durable intent lock and reconciliation pipeline without Soroban simulation or duplicate sends",
  async () => {
    horizon();
    const config = c(),
      i = classicInterface(config, id),
      f = i.functions.find((f) => f.sorobanName === "manage_offer")!;
    const server = new rpc.Server(config.rpcUrl),
      store = new Store(config.databaseUrl);
    await store.migrate();
    vi.spyOn(server, "getAccount").mockResolvedValue(
      new Account(pair.publicKey(), "100"),
    );
    const simulation = vi
      .spyOn(server, "simulateTransaction")
      .mockRejectedValue(new Error("Classic must not simulate"));
    const send = vi
      .spyOn(server, "sendTransaction")
      .mockImplementation(async (tx) => {
        const a = await store.find(principal, "testnet", "classic-test");
        expect(a?.state).toBe("INTENT");
        expect(a?.transaction_hash).toBe(
          Buffer.from(tx.hash()).toString("hex"),
        );
        return {
          status: "PENDING",
          hash: a!.transaction_hash!,
          latestLedger: 1,
          latestLedgerCloseTime: 1,
        };
      });
    vi.spyOn(server, "getTransaction").mockResolvedValue({
      status: "SUCCESS",
      ledger: 1,
      resultXdr: { feeCharged: 100n },
    } as never);
    const e = new Executor(
      config,
      server,
      store,
      environmentSigner(pair.secret(), Networks.TESTNET),
    );
    try {
      const args = {
        selling: "native",
        buying: "TEST:" + pair.publicKey(),
        amount: "1",
        price: { n: 1, d: 1 },
        offer_id: "0",
      };
      const first = await e.call(i, f, args, principal, "classic-test");
      expect(first).toMatchObject({
        ok: true,
        result_status: "SUBMITTED_AND_CONFIRMED",
        data: null,
      });
      const again = await e.call(i, f, args, principal, "classic-test");
      expect(again.transaction_hash).toBe(first.transaction_hash);
      expect(send).toHaveBeenCalledTimes(1);
      expect(simulation).not.toHaveBeenCalled();
      expect(await e.call(i, f, args, "other", "classic-test")).toMatchObject({
        error_code: "WRITE_NOT_PERMITTED",
      });
    } finally {
      await store.close();
    }
  },
);

it("rejects missing, unauthorized or full buying trustlines and invalid trust limits before signing", async () => {
  const source = horizon(),
    config = c(),
    f = classicInterface(config, id).functions.find(
      (f) => f.sorobanName === "manage_offer",
    )!;
  const asset = "TEST:" + Keypair.random().publicKey(),
    signer = environmentSigner(pair.secret(), Networks.TESTNET);
  const sign = vi.spyOn(signer, "sign_transaction_envelope");
  const args = {
    selling: "native",
    buying: asset,
    amount: "100",
    price: { n: 1, d: 1 },
    offer_id: "0",
  };
  await expect(
    prepareClassic(config, id, f, args, signer, principal),
  ).rejects.toThrow("trustline");
  const b = {
    asset_type: "credit_alphanum4",
    asset_code: "TEST",
    asset_issuer: asset.split(":")[1],
    balance: "0.0000000",
    limit: "1.0000000",
    buying_liabilities: "0",
    selling_liabilities: "0",
    is_authorized: false,
  };
  (source.balances as unknown[]).push(b);
  await expect(
    prepareClassic(config, id, f, args, signer, principal),
  ).rejects.toThrow("not authorized");
  b.is_authorized = true;
  b.buying_liabilities = "1.0000000";
  await expect(
    prepareClassic(config, id, f, args, signer, principal),
  ).rejects.toThrow("balance");
  expect(sign).not.toHaveBeenCalled();
});
it("releases only the verified replaced offer liabilities for a fully encumbered update", async () => {
  const source = horizon(),
    config = c(),
    f = classicInterface(config, id).functions.find(
      (f) => f.sorobanName === "manage_offer",
    )!;
  source.balances[0].balance = "10.0000000";
  source.balances[0].selling_liabilities = "9.0000000";
  source.subentry_count = 1;
  const offer = {
    id: "42",
    seller: pair.publicKey(),
    selling: { asset_type: "native" },
    buying: {
      asset_type: "credit_alphanum4",
      asset_code: "TEST",
      asset_issuer: pair.publicKey(),
    },
    amount: "9.0000000",
    price_r: { n: 1, d: 1 },
  };
  vi.spyOn(Horizon.Server.prototype, "offers").mockReturnValue({
    offer: () => ({ call: async () => offer }),
  } as never);
  const signer = environmentSigner(pair.secret(), Networks.TESTNET),
    sign = vi.spyOn(signer, "sign_transaction_envelope");
  const args = {
    selling: "native",
    buying: "TEST:" + pair.publicKey(),
    amount: "50000000",
    price: { n: 1, d: 1 },
    offer_id: "42",
  };
  expect(
    (await prepareClassic(config, id, f, args, signer, principal)).operations,
  ).toHaveLength(1);
  expect(sign).toHaveBeenCalledTimes(1);
  offer.seller = Keypair.random().publicKey();
  sign.mockClear();
  await expect(
    prepareClassic(config, id, f, args, signer, principal),
  ).rejects.toThrow("Authentication");
  expect(sign).not.toHaveBeenCalled();
});
it("rejects trustline reductions and underfunded pool deposits before signing", async () => {
  const source = horizon(),
    config = c(),
    asset = "TEST:" + Keypair.random().publicKey();
  const signer = environmentSigner(pair.secret(), Networks.TESTNET),
    sign = vi.spyOn(signer, "sign_transaction_envelope");
  (source.balances as unknown[]).push({
    asset_type: "credit_alphanum4",
    asset_code: "TEST",
    asset_issuer: asset.split(":")[1],
    balance: "1.0000000",
    limit: "2.0000000",
    buying_liabilities: "0.5000000",
    selling_liabilities: "0",
    is_authorized: true,
  });
  config.policies.push({
    contractId: id,
    function: "change_trust",
    mode: "WRITE",
    principals: [principal],
  });
  const trust = classicInterface(config, id).functions.find(
    (f) => f.sorobanName === "change_trust",
  )!;
  await expect(
    prepareClassic(
      config,
      id,
      trust,
      { asset, limit: "10000000" },
      signer,
      principal,
    ),
  ).rejects.toThrow("balance");
  const amm = "classic:stellar-amm",
    poolId = "00".repeat(32);
  config.policies.push({
    contractId: amm,
    function: "pool_deposit",
    mode: "WRITE",
    principals: [principal],
  });
  const pool = classicInterface(config, amm).functions.find(
    (f) => f.sorobanName === "pool_deposit",
  )!;
  vi.spyOn(Horizon.Server.prototype, "liquidityPools").mockReturnValue({
    liquidityPoolId: () => ({
      call: async () => ({
        reserves: [
          { asset: "native", amount: "1" },
          { asset, amount: "1" },
        ],
        total_shares: "1",
      }),
    }),
  } as never);
  const args = {
    pool_id: poolId,
    max_amount_a: "10000000",
    max_amount_b: "10000000",
    min_price: { n: 1, d: 1 },
    max_price: { n: 1, d: 1 },
  };
  await expect(
    prepareClassic(config, amm, pool, args, signer, principal),
  ).rejects.toThrow("trustline");
  (source.balances as unknown[]).push({
    asset_type: "liquidity_pool_shares",
    liquidity_pool_id: poolId,
    balance: "1.0000000",
    limit: "100.0000000",
  });
  await expect(
    prepareClassic(
      config,
      amm,
      pool,
      { ...args, max_amount_a: "100000000000000" },
      signer,
      principal,
    ),
  ).rejects.toThrow("balance");
  expect(sign).not.toHaveBeenCalled();
});

it("refreshes stale registered adapter schemas without registering markets or changing policy", async () => {
  const current = classicInterface(c(), id),
    cache = new Map<string, ReturnType<typeof classicInterface>>([
      [id, { ...current, interfaceHash: "0".repeat(64) }],
    ]),
    saved: ReturnType<typeof classicInterface>[] = [];
  const store = {
    get: async (_network: string, key: string) => cache.get(key),
    save: async (i: ReturnType<typeof classicInterface>) => {
      cache.set(i.contractId, i);
      saved.push(i);
    },
  };
  await refreshClassicInterfaces(store, c());
  expect(saved).toHaveLength(1);
  expect(saved[0].interfaceHash).toBe(current.interfaceHash);
  expect(saved[0].inventory?.map((m) => m.name)).toEqual(
    current.inventory?.map((m) => m.name),
  );
  expect(cache.has("classic:stellar-amm")).toBe(false);
  await refreshClassicInterfaces(store, c());
  expect(saved).toHaveLength(1);
});
