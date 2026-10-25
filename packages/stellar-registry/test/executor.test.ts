import { it, expect, vi, afterEach } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { randomUUID } from "node:crypto";
import { Executor } from "../src/executor.js";
import { Store } from "../src/store.js";
import { parseConfig } from "../src/config.js";
import { model } from "../src/codec.js";
import { wasmHash } from "../src/ingestion.js";
import { environmentSigner } from "../src/signer.js";
import type { ContractInterface, FunctionModel } from "../src/model.js";
const database = process.env.TEST_DATABASE_URL;
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
function setup(write = false) {
  const kp = Keypair.random(),
    id = StrKey.encodeContract(Buffer.alloc(32, 1)),
    principal = randomUUID();
  const c = parseConfig({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    databaseUrl: database ?? "postgres://localhost/test",
    simulationSource: kp.publicKey(),
    writeMode: write,
    signerSecret: write ? kp.secret() : undefined,
    maxFee: "1000000",
    pollTimeoutMs: 20,
    policies: [
      {
        contractId: id,
        function: "count",
        mode: write ? "WRITE" : "READ",
        principals: [principal],
      },
    ],
  });
  const f: FunctionModel = {
    sorobanName: "count",
    mcpToolName: "count",
    description: "",
    mode: write ? "WRITE" : "READ",
    params: [],
    returns: model({ kind: "u32" }),
    simulationSafe: false,
    writeAllowed: write,
  };
  const wasm = new Uint8Array([1, 2, 3]);
  const i: ContractInterface = {
    network: "testnet",
    contractId: id,
    wasmHash: wasmHash(wasm),
    functions: [f],
    excluded: [],
    generatedAt: new Date().toISOString(),
  };
  const server = new rpc.Server(c.rpcUrl);
  vi.spyOn(server, "getContractWasmByContractId").mockResolvedValue(wasm);
  vi.spyOn(server, "getAccount").mockImplementation(
    async () => new Account(kp.publicKey(), "100"),
  );
  const sim = () => ({
    id: "1",
    latestLedger: 100,
    events: [],
    _parsed: true,
    minResourceFee: "1000",
    transactionData: new SorobanDataBuilder().setResourceFee("1000"),
    result: {
      auth: [] as xdr.SorobanAuthorizationEntry[],
      retval: xdr.ScVal.scvU32(1),
    },
  });
  vi.spyOn(server, "simulateTransaction").mockImplementation(async () => sim());
  const send = vi.spyOn(server, "sendTransaction").mockResolvedValue({
    status: "PENDING",
    hash: "unused",
    latestLedger: 100,
    latestLedgerCloseTime: 1,
  });
  vi.spyOn(server, "getTransaction").mockResolvedValue({
    status: "SUCCESS",
    ledger: 101,
    resultXdr: { feeCharged: 1100n },
    returnValue: xdr.ScVal.scvU32(1),
  } as rpc.Api.GetTransactionResponse);
  const store = new Store(c.databaseUrl);
  stores.push(store);
  const executor = new Executor(
    c,
    server,
    store,
    write ? environmentSigner(kp.secret(), Networks.TESTNET) : undefined,
  );
  return { executor, server, store, principal, i, f, send, sim };
}
it("simulates and strictly decodes without signing or submitting", async () => {
  const x = setup();
  const result = await x.executor.call(x.i, x.f, {}, x.principal);
  expect(result).toMatchObject({
    ok: true,
    result_status: "SIMULATED",
    data: 1,
  });
  expect(x.send).not.toHaveBeenCalled();
});
it("rejects authorization, malformed arguments, stale code and failed simulations", async () => {
  const x = setup();
  const sim = x.sim();
  sim.result.auth = [{} as xdr.SorobanAuthorizationEntry];
  vi.mocked(x.server.simulateTransaction).mockResolvedValue(sim);
  expect(await x.executor.call(x.i, x.f, {}, x.principal)).toMatchObject({
    error_code: "AUTHORIZATION_REQUIRED",
  });
  expect(
    await x.executor.call(x.i, x.f, { extra: 1 }, x.principal),
  ).toMatchObject({ error_code: "INVALID_ARGUMENT" });
  vi.mocked(x.server.simulateTransaction).mockRejectedValue(
    new Error("RPC SECRET"),
  );
  expect(await x.executor.call(x.i, x.f, {}, x.principal)).toMatchObject({
    error_code: "SIMULATION_FAILED",
  });
  x.i.wasmHash = "different";
  expect(await x.executor.call(x.i, x.f, {}, x.principal)).toMatchObject({
    error_code: "STALE_INTERFACE",
  });
  expect(x.send).not.toHaveBeenCalled();
});
it.skipIf(!database)(
  "signs only after simulation, persists before single send, and deduplicates concurrent calls",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    x.send.mockImplementation(async (tx) => {
      const a = await x.store.find(x.principal, "testnet", "key");
      expect(a?.state).toBe("INTENT");
      expect(a?.transaction_hash).toBe(Buffer.from(tx.hash()).toString("hex"));
      return {
        status: "PENDING",
        hash: a!.transaction_hash!,
        latestLedger: 100,
        latestLedgerCloseTime: 1,
      };
    });
    const results = await Promise.all([
      x.executor.call(x.i, x.f, {}, x.principal, "key"),
      x.executor.call(x.i, x.f, {}, x.principal, "key"),
    ]);
    for (const r of results)
      expect(r).toMatchObject({
        ok: true,
        result_status: "SUBMITTED_AND_CONFIRMED",
        data: 1,
      });
    expect(x.send).toHaveBeenCalledTimes(1);
    const simCalls = vi.mocked(x.server.simulateTransaction).mock.calls;
    expect(simCalls.at(-1)?.[2]).toBe("enforce");
  },
);
it.skipIf(!database)(
  "reconciles ambiguous send and timeout without sending again",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    x.send.mockRejectedValue(new Error("lost response"));
    vi.mocked(x.server.getTransaction).mockResolvedValue({
      status: "NOT_FOUND",
    } as rpc.Api.GetTransactionResponse);
    const first = await x.executor.call(x.i, x.f, {}, x.principal, "key");
    expect(first).toMatchObject({
      ok: false,
      result_status: "TIMEOUT",
      error_code: "TRANSACTION_PENDING_TIMEOUT",
    });
    expect(first.transaction_hash).toMatch(/^[a-f0-9]{64}$/);
    const again = await x.executor.call(x.i, x.f, {}, x.principal, "key");
    expect(again.transaction_hash).toBe(first.transaction_hash);
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(
      await x.executor.call(x.i, x.f, {}, x.principal, "new-key"),
    ).toMatchObject({ error_code: "WRITE_NOT_PERMITTED" });
    vi.mocked(x.server.getTransaction).mockResolvedValue({
      status: "SUCCESS",
      ledger: 101,
      resultXdr: { feeCharged: 1n },
      returnValue: xdr.ScVal.scvU32(1),
    } as rpc.Api.GetTransactionResponse);
    expect(
      await x.executor.call(x.i, x.f, {}, x.principal, "key"),
    ).toMatchObject({ ok: true, result_status: "SUBMITTED_AND_CONFIRMED" });
    expect(x.send).toHaveBeenCalledTimes(1);
  },
);
it.skipIf(!database)(
  "does not send after failed simulation, excessive fee, signer failure or durability failure",
  async () => {
    for (const stage of ["simulation", "fee", "sign", "database"]) {
      const x = setup(true);
      await x.store.migrate();
      if (stage === "simulation")
        vi.mocked(x.server.simulateTransaction).mockResolvedValue({
          error: "failed",
          id: "1",
          latestLedger: 100,
          events: [],
          _parsed: true,
        });
      if (stage === "fee") x.executor.config.maxFee = "1";
      if (stage === "sign")
        x.executor.signer!.sign_transaction_envelope = async () => {
          throw new Error("secret");
        };
      if (stage === "database")
        vi.spyOn(x.store, "intent").mockRejectedValue(
          new Error("db unavailable"),
        );
      const result = await x.executor.call(x.i, x.f, {}, x.principal, "key");
      expect(result.ok).toBe(false);
      expect(x.send).not.toHaveBeenCalled();
    }
  },
);
it.skipIf(!database)(
  "reports on-chain failure and confirmed decoding errors without resubmission",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    vi.mocked(x.server.getTransaction).mockResolvedValue({
      status: "FAILED",
      ledger: 101,
      resultXdr: { feeCharged: 1n },
    } as rpc.Api.GetTransactionResponse);
    expect(
      await x.executor.call(x.i, x.f, {}, x.principal, "key"),
    ).toMatchObject({
      result_status: "FAILED_ON_CHAIN",
      error_code: "TRANSACTION_FAILED_ON_CHAIN",
    });
    vi.mocked(x.server.getTransaction).mockResolvedValue({
      status: "SUCCESS",
      ledger: 102,
      resultXdr: { feeCharged: 1n },
      returnValue: xdr.ScVal.scvBool(true),
    } as rpc.Api.GetTransactionResponse);
    expect(
      await x.executor.call(x.i, x.f, {}, x.principal, "key2"),
    ).toMatchObject({
      result_status: "SUBMITTED_AND_CONFIRMED",
      error_code: "RESULT_DECODE_FAILED",
    });
  },
);
it("normalizes omitted Option inputs and rejects wrong principals before RPC", async () => {
  const x = setup();
  const type = model({ kind: "Option", item: { kind: "u64" } });
  x.f.params = [
    {
      name: "v",
      required: false,
      description: "",
      converterId: type.converterId,
      sorobanType: type.sorobanType,
      jsonSchema: type.jsonSchema,
      type,
    },
  ];
  expect(await x.executor.call(x.i, x.f, {}, "wrong")).toMatchObject({
    error_code: "WRITE_NOT_PERMITTED",
  });
  expect(x.server.getAccount).not.toHaveBeenCalled();
  expect((await x.executor.call(x.i, x.f, {}, x.principal)).ok).toBe(true);
  expect(x.send).not.toHaveBeenCalled();
});
it("maps account unavailability and restoration without submission", async () => {
  const x = setup();
  vi.mocked(x.server.getAccount).mockRejectedValueOnce(
    new Error("private RPC endpoint"),
  );
  expect(await x.executor.call(x.i, x.f, {}, x.principal)).toMatchObject({
    error_code: "ACCOUNT_NOT_FOUND",
  });
  vi.mocked(x.server.simulateTransaction).mockResolvedValue({
    ...x.sim(),
    restorePreamble: {
      minResourceFee: "1",
      transactionData: new SorobanDataBuilder(),
    },
  });
  expect(await x.executor.call(x.i, x.f, {}, x.principal)).toMatchObject({
    error_code: "TTL_EXPIRED",
  });
  expect(x.send).not.toHaveBeenCalled();
});
it("rejects missing signers and disabled writes before assembly", async () => {
  const x = setup(true);
  x.executor.signer = undefined;
  expect(await x.executor.call(x.i, x.f, {}, x.principal, "key")).toMatchObject(
    { error_code: "SIGNER_NOT_CONFIGURED" },
  );
  x.executor.config.writeMode = false;
  expect(await x.executor.call(x.i, x.f, {}, x.principal, "key")).toMatchObject(
    { error_code: "WRITE_NOT_PERMITTED" },
  );
  expect(x.send).not.toHaveBeenCalled();
});
it.skipIf(!database)(
  "rejects conflicting idempotency inputs, unavailable authorizers, and explicit submission rejection",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    expect((await x.executor.call(x.i, x.f, {}, x.principal, "key")).ok).toBe(
      true,
    );
    x.f.description = "does not affect fingerprint";
    x.i.wasmHash = "changed";
    expect(
      await x.executor.call(x.i, x.f, {}, x.principal, "key"),
    ).toMatchObject({ error_code: "IDEMPOTENCY_CONFLICT" });
    x.i.wasmHash = wasmHash(new Uint8Array([1, 2, 3]));
    x.send.mockResolvedValue({
      status: "ERROR",
      hash: "unused",
      latestLedger: 100,
      latestLedgerCloseTime: 1,
    });
    expect(
      await x.executor.call(x.i, x.f, {}, x.principal, "rejected"),
    ).toMatchObject({ error_code: "SUBMISSION_FAILED" });
    const { contract } = await import("@stellar/stellar-sdk");
    const build = contract.AssembledTransaction.build;
    const spy = vi
      .spyOn(contract.AssembledTransaction, "build")
      .mockImplementation(async (options) => {
        const tx = await build(options);
        tx.needsNonInvokerSigningBy = () => [Keypair.random().publicKey()];
        return tx;
      });
    expect(
      await x.executor.call(x.i, x.f, {}, x.principal, "auth"),
    ).toMatchObject({ error_code: "AUTHORIZATION_FAILED" });
    spy.mockRestore();
  },
);
it.skipIf(!database)(
  "retains verified confirmation if persistence becomes unavailable after submission",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    const update = x.store.update.bind(x.store);
    vi.spyOn(x.store, "update").mockImplementation(
      async (id, state, response, hash) => {
        if (state === "SUCCESS") throw new Error("database lost");
        return update(id, state, response, hash);
      },
    );
    const response = await x.executor.call(x.i, x.f, {}, x.principal, "key");
    expect(response).toMatchObject({
      ok: true,
      result_status: "SUBMITTED_AND_CONFIRMED",
    });
    expect(response.transaction_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(x.send).toHaveBeenCalledTimes(1);
  },
);
it.skipIf(!database)(
  "joins an already preparing duplicate without a second submission",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    let release!: () => void;
    let notify!: () => void;
    const ready = new Promise<void>((r) => {
      notify = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(x.server.simulateTransaction).mockImplementationOnce(async () => {
      notify();
      await barrier;
      return x.sim();
    });
    const first = x.executor.call(x.i, x.f, {}, x.principal, "key");
    await ready;
    const second = x.executor.call(x.i, x.f, {}, x.principal, "key");
    setTimeout(release, 25);
    const results = await Promise.all([first, second]);
    for (const result of results)
      expect(result).toMatchObject({
        ok: true,
        result_status: "SUBMITTED_AND_CONFIRMED",
      });
    expect(x.send).toHaveBeenCalledTimes(1);
  },
);
it.skipIf(!database)(
  "reconciles pre-migration fingerprints and original metadata after interface backfill",
  async () => {
    const { canonical, digest } = await import("../src/store.js");
    const x = setup(true);
    await x.store.migrate();
    const legacyContext = {
      mode: x.f.mode,
      network: x.i.network,
      contract_id: x.i.contractId,
      wasm_hash: x.i.wasmHash,
      function_name: x.f.sorobanName,
    };
    const fingerprint = digest(
      canonical({
        ...legacyContext,
        arguments: {},
        source: x.executor.signer!.address,
      }),
    );
    await x.store.lock(
      "testnet",
      x.executor.signer!.address,
      async (client) => {
        const a = await x.store.begin(client, {
          principal: x.principal,
          network: "testnet",
          idempotency_key: "old-key",
          fingerprint,
          source_account: x.executor.signer!.address,
          request: { ...legacyContext, returns: x.f.returns },
        });
        await x.store.update(a.id, "INTENT", undefined, "oldhash");
      },
    );
    x.i.sourceKind = "wasm";
    x.i.interfaceHash = "backfilledhash";
    const result = await x.executor.call(x.i, x.f, {}, x.principal, "old-key");
    expect(result).toMatchObject({
      ok: true,
      transaction_hash: "oldhash",
      wasm_hash: x.i.wasmHash,
    });
    expect(result).not.toHaveProperty("interface_hash");
    expect(x.send).not.toHaveBeenCalled();
  },
);
it.skipIf(!database)(
  "retains intent and hash after an accepted send when PENDING persistence fails",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    const update = x.store.update.bind(x.store);
    vi.spyOn(x.store, "update").mockImplementation(async (...args) => {
      if (args[1] === "PENDING") throw new Error("lost persistence");
      return update(...args);
    });
    vi.mocked(x.server.getTransaction).mockResolvedValue({
      status: "NOT_FOUND",
    } as rpc.Api.GetTransactionResponse);
    const result = await x.executor.call(
      x.i,
      x.f,
      {},
      x.principal,
      "post-send",
    );
    expect(result).toMatchObject({
      ok: false,
      result_status: "TIMEOUT",
      error_code: "TRANSACTION_PENDING_TIMEOUT",
    });
    expect(result.transaction_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(
      (await x.store.find(x.principal, "testnet", "post-send"))?.state,
    ).toBe("TIMEOUT");
    vi.mocked(x.server.getTransaction).mockResolvedValue({
      status: "SUCCESS",
      ledger: 101,
      resultXdr: { feeCharged: 4n },
      returnValue: xdr.ScVal.scvU32(1),
    } as rpc.Api.GetTransactionResponse);
    const again = await x.executor.call(x.i, x.f, {}, x.principal, "post-send");
    expect(again).toMatchObject({
      ok: true,
      fee_charged: "4",
      transaction_hash: result.transaction_hash,
    });
    expect(x.send).toHaveBeenCalledTimes(1);
  },
);
it.skipIf(!database)(
  "never sends after an ambiguous durable-intent commit response",
  async () => {
    const x = setup(true);
    await x.store.migrate();
    const intent = x.store.intent.bind(x.store);
    vi.spyOn(x.store, "intent").mockImplementation(async (...args) => {
      await intent(...args);
      throw new Error("commit reply lost");
    });
    vi.mocked(x.server.getTransaction).mockResolvedValue({
      status: "NOT_FOUND",
    } as rpc.Api.GetTransactionResponse);
    const result = await x.executor.call(
      x.i,
      x.f,
      {},
      x.principal,
      "commit-unknown",
    );
    expect(result).toMatchObject({ result_status: "TIMEOUT" });
    expect(x.send).not.toHaveBeenCalled();
    expect(
      (await x.store.find(x.principal, "testnet", "commit-unknown"))
        ?.transaction_hash,
    ).toBe(result.transaction_hash);
  },
);
