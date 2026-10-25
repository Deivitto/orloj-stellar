import {
  Contract,
  TransactionBuilder,
  contract,
  rpc,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import {
  isClassic,
  classicInterface,
  classicRead,
  prepareClassic,
} from "./classic.js";
import { validator, encode, decode, budget } from "./codec.js";
import { permitted, type Config } from "./config.js";
import { envelope, fail, mapped, RegistryError } from "./errors.js";
import { wasmHash, ingest } from "./ingestion.js";
import { canonical, digest, Store, type Attempt } from "./store.js";
import type { ContractInterface, FunctionModel, TypeNode } from "./model.js";
import type pg from "pg";
import type { Signer } from "./signer.js";
export function argumentsFor(
  f: FunctionModel,
  args: unknown,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args))
    fail("INVALID_ARGUMENT");
  budget(args);
  const obj = args as Record<string, unknown>;
  if (Object.keys(obj).some((k) => !f.params.some((p) => p.name === k)))
    fail("INVALID_ARGUMENT");
  const normalized: Record<string, unknown> = Object.create(null);
  for (const p of f.params) {
    const v = Object.hasOwn(obj, p.name)
      ? obj[p.name]
      : p.required
        ? undefined
        : null;
    if (!validator(p.type.node).safeParse(v).success) fail("INVALID_ARGUMENT");
    normalized[p.name] = v;
  }
  return normalized;
}
export function declaredContractError(
  events: { event: xdr.ContractEvent }[],
  id: string,
  returns: TypeNode,
): RegistryError | undefined {
  if (returns.kind !== "Result") return;
  const expected = Buffer.from(StrKey.decodeContract(id));
  let candidate: RegistryError | undefined;
  for (const { event } of events) {
    if (event.type !== xdr.ContractEventType.diagnostic) continue;
    const topics = event.body.v0.topics;
    const marker =
      topics[0]?.type === "scvSymbol" ? topics[0].sym.toString() : "";
    if (marker === "host_fn_failed") {
      const terminal = topics.find((v) => v.type === "scvError");
      if (
        !terminal ||
        terminal.type !== "scvError" ||
        terminal.error.type !== "sceContract" ||
        terminal.error.contractCode !== candidate?.contractError?.code
      )
        candidate = undefined;
      continue;
    }
    if (marker !== "error") continue;
    // Any later error supersedes a possibly caught earlier error, including foreign calls.
    candidate = undefined;
    if (
      !event.contractId ||
      !Buffer.from(event.contractId.value).equals(expected)
    )
      continue;
    for (const v of topics.slice(1)) {
      if (v.type !== "scvError" || v.error.type !== "sceContract") continue;
      const code = v.error.contractCode;
      const c = returns.errors.find((c) => c.value === code);
      if (!returns.genericError && !c) continue;
      candidate = new RegistryError("CONTRACT_EXECUTION_FAILED", {
        code,
        ...(c ? { name: c.name } : {}),
      });
    }
  }
  return candidate;
}
export function requireSimulation(
  s: rpc.Api.SimulateTransactionResponse,
  assetId?: string,
  declared?: { id: string; returns: TypeNode },
) {
  if (declared && rpc.Api.isSimulationError(s)) {
    const error = declaredContractError(
      s.events ?? [],
      declared.id,
      declared.returns,
    );
    if (error) throw error;
  }
  if (assetId && rpc.Api.isSimulationError(s)) {
    const expected = Buffer.from(StrKey.decodeContract(assetId)).toString(
      "hex",
    );
    for (const d of s.events ?? []) {
      const e = d.event;
      if (
        !e.contractId ||
        Buffer.from(e.contractId.value).toString("hex") !== expected
      )
        continue;
      for (const v of [...e.body.v0.topics, e.body.v0.data]) {
        if (v.type !== "scvError" || v.error.type !== "sceContract") continue;
        const codes = {
          2: "ASSET_OPERATION_UNSUPPORTED",
          4: "ASSET_NOT_AUTHORIZED",
          5: "AUTHORIZATION_FAILED",
          6: "ACCOUNT_NOT_FOUND",
          8: "INVALID_ARGUMENT",
          9: "ASSET_ALLOWANCE_ERROR",
          10: "ASSET_BALANCE_ERROR",
          11: "ASSET_NOT_AUTHORIZED",
          13: "ASSET_TRUSTLINE_REQUIRED",
          14: "ASSET_RESERVE_ERROR",
        } as const;
        const code = codes[v.error.contractCode as keyof typeof codes];
        if (code) fail(code);
      }
    }
  }
  if (rpc.Api.isSimulationRestore(s)) fail("TTL_EXPIRED");
  if (!rpc.Api.isSimulationSuccess(s) || !s.result) fail("SIMULATION_FAILED");
  return s;
}
export class Executor {
  constructor(
    public config: Config,
    public server: rpc.Server,
    public store: Store,
    public signer?: Signer,
    public intentGuard?: (
      client: pg.PoolClient,
      metadata: { hash: string; sequence: string; maxTime: string },
    ) => Promise<void>,
  ) {}
  async current(i: ContractInterface) {
    if (i.network !== this.config.network) fail("STALE_INTERFACE");
    if (isClassic(i)) {
      if (
        classicInterface(this.config, i.contractId).interfaceHash !==
        i.interfaceHash
      )
        fail("STALE_INTERFACE");
      return;
    }
    if (i.sourceKind === "stellar_asset") {
      const current = await ingest(this.server, this.config, i.contractId);
      if (
        current.sourceKind !== "stellar_asset" ||
        current.interfaceHash !== i.interfaceHash
      )
        fail("STALE_INTERFACE");
      return;
    }
    if (i.sourceKind === "wasm" && i.encodingVersion !== 5)
      fail("STALE_INTERFACE");
    if (i.protocolVersion !== undefined) {
      const net = await mapped("SPEC_PARSE_FAILED", () =>
        this.server.getNetwork(),
      );
      if (
        Number(net.protocolVersion) !== i.protocolVersion ||
        net.passphrase !== this.config.networkPassphrase
      )
        fail("STALE_INTERFACE");
    }
    const wasm = await mapped("SPEC_PARSE_FAILED", () =>
      this.server.getContractWasmByContractId(i.contractId),
    );
    if (wasmHash(wasm) !== i.wasmHash) fail("STALE_INTERFACE");
  }
  async call(
    i: ContractInterface,
    f: FunctionModel,
    args: unknown,
    principal: string,
    key?: string,
  ): Promise<Record<string, unknown>> {
    const context: Record<string, unknown> = {
      mode: f.mode,
      network: i.network,
      contract_id: i.contractId,
      source_kind: i.sourceKind ?? "wasm",
      interface_hash: i.interfaceHash ?? i.wasmHash,
      ...(i.wasmHash ? { wasm_hash: i.wasmHash } : {}),
      function_name: f.sorobanName,
    };
    try {
      const policy = permitted(
        this.config,
        i.contractId,
        f.sorobanName,
        principal,
      );
      if (!policy || policy.mode !== f.mode) fail("WRITE_NOT_PERMITTED");
      const values = argumentsFor(f, args);
      if (f.mode === "WRITE")
        return await this.write(i, f, values, principal, key, context);
      await this.current(i);
      if (isClassic(i))
        return {
          ...context,
          ok: true,
          result_status: "READ_ONLY",
          read_at: new Date().toISOString(),
          data: await classicRead(this.config, f, values),
        };
      const account = await mapped("ACCOUNT_NOT_FOUND", () =>
        this.server.getAccount(this.config.simulationSource),
      );
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          new Contract(i.contractId).call(
            f.sorobanName,
            ...f.params.map((p) => encode(p.type.node, values[p.name])),
          ),
        )
        .setTimeout(60)
        .build();
      const sim = requireSimulation(
        await mapped("SIMULATION_FAILED", () =>
          this.server.simulateTransaction(tx),
        ),
        i.sourceKind === "stellar_asset" ? i.contractId : undefined,
        { id: i.contractId, returns: f.returns.node },
      );
      if (sim.result!.auth.length) fail("AUTHORIZATION_REQUIRED");
      return {
        ...context,
        ok: true,
        result_status: "SIMULATED",
        simulated_at: new Date().toISOString(),
        data: decode(f.returns.node, sim.result!.retval),
      };
    } catch (e) {
      if (context.transaction_hash)
        return envelope(new RegistryError("TRANSACTION_PENDING_TIMEOUT"), {
          ...context,
          result_status: "TIMEOUT",
        });
      return envelope(e, context);
    }
  }
  async write(
    i: ContractInterface,
    f: FunctionModel,
    values: Record<string, unknown>,
    principal: string,
    key: string | undefined,
    context: Record<string, unknown>,
  ) {
    const c = this.config;
    if (!c.writeMode || c.network !== "testnet") fail("WRITE_NOT_PERMITTED");
    if (!this.signer) fail("SIGNER_NOT_CONFIGURED");
    if (
      typeof key !== "string" ||
      !key ||
      key.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(key)
    )
      fail("INVALID_ARGUMENT");
    const signer = this.signer;
    const fingerprint = digest(
      canonical({ ...context, arguments: values, source: signer.address }),
    );
    const {
      source_kind: _kind,
      interface_hash: _hash,
      ...legacyContext
    } = context;
    const legacyFingerprint = digest(
      canonical({
        ...legacyContext,
        arguments: values,
        source: signer.address,
      }),
    );
    const matches = (a: Attempt) =>
      a.fingerprint === fingerprint ||
      (!a.request.interface_hash && a.fingerprint === legacyFingerprint);
    const originalContext = (a: Attempt) => {
      const { returns: _, ...ctx } = a.request;
      return ctx;
    };
    const previous = await this.store.find(principal, c.network, key);
    if (previous) {
      if (!matches(previous)) fail("IDEMPOTENCY_CONFLICT");
      if (previous.state !== "PREPARING")
        return this.reconcile(
          previous,
          {
            ...f,
            returns: (previous.request.returns ??
              f.returns) as typeof f.returns,
          },
          originalContext(previous),
        );
    }
    let attempt: Attempt | undefined;
    await this.store.lock(c.network, signer.address, async (client) => {
      const prior = await this.store.find(principal, c.network, key);
      if (prior) {
        if (!matches(prior)) fail("IDEMPOTENCY_CONFLICT");
        attempt = prior;
        return;
      }
      attempt = await this.store.begin(client, {
        principal,
        network: c.network,
        idempotency_key: key,
        fingerprint,
        source_account: signer.address,
        request: { ...context, returns: f.returns },
      });
      try {
        await this.current(i);
        await mapped("ACCOUNT_NOT_FOUND", () =>
          this.server.getAccount(signer.address),
        );
        const signed = isClassic(i)
          ? await prepareClassic(c, i.contractId, f, values, signer, principal)
          : await this.prepareSoroban(i, f, values);
        const hash = Buffer.from(signed.hash()).toString("hex");
        attempt!.transaction_hash = hash;
        context.transaction_hash = hash;
        try {
          await this.store.intent(
            client,
            attempt!.id,
            hash,
            signed.sequence,
            signed.timeBounds?.maxTime ?? "0",
            this.intentGuard
              ? (locked) =>
                  this.intentGuard!(locked, {
                    hash,
                    sequence: signed.sequence,
                    maxTime: signed.timeBounds?.maxTime ?? "0",
                  })
              : undefined,
          );
        } catch (e) {
          try {
            const durable = await this.store.find(principal, c.network, key);
            if (durable && !durable.transaction_hash) {
              attempt!.transaction_hash = null;
              delete context.transaction_hash;
            }
          } catch {
            /* Commit outcome remains ambiguous. */
          }
          throw e;
        }
        attempt!.transaction_hash = hash;
        context.transaction_hash = hash;
        attempt!.state = "INTENT";
        let sent: rpc.Api.SendTransactionResponse;
        try {
          sent = await this.server.sendTransaction(signed);
        } catch {
          return;
        }
        if (sent.status === "ERROR") {
          const response = envelope(new RegistryError("SUBMISSION_FAILED"), {
            ...context,
            transaction_hash: hash,
          });
          await this.store.update(attempt!.id, "REJECTED", response);
          attempt!.response = response;
          attempt!.state = "REJECTED";
          return;
        }
        await this.store.update(attempt!.id, "PENDING");
        attempt!.state = "PENDING";
      } catch (e) {
        if (attempt!.transaction_hash) {
          attempt!.state = "INTENT";
          return;
        }
        const response = envelope(e, context);
        await this.store.update(attempt!.id, "REJECTED", response);
        attempt!.response = response;
        attempt!.state = "REJECTED";
      }
    });
    if (!attempt) fail("INTERNAL_ERROR");
    return this.reconcile(
      attempt,
      {
        ...f,
        returns: (attempt.request.returns ?? f.returns) as typeof f.returns,
      },
      originalContext(attempt),
    );
  }
  private async prepareSoroban(
    i: ContractInterface,
    f: FunctionModel,
    values: Record<string, unknown>,
  ) {
    const c = this.config,
      signer = this.signer!;
    const tx = await mapped("SIMULATION_FAILED", () =>
      contract.AssembledTransaction.build({
        contractId: i.contractId,
        method: f.sorobanName,
        args: f.params.map((p) => encode(p.type.node, values[p.name])),
        publicKey: signer.address,
        networkPassphrase: c.networkPassphrase,
        rpcUrl: c.rpcUrl,
        server: this.server,
        parseResultXdr: (v) => decode(f.returns.node, v),
        simulate: false,
        restore: false,
        timeoutInSeconds: 60,
      }),
    );
    await mapped("SIMULATION_FAILED", () => tx.simulate({ restore: false }));
    requireSimulation(
      tx.simulation!,
      i.sourceKind === "stellar_asset" ? i.contractId : undefined,
      { id: i.contractId, returns: f.returns.node },
    );
    for (const address of tx.needsNonInvokerSigningBy()) {
      if (address !== signer.address) fail("AUTHORIZATION_FAILED");
      await mapped("AUTHORIZATION_FAILED", () =>
        tx.signAuthEntries({
          address,
          signAuthEntry: signer.sign_authorization_entries,
        }),
      );
    }
    const started = Date.now();
    const final = requireSimulation(
      await mapped("AUTHORIZATION_FAILED", () =>
        this.server.simulateTransaction(
          tx.built!,
          { cpuInstructions: c.instructionLeeway },
          "enforce",
        ),
      ),
      i.sourceKind === "stellar_asset" ? i.contractId : undefined,
      { id: i.contractId, returns: f.returns.node },
    );
    const buffered = (BigInt(final.minResourceFee) * 120n + 99n) / 100n;
    final.transactionData.setResourceFee(buffered);
    const built = rpc
      .assembleTransaction(tx.built!, {
        ...final,
        minResourceFee: buffered.toString(),
      })
      .build();
    const finalTx = contract.AssembledTransaction.fromJson(tx.options, {
      tx: built.toXdr(),
      simulationResult: {
        auth: final.result!.auth.map((a) => a.toXdr("base64")),
        retval: final.result!.retval.toXdr("base64"),
      },
      simulationTransactionData: final.transactionData.build().toXdr("base64"),
    });
    console.error(
      JSON.stringify({
        event: "fee_estimate",
        fee: built.fee,
        max_fee: c.maxFee,
      }),
    );
    if (BigInt(built.fee) > BigInt(c.maxFee!)) fail("FEE_POLICY_REJECTED");
    if (Date.now() - started > c.simulationMaxAgeMs) fail("SIMULATION_FAILED");
    await mapped("SIGNING_FAILED", () =>
      finalTx.sign({
        force: true,
        signTransaction: signer.sign_transaction_envelope,
      }),
    );
    tx.signed = finalTx.signed;
    if (!tx.signed || BigInt(tx.signed.fee) > BigInt(c.maxFee!))
      fail("FEE_POLICY_REJECTED");
    if (Date.now() - started > c.simulationMaxAgeMs) fail("SIMULATION_FAILED");

    return tx.signed;
  }
  async reconcile(
    a: Attempt,
    f: FunctionModel,
    context: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (a.response && !["TIMEOUT", "INTENT", "PENDING"].includes(a.state))
      return a.response;
    if (!a.transaction_hash)
      return envelope(new RegistryError("WRITE_NOT_PERMITTED"), context);
    const ctx = { ...context, transaction_hash: a.transaction_hash };
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      let r: rpc.Api.GetTransactionResponse | undefined;
      try {
        r = await this.server.getTransaction(a.transaction_hash);
      } catch {
        /* Read-only reconciliation may retry. */
      }
      if (r?.status === "SUCCESS") {
        let response: Record<string, unknown>;
        const confirmed = {
          ...ctx,
          result_status: "SUBMITTED_AND_CONFIRMED",
          ledger: r.ledger,
          fee_charged: r.resultXdr.feeCharged.toString(),
        };
        try {
          response = {
            ...confirmed,
            ok: true,
            data: decode(
              f.returns.node,
              r.returnValue ??
                (await import("@stellar/stellar-sdk")).xdr.ScVal.scvVoid(),
            ),
          };
        } catch (e) {
          response = envelope(e, confirmed);
        }
        const stored = await this.store
          .update(a.id, "SUCCESS", response)
          .catch(() => response);
        return stored ?? response;
      }
      if (r?.status === "FAILED") {
        const contractError = declaredContractError(
          r.diagnosticEventsXdr ?? [],
          String(context.contract_id),
          f.returns.node,
        )?.contractError;
        const response = envelope(
          new RegistryError("TRANSACTION_FAILED_ON_CHAIN"),
          {
            ...ctx,
            ...(contractError ? { contract_error: contractError } : {}),
            result_status: "FAILED_ON_CHAIN",
            ledger: r.ledger,
            fee_charged: r.resultXdr.feeCharged.toString(),
          },
        );
        const stored = await this.store
          .update(a.id, "FAILED", response)
          .catch(() => response);
        return stored ?? response;
      }
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(
            Math.round(delay * (0.8 + Math.random() * 0.4)),
            Math.max(0, deadline - Date.now()),
          ),
        ),
      );
      delay = Math.min(8000, delay * 2);
    }
    const response = envelope(
      new RegistryError("TRANSACTION_PENDING_TIMEOUT"),
      { ...ctx, result_status: "TIMEOUT" },
    );
    const stored = await this.store
      .update(a.id, "TIMEOUT", response)
      .catch(() => response);
    return stored ?? response;
  }
}
