import {
  Contract,
  TransactionBuilder,
  contract,
  rpc,
} from "@stellar/stellar-sdk";
import { validator, encode, decode } from "./codec.js";
import { permitted, type Config } from "./config.js";
import { envelope, fail, mapped, RegistryError } from "./errors.js";
import { wasmHash } from "./ingestion.js";
import { canonical, digest, Store, type Attempt } from "./store.js";
import type { ContractInterface, FunctionModel } from "./model.js";
import type { Signer } from "./signer.js";
export function argumentsFor(
  f: FunctionModel,
  args: unknown,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args))
    fail("INVALID_ARGUMENT");
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
export function requireSimulation(s: rpc.Api.SimulateTransactionResponse) {
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
  ) {}
  async current(i: ContractInterface) {
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
    const context = {
      mode: f.mode,
      network: i.network,
      contract_id: i.contractId,
      wasm_hash: i.wasmHash,
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
    const previous = await this.store.find(principal, c.network, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
      if (previous.state !== "PREPARING")
        return this.reconcile(previous, f, context);
    }
    let attempt: Attempt | undefined;
    await this.store.lock(c.network, signer.address, async (client) => {
      const prior = await this.store.find(principal, c.network, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
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
        await mapped("SIMULATION_FAILED", () =>
          tx.simulate({ restore: false }),
        );
        requireSimulation(tx.simulation!);
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
            this.server.simulateTransaction(tx.built!, undefined, "enforce"),
          ),
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
          simulationTransactionData: final.transactionData
            .build()
            .toXdr("base64"),
        });
        console.error(
          JSON.stringify({
            event: "fee_estimate",
            fee: built.fee,
            max_fee: c.maxFee,
          }),
        );
        if (BigInt(built.fee) > BigInt(c.maxFee!)) fail("FEE_POLICY_REJECTED");
        if (Date.now() - started > c.simulationMaxAgeMs)
          fail("SIMULATION_FAILED");
        await mapped("SIGNING_FAILED", () =>
          finalTx.sign({
            force: true,
            signTransaction: signer.sign_transaction_envelope,
          }),
        );
        tx.signed = finalTx.signed;
        if (!tx.signed || BigInt(tx.signed.fee) > BigInt(c.maxFee!))
          fail("FEE_POLICY_REJECTED");
        if (Date.now() - started > c.simulationMaxAgeMs)
          fail("SIMULATION_FAILED");
        const hash = Buffer.from(tx.signed.hash()).toString("hex");
        await this.store.update(attempt!.id, "INTENT", undefined, hash);
        attempt!.transaction_hash = hash;
        context.transaction_hash = hash;
        attempt!.state = "INTENT";
        let sent: rpc.Api.SendTransactionResponse;
        try {
          sent = await this.server.sendTransaction(tx.signed);
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
        if (attempt!.transaction_hash) throw e;
        const response = envelope(e, context);
        await this.store.update(attempt!.id, "REJECTED", response);
        attempt!.response = response;
        attempt!.state = "REJECTED";
      }
    });
    if (!attempt) fail("INTERNAL_ERROR");
    return this.reconcile(attempt, f, context);
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
        const response = envelope(
          new RegistryError("TRANSACTION_FAILED_ON_CHAIN"),
          { ...ctx, result_status: "FAILED_ON_CHAIN", ledger: r.ledger },
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
