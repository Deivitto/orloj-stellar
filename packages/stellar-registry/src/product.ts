import {
  exactGrantSchema,
  checkedGrant,
  checkExactGrant,
  MAX_DAILY_FEE,
} from "./exact-grant.js";
import { randomUUID, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  classicIds,
  classicInterface,
  isClassic,
  classicMode,
} from "./classic.js";
import { Address, Keypair, StrKey, hash, rpc, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import { Store, canonical, digest } from "./store.js";
import { Executor, argumentsFor } from "./executor.js";
import { BrowserSigner } from "./browser-signer.js";
import { managedSigner } from "./managed-signer.js";
import { ingest } from "./ingestion.js";
import { ingestAsset } from "./assets.js";
import { fail, envelope, RegistryError } from "./errors.js";
import type { Config } from "./config.js";
import type { ContractInterface, FunctionModel } from "./model.js";
import { agentPrincipal, operationStatusName } from "./product-types.js";
import type {
  AgentIdentity,
  Wallet,
  Policy,
  ProductOperation,
  Limits,
} from "./product-types.js";
const natural = z
  .string()
  .regex(/^[1-9][0-9]{0,38}$/)
  .refine((s) => BigInt(s) < 1n << 127n);
export const limitsSchema = z.strictObject({
  recipients: z
    .array(
      z
        .string()
        .refine(
          (s) =>
            StrKey.isValidEd25519PublicKey(s) ||
            StrKey.isValidContract(s) ||
            StrKey.isValidMed25519PublicKey(s),
        ),
    )
    .min(1)
    .max(100),
  perTransfer: natural,
  rollingAmount: natural,
  rollingFee: natural,
});
const terminal = new Set([
  "SUCCESS",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "INTERRUPTED",
  "EXPIRED_UNSUBMITTED",
]);
export class Product {
  private workerId = randomUUID();
  private pending = new Map<string, BrowserSigner>();
  private timer?: ReturnType<typeof setInterval>;
  private working = false;
  private activeRuns = new Set<Promise<void>>();
  private stopping = false;
  constructor(
    public config: Config,
    public server: rpc.Server,
    public store: Store,
    public options: {
      serviceToken: string;
      signerUrl: string;
      signerToken: string;
      origin: string;
    },
  ) {}
  async identity(token: string): Promise<AgentIdentity | undefined> {
    try {
      const r = await this.store.pool.query(
        "SELECT k.id,k.agent_id,a.user_id,a.instance_id FROM mcp_api_key k JOIN agent_ownership a ON a.agent_id=k.agent_id WHERE k.token=$1 AND k.revoked_at IS NULL AND k.owner_id=a.user_id AND k.instance_id=a.instance_id",
        [token],
      );
      const row = r.rows[0];
      return row
        ? {
            credentialId: row.id,
            agentId: row.agent_id,
            ownerId: row.user_id,
            instanceId: row.instance_id,
          }
        : undefined;
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return undefined;
      throw e;
    }
  }
  async owner(ownerId: string, agentId: string): Promise<AgentIdentity> {
    const r = await this.store.pool.query(
      "SELECT instance_id FROM agent_ownership WHERE agent_id=$1 AND user_id=$2",
      [agentId, ownerId],
    );
    if (!r.rowCount) fail("UNAUTHORIZED");
    return {
      ownerId,
      agentId,
      instanceId: r.rows[0].instance_id,
      credentialId: "",
    };
  }
  async wallets(a: AgentIdentity): Promise<Wallet[]> {
    return (
      await this.store.pool.query(
        "SELECT id,agent_id,instance_id,owner_id,network,mode,address,active,revision FROM stellar_wallets WHERE agent_id=$1 AND instance_id=$2 AND owner_id=$3",
        [a.agentId, a.instanceId, a.ownerId],
      )
    ).rows;
  }
  async policies(a: AgentIdentity): Promise<Policy[]> {
    return (
      await this.store.pool.query(
        "SELECT * FROM stellar_tool_policies WHERE agent_id=$1 AND instance_id=$2 AND owner_id=$3",
        [a.agentId, a.instanceId, a.ownerId],
      )
    ).rows;
  }
  async register(a: AgentIdentity, body: unknown) {
    const parsed = z
      .strictObject({
        contractId: z.string().optional(),
        asset: z
          .union([
            z.strictObject({ kind: z.literal("native") }),
            z.strictObject({
              kind: z.literal("issued"),
              code: z.string(),
              issuer: z.string(),
            }),
          ])
          .optional(),
      })
      .safeParse(body);
    if (!parsed.success || !!parsed.data.asset === !!parsed.data.contractId)
      fail("INVALID_ARGUMENT");
    const i = parsed.data.asset
      ? await ingestAsset(this.server, this.config, parsed.data.asset)
      : classicIds.includes(
            parsed.data.contractId as (typeof classicIds)[number],
          )
        ? classicInterface(this.config, parsed.data.contractId!)
        : await ingest(this.server, this.config, parsed.data.contractId!);
    await this.store.save(i);
    await this.store.pool.query(
      "INSERT INTO stellar_contract_owners VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [a.ownerId, i.network, i.contractId],
    );
    return {
      ok: true,
      ...i,
      url: `/contracts/${i.contractId}/mcp`,
      name: `stellar_${i.network}_${i.contractId.replace(":", "_")}`,
    };
  }
  async manifest(a: AgentIdentity) {
    const result = await this.store.pool.query(
      "SELECT DISTINCT ON (i.contract_id) i.interface FROM stellar_interfaces i JOIN stellar_contract_owners o USING(network,contract_id) WHERE o.owner_id=$1 AND i.network=$2 ORDER BY i.contract_id,i.created_at DESC",
      [a.ownerId, this.config.network],
    );
    const policies = await this.policies(a),
      wallet = (await this.wallets(a)).find((w) => w.active);
    return result.rows.map(
      ({ interface: i }: { interface: ContractInterface }) => ({
        name: `stellar_${i.network}_${i.contractId.replace(":", "_")}`,
        url: `/contracts/${i.contractId}/mcp`,
        family: "stellar",
        network: i.network,
        chainId: null,
        address: i.contractId,
        contractName:
          i.sourceKind === "classic_dex"
            ? "Stellar DEX (classic)"
            : i.sourceKind === "classic_amm"
              ? "Stellar AMM (classic)"
              : i.asset?.kind === "native"
                ? "XLM"
                : i.asset?.kind === "issued"
                  ? i.asset.code
                  : i.contractId,
        description: `Stellar ${i.network} · ${i.inventory?.length ?? 0} declared methods`,
        platform: "Stellar",
        toolCount: policies.filter((p) => p.contract_id === i.contractId)
          .length,
        toolNames: [
          ...this.callable(i, policies, wallet)
            .functions.filter(
              (f) =>
                (f.mode === "READ" || (this.config.writeMode && !!wallet)) &&
                !f.params.some(
                  (p) =>
                    p.name === "approved" ||
                    (p.name === "idempotency_key" && f.mode === "WRITE"),
                ),
            )
            .map((f) => f.mcpToolName),
          operationStatusName(i),
        ],
        interactionType: policies.some(
          (p) => p.contract_id === i.contractId && p.mode === "WRITE",
        )
          ? "mixed"
          : "read-only",
        inventory: i.inventory,
        excluded: i.excluded,
        sourceKind: i.sourceKind,
        interfaceHash: i.interfaceHash,
      }),
    );
  }
  async setPolicies(a: AgentIdentity, body: unknown) {
    const input = z
      .strictObject({
        contractId: z.string(),
        functions: z
          .array(
            z.strictObject({
              name: z.string(),
              mode: z.enum(["READ", "WRITE"]),
              limits: limitsSchema.nullable().optional(),
              exactGrant: exactGrantSchema.nullable().optional(),
            }),
          )
          .max(100),
      })
      .safeParse(body);
    if (!input.success) fail("INVALID_ARGUMENT");
    const { contractId, functions } = input.data;
    if (new Set(functions.map((f) => f.name)).size !== functions.length)
      fail("INVALID_ARGUMENT");
    const owned = await this.store.pool.query(
      "SELECT 1 FROM stellar_contract_owners WHERE owner_id=$1 AND network=$2 AND contract_id=$3",
      [a.ownerId, this.config.network, contractId],
    );
    if (!owned.rowCount) fail("UNAUTHORIZED");
    const i = await this.store.get(this.config.network, contractId);
    if (!i) fail("INVALID_CONTRACT_ID");
    for (const f of functions) {
      if (isClassic(i) && classicMode(f.name) !== f.mode)
        fail("INVALID_ARGUMENT");
      if (
        !i.inventory?.some(
          (m) => m.name === f.name && m.eligible && m.signature,
        )
      )
        fail("UNSUPPORTED_SOROBAN_TYPE");
      if (f.exactGrant) {
        if (f.limits || f.mode !== "WRITE" || isClassic(i))
          fail("WRITE_NOT_PERMITTED");
        const signature = i.inventory!.find(
          (m) => m.name === f.name,
        )!.signature!;
        const fn = {
          ...signature,
          mode: "WRITE" as const,
          simulationSafe: false,
          writeAllowed: true,
        };
        const normalized = argumentsFor(fn, f.exactGrant.arguments);
        const grant = checkedGrant({ ...f.exactGrant, arguments: normalized });
        checkExactGrant(i, fn, normalized, grant);
        f.exactGrant = grant;
      }
      if (
        f.limits &&
        (f.mode !== "WRITE" ||
          i.sourceKind !== "stellar_asset" ||
          f.name !== "transfer")
      )
        fail("WRITE_NOT_PERMITTED");
    }
    const client = await this.store.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockIdentity(client, a, true);
      // An agent-wide revision serializes replacement/removal with intent guards.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["policies:" + a.instanceId],
      );
      const prior = await client.query(
        "UPDATE agent_ownership SET stellar_policy_revision=stellar_policy_revision+1 WHERE agent_id=$1 AND instance_id=$2 RETURNING stellar_policy_revision AS revision",
        [a.agentId, a.instanceId],
      );
      const revision = Number(prior.rows[0].revision);
      await client.query(
        "DELETE FROM stellar_tool_policies WHERE agent_id=$1 AND instance_id=$2 AND contract_id=$3",
        [a.agentId, a.instanceId, contractId],
      );
      for (const f of functions)
        await client.query(
          "INSERT INTO stellar_tool_policies(agent_id,instance_id,owner_id,network,contract_id,function_name,mode,revision,limits,exact_grant) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            a.agentId,
            a.instanceId,
            a.ownerId,
            this.config.network,
            contractId,
            f.name,
            f.mode,
            revision,
            f.limits ?? null,
            f.exactGrant ?? null,
          ],
        );
      await client.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async lockIdentity(
    client: pg.PoolClient,
    a: AgentIdentity,
    exclusive = false,
  ) {
    const r = await client.query(
      `SELECT agent_id FROM agent_ownership WHERE agent_id=$1 AND instance_id=$2 AND user_id=$3 FOR ${exclusive ? "UPDATE" : "SHARE"}`,
      [a.agentId, a.instanceId, a.ownerId],
    );
    if (!r.rowCount) fail("UNAUTHORIZED");
    if (a.credentialId) {
      const k = await client.query(
        "SELECT id FROM mcp_api_key WHERE id=$1 AND agent_id=$2 AND owner_id=$3 AND instance_id=$4 AND revoked_at IS NULL FOR SHARE",
        [a.credentialId, a.agentId, a.ownerId, a.instanceId],
      );
      if (!k.rowCount) fail("UNAUTHORIZED");
    }
  }
  async activate(a: AgentIdentity, id: string) {
    const client = await this.store.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockIdentity(client, a, true);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["wallet:" + a.instanceId],
      );
      const r = await client.query(
        "SELECT id FROM stellar_wallets WHERE id=$1 AND agent_id=$2 AND instance_id=$3 AND owner_id=$4 FOR UPDATE",
        [id, a.agentId, a.instanceId, a.ownerId],
      );
      if (!r.rowCount) fail("UNAUTHORIZED");
      await client.query(
        "UPDATE stellar_wallets SET active=false,revision=revision+1 WHERE agent_id=$1 AND instance_id=$2",
        [a.agentId, a.instanceId],
      );
      await client.query("UPDATE stellar_wallets SET active=true WHERE id=$1", [
        id,
      ]);
      // Re-selecting managed custody requires fresh owner authorization of limits.
      const revision = (
        await client.query(
          "UPDATE agent_ownership SET stellar_policy_revision=stellar_policy_revision+1 WHERE agent_id=$1 AND instance_id=$2 RETURNING stellar_policy_revision",
          [a.agentId, a.instanceId],
        )
      ).rows[0].stellar_policy_revision;
      await client.query(
        "UPDATE stellar_tool_policies SET limits=NULL,exact_grant=NULL,revision=$3 WHERE agent_id=$1 AND instance_id=$2 AND mode='WRITE'",
        [a.agentId, a.instanceId, revision],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async managedWallet(a: AgentIdentity) {
    const r = await fetch(new URL("/wallet", this.options.signerUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orloj-signer": this.options.signerToken,
      },
      body: JSON.stringify({
        agentId: a.agentId,
        instanceId: a.instanceId,
        ownerId: a.ownerId,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) fail("SIGNER_NOT_CONFIGURED");
    const w = (await r.json()) as { id: string; address: string };
    await this.activate(a, w.id);
    return { ok: true, ...w };
  }
  async challenge(a: AgentIdentity, address: string) {
    if (!StrKey.isValidEd25519PublicKey(address)) fail("INVALID_ARGUMENT");
    const id = randomUUID(),
      expires = new Date(Date.now() + 5 * 60000);
    const message = JSON.stringify({
      purpose: "Link Orloj Stellar wallet",
      origin: this.options.origin,
      network: "testnet",
      owner: a.ownerId,
      agent: a.agentId,
      instance: a.instanceId,
      address,
      nonce: randomBytes(32).toString("hex"),
      expires: expires.toISOString(),
    });
    await this.store.pool.query(
      "INSERT INTO stellar_wallet_challenges VALUES($1,$2,$3,$4,$5,$6,$7,false)",
      [id, a.agentId, a.instanceId, a.ownerId, address, message, expires],
    );
    return { id, message, address, expiresAt: expires.toISOString() };
  }
  async link(a: AgentIdentity, id: string, signature: string) {
    const client = await this.store.pool.connect();
    let walletId = "";
    try {
      await client.query("BEGIN");
      await this.lockIdentity(client, a);
      const r = await client.query(
        "SELECT * FROM stellar_wallet_challenges WHERE id=$1 AND agent_id=$2 AND instance_id=$3 AND owner_id=$4 AND NOT used AND expires_at>now() FOR UPDATE",
        [id, a.agentId, a.instanceId, a.ownerId],
      );
      const c = r.rows[0];
      if (!c) fail("UNAUTHORIZED");
      const bytes = Buffer.from(signature, "base64");
      const payload = hash(
        Buffer.concat([
          Buffer.from("Stellar Signed Message:\n"),
          Buffer.from(c.message, "utf8"),
        ]),
      );
      if (
        bytes.length !== 64 ||
        !Keypair.fromPublicKey(c.address).verify(payload, bytes)
      )
        fail("SIGNING_FAILED");
      await client.query(
        "UPDATE stellar_wallet_challenges SET used=true WHERE id=$1",
        [id],
      );
      const w = await client.query(
        "INSERT INTO stellar_wallets(id,agent_id,instance_id,owner_id,network,mode,address) VALUES($1,$2,$3,$4,'testnet','freighter',$5) ON CONFLICT(agent_id,instance_id,network,mode) DO UPDATE SET address=EXCLUDED.address,revision=stellar_wallets.revision+1 RETURNING id",
        [randomUUID(), a.agentId, a.instanceId, a.ownerId, c.address],
      );
      walletId = w.rows[0].id;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    await this.activate(a, walletId);
    return { ok: true };
  }
  interface(i: ContractInterface, policies: Policy[]): ContractInterface {
    return {
      ...i,
      functions: (i.inventory ?? []).flatMap((m) => {
        const p = policies.find(
          (p) => p.contract_id === i.contractId && p.function_name === m.name,
        );
        return p && m.eligible && m.signature
          ? [
              {
                ...m.signature,
                mode: p.mode,
                simulationSafe: false,
                writeAllowed: p.mode === "WRITE",
              },
            ]
          : [];
      }),
    };
  }
  callable(
    i: ContractInterface,
    policies: Policy[],
    wallet?: Wallet,
  ): ContractInterface {
    const configured = this.interface(i, policies);
    return {
      ...configured,
      functions: configured.functions.filter(
        (f) =>
          f.mode === "READ" ||
          (this.config.writeMode &&
            !!wallet &&
            (wallet.mode === "freighter" ||
              (!isClassic(i) &&
                !!i.interfaceHash &&
                policies.find(
                  (p) =>
                    p.contract_id === i.contractId &&
                    p.function_name === f.sorobanName,
                )?.exact_grant?.interfaceHash === i.interfaceHash) ||
              (i.sourceKind === "stellar_asset" &&
                f.sorobanName === "transfer" &&
                !!policies.find(
                  (p) =>
                    p.contract_id === i.contractId &&
                    p.function_name === f.sorobanName,
                )?.limits))),
      ),
    };
  }
  async executor(a: AgentIdentity, i: ContractInterface) {
    const policies = await this.policies(a),
      wallet = (await this.wallets(a)).find((w) => w.active);
    const config = {
      ...this.config,
      writeMode: this.config.writeMode,
      simulationSource: wallet?.address ?? this.config.simulationSource,
      policies: policies.map((p) => ({
        contractId: p.contract_id,
        function: p.function_name,
        mode: p.mode,
        principals: [agentPrincipal(a)],
      })),
    };
    const e = new Executor(
      config,
      this.server,
      this.store,
      wallet
        ? {
            address: wallet.address,
            sign_transaction_envelope: async () => fail("SIGNING_FAILED"),
            sign_authorization_entries: async () => fail("SIGNING_FAILED"),
          }
        : undefined,
    );
    const call = e.call.bind(e);
    e.call = async (i, f, args, principal, key) =>
      f.mode === "WRITE"
        ? this.enqueue(a, i, f, args, key)
        : call(i, f, args, principal, key);
    return { executor: e, interface: this.callable(i, policies, wallet) };
  }
  async enqueue(
    a: AgentIdentity,
    i: ContractInterface,
    f: FunctionModel,
    args: unknown,
    key?: string,
  ) {
    if (!this.config.writeMode) fail("WRITE_NOT_PERMITTED");
    if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) fail("INVALID_ARGUMENT");
    const values = argumentsFor(f, args);
    const policy = (await this.policies(a)).find(
      (p) =>
        p.contract_id === i.contractId &&
        p.function_name === f.sorobanName &&
        p.mode === "WRITE",
    );
    const wallet = (await this.wallets(a)).find((w) => w.active);
    if (!policy || !wallet) fail("WRITE_NOT_PERMITTED");
    if (wallet.mode === "managed")
      this.checkManaged(
        i,
        f,
        values,
        wallet,
        policy.limits,
        policy.exact_grant,
      );
    const fingerprint = digest(
      canonical({
        interfaceHash: i.interfaceHash,
        args: values,
        contract: i.contractId,
        function: f.sorobanName,
        walletId: wallet.id,
        walletRevision: wallet.revision,
        policyRevision: policy.revision,
      }),
    );
    const id = randomUUID();
    const r = await this.store.pool.query(
      "INSERT INTO stellar_operations(id,agent_id,instance_id,owner_id,credential_id,network,contract_id,function_name,interface_hash,function_model,arguments,request_fingerprint,idempotency_key,wallet_id,wallet_revision,policy_revision,state,fee_limit) VALUES($1,$2,$3,$4,$5,'testnet',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(agent_id,instance_id,network,idempotency_key) DO NOTHING RETURNING id",
      [
        id,
        a.agentId,
        a.instanceId,
        a.ownerId,
        a.credentialId,
        i.contractId,
        f.sorobanName,
        i.interfaceHash,
        f,
        values,
        fingerprint,
        key,
        wallet.id,
        wallet.revision,
        policy.revision,
        wallet.mode === "freighter" ? "AWAITING_APPROVAL" : "READY",
        wallet.mode === "managed"
          ? (policy.exact_grant?.maxFee ?? this.config.maxFee ?? "2000000")
          : (this.config.maxFee ?? "2000000"),
      ],
    );
    const op = await this.operation(a, r.rows[0]?.id ?? "", key);
    if (op.request_fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
    return this.publicOperation(op);
  }
  checkManaged(
    i: ContractInterface,
    f: FunctionModel,
    args: Record<string, unknown>,
    wallet: Wallet,
    limits: Limits | null,
    grant?: import("./exact-grant.js").ExactGrant | null,
  ) {
    if (grant) {
      checkExactGrant(i, f, args, checkedGrant(grant));
      return;
    }
    if (
      i.sourceKind !== "stellar_asset" ||
      f.sorobanName !== "transfer" ||
      !limits
    )
      fail("WRITE_NOT_PERMITTED");
    if (
      args.from !== wallet.address ||
      typeof args.amount !== "string" ||
      !/^[1-9][0-9]*$/.test(args.amount) ||
      !limits.recipients.includes(args.to_mux as string) ||
      BigInt(args.amount) > BigInt(limits.perTransfer)
    )
      fail("WRITE_NOT_PERMITTED");
  }
  async operation(
    a: AgentIdentity,
    id: string,
    key?: string,
  ): Promise<ProductOperation> {
    const r = await this.store.pool.query(
      "SELECT * FROM stellar_operations WHERE agent_id=$1 AND instance_id=$2 AND owner_id=$3 AND (id::text=$4 OR idempotency_key=$5)",
      [a.agentId, a.instanceId, a.ownerId, id, key ?? null],
    );
    if (!r.rowCount) fail("UNAUTHORIZED");
    return r.rows[0];
  }
  publicOperation(o: ProductOperation): Record<string, unknown> {
    return o.result
      ? {
          ...o.result,
          result_status: o.result.result_status ?? o.state,
          operation_id: o.id,
          can_cancel: false,
        }
      : {
          ok: true,
          operation_id: o.id,
          result_status: o.state === "READY" ? "PENDING" : o.state,
          mode: "WRITE",
          network: o.network,
          contract_id: o.contract_id,
          function_name: o.function_name,
          can_cancel: ["AWAITING_APPROVAL", "READY", "PREPARING"].includes(
            o.state,
          ),
        };
  }
  async status(a: AgentIdentity, id: string): Promise<Record<string, unknown>> {
    const o = await this.operation(a, id);
    return o.state === "TIMEOUT"
      ? this.reconcile(a, id)
      : this.publicOperation(o);
  }
  async list(a: AgentIdentity) {
    return (
      await this.store.pool.query(
        "SELECT * FROM stellar_operations WHERE agent_id=$1 AND instance_id=$2 AND owner_id=$3 ORDER BY created_at DESC LIMIT 50",
        [a.agentId, a.instanceId, a.ownerId],
      )
    ).rows.map((o: ProductOperation) => ({
      ...this.publicOperation(o),
      arguments: o.arguments,
      wallet_id: o.wallet_id,
      max_fee: o.fee_limit ?? this.config.maxFee ?? "2000000",
      signing_ready: !!this.pending.get(o.id)?.peek(),
    }));
  }
  async approve(a: AgentIdentity, id: string, approve: boolean) {
    await this.operation(a, id);
    const client = await this.store.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockIdentity(client, a);
      const op = (
        await client.query(
          "SELECT * FROM stellar_operations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0] as ProductOperation;
      if (approve) {
        if (op.state !== "AWAITING_APPROVAL") fail("WRITE_NOT_PERMITTED");
        await client.query(
          "UPDATE stellar_operations SET state='READY' WHERE id=$1",
          [id],
        );
      } else {
        if (!["AWAITING_APPROVAL", "READY", "PREPARING"].includes(op.state))
          fail("WRITE_NOT_PERMITTED");
        const attempt = await client.query(
          "SELECT transaction_hash FROM stellar_write_attempts WHERE principal=$1 AND network=$2 AND idempotency_key=$3",
          [agentPrincipal(a), "testnet", op.idempotency_key],
        );
        if (attempt.rows[0]?.transaction_hash) fail("WRITE_NOT_PERMITTED");
        await client.query(
          "UPDATE stellar_operations SET state='CANCELLED',result=$2 WHERE id=$1",
          [
            id,
            {
              ok: false,
              result_status: "CANCELLED",
              error_code: "WRITE_NOT_PERMITTED",
              human_message: "Cancelled before submission.",
            },
          ],
        );
      }
      await client.query("COMMIT");
      if (!approve) this.pending.get(id)?.close();
      return { ok: true };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async signing(a: AgentIdentity, id: string) {
    await this.operation(a, id);
    return { request: this.pending.get(id)?.peek() ?? null };
  }
  async complete(
    a: AgentIdentity,
    id: string,
    requestId: string,
    result: unknown,
  ) {
    await this.operation(a, id);
    const signer = this.pending.get(id);
    if (!signer) fail("SIGNING_FAILED");
    signer.complete(requestId, result);
    return { ok: true };
  }
  async guard(client: pg.PoolClient, o: ProductOperation, reserve: boolean) {
    const a = {
      agentId: o.agent_id,
      instanceId: o.instance_id,
      ownerId: o.owner_id,
      credentialId: o.credential_id,
    };
    await this.lockIdentity(client, a);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "policies:" + o.instance_id,
    ]);
    const op = await client.query(
      "SELECT id FROM stellar_operations WHERE id=$1 AND state='PREPARING' AND lease_owner=$2 AND lease_until>now() FOR UPDATE",
      [o.id, this.workerId],
    );
    if (!op.rowCount) fail("WRITE_NOT_PERMITTED");
    const w = (
      await client.query(
        "SELECT * FROM stellar_wallets WHERE id=$1 AND active AND revision=$2 AND owner_id=$3 AND instance_id=$4 FOR SHARE",
        [o.wallet_id, o.wallet_revision, o.owner_id, o.instance_id],
      )
    ).rows[0] as Wallet | undefined;
    if (!w) fail("WRITE_NOT_PERMITTED");
    const p = (
      await client.query(
        "SELECT * FROM stellar_tool_policies WHERE agent_id=$1 AND instance_id=$2 AND contract_id=$3 AND function_name=$4 AND revision=$5 AND owner_id=$6 AND mode='WRITE' FOR SHARE",
        [
          o.agent_id,
          o.instance_id,
          o.contract_id,
          o.function_name,
          o.policy_revision,
          o.owner_id,
        ],
      )
    ).rows[0] as Policy | undefined;
    if (!p) fail("WRITE_NOT_PERMITTED");
    if (w.mode === "managed") {
      const i = (
        await client.query(
          "SELECT interface FROM stellar_interfaces WHERE network='testnet' AND contract_id=$1 ORDER BY created_at DESC LIMIT 1",
          [o.contract_id],
        )
      ).rows[0]?.interface as ContractInterface | undefined;
      if (!i || i.interfaceHash !== o.interface_hash) fail("STALE_INTERFACE");
      this.checkManaged(
        i,
        o.function_model,
        o.arguments,
        w,
        p.limits,
        p.exact_grant,
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["spending:" + w.id],
      );
      const prior = await client.query(
        "SELECT operation_id FROM stellar_spending WHERE operation_id=$1",
        [o.id],
      );
      if (!prior.rowCount) {
        if (!reserve) fail("WRITE_NOT_PERMITTED");
        const sums = (
          await client.query(
            "SELECT COALESCE(sum(CASE WHEN contract_id=$2 THEN amount ELSE 0 END),0) AS amount,COALESCE(sum(fee),0) AS fee FROM stellar_spending WHERE wallet_id=$1 AND (state='RESERVED' OR (state='SETTLED' AND settled_at>now()-interval '24 hours'))",
            [w.id, o.contract_id],
          )
        ).rows[0];
        const grant = p.exact_grant ? checkedGrant(p.exact_grant) : undefined;
        const fee =
          o.fee_limit ?? grant?.maxFee ?? this.config.maxFee ?? "2000000";
        if (grant && fee !== grant.maxFee) fail("WRITE_NOT_PERMITTED");
        const amount = grant ? "0" : (o.arguments.amount as string);
        if (grant) {
          const count = await client.query(
            "SELECT count(*)::integer AS n FROM stellar_call_reservations r JOIN stellar_spending s USING(operation_id) WHERE r.wallet_id=$1 AND r.contract_id=$2 AND r.function_name=$3 AND (s.state='RESERVED' OR (s.state='SETTLED' AND s.settled_at>now()-interval '24 hours'))",
            [w.id, o.contract_id, o.function_name],
          );
          if (
            Number(count.rows[0].n) >= grant.maxCalls ||
            BigInt(sums.fee) + BigInt(fee) > BigInt(grant.rollingFee) ||
            BigInt(sums.fee) + BigInt(fee) > MAX_DAILY_FEE
          )
            fail("WRITE_NOT_PERMITTED");
        }
        if (
          !grant &&
          (BigInt(sums.amount) + BigInt(o.arguments.amount as string) >
            BigInt(p.limits!.rollingAmount) ||
            BigInt(sums.fee) + BigInt(fee) > BigInt(p.limits!.rollingFee))
        )
          fail("WRITE_NOT_PERMITTED");
        await client.query(
          "INSERT INTO stellar_spending VALUES($1,$2,$3,$4,$5,$6,$7,'RESERVED',NULL)",
          [o.id, o.agent_id, o.instance_id, w.id, o.contract_id, amount, fee],
        );
        if (grant)
          await client.query(
            "INSERT INTO stellar_call_reservations(operation_id,wallet_id,contract_id,function_name,policy_revision) VALUES($1,$2,$3,$4,$5)",
            [o.id, w.id, o.contract_id, o.function_name, p.revision],
          );
      }
    }
  }
  async settle(o: ProductOperation, result: Record<string, unknown>) {
    if (result.result_status === "TIMEOUT") return;
    const confirmed =
      result.result_status === "SUBMITTED_AND_CONFIRMED" ||
      result.result_status === "FAILED_ON_CHAIN";
    await this.store.pool.query(
      "UPDATE stellar_spending SET state=$2,amount=CASE WHEN $3 THEN amount ELSE 0 END,fee=$4,settled_at=now() WHERE operation_id=$1 AND state='RESERVED'",
      [
        o.id,
        confirmed ? "SETTLED" : "RELEASED",
        result.result_status === "SUBMITTED_AND_CONFIRMED",
        confirmed
          ? String(result.fee_charged ?? this.config.maxFee ?? "2000000")
          : "0",
      ],
    );
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 500);
    this.timer.unref();
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const s of this.pending.values()) s.close();
    await Promise.allSettled([...this.activeRuns]);
  }
  async recoverExpired() {
    const client = await this.store.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query(
        "SELECT * FROM stellar_operations WHERE state IN ('PREPARING','INTENT') AND lease_until<now() ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 100",
      );
      for (const o of expired.rows) {
        const attempt = (
          await client.query(
            "SELECT transaction_hash FROM stellar_write_attempts WHERE principal=$1 AND network='testnet' AND idempotency_key=$2",
            [
              agentPrincipal({
                agentId: o.agent_id,
                instanceId: o.instance_id,
              }),
              o.idempotency_key,
            ],
          )
        ).rows[0];
        const hash = attempt?.transaction_hash;
        const result = hash
          ? {
              ok: false,
              error_code: "TRANSACTION_PENDING_TIMEOUT",
              result_status: "TIMEOUT",
              transaction_hash: hash,
            }
          : {
              ok: false,
              error_code: "WRITE_NOT_PERMITTED",
              result_status: "INTERRUPTED",
              human_message:
                "Preparation interrupted; inspect status and create a new explicitly approved request.",
            };
        await client.query(
          "UPDATE stellar_operations SET state=$2,result=$3,updated_at=now() WHERE id=$1",
          [o.id, hash ? "TIMEOUT" : "INTERRUPTED", result],
        );
        if (!hash)
          await client.query(
            "UPDATE stellar_spending SET state='RELEASED',amount=0,fee=0,settled_at=now() WHERE operation_id=$1 AND state='RESERVED'",
            [o.id],
          );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async tick() {
    if (this.working || this.stopping || this.activeRuns.size >= 2) return;
    this.working = true;
    try {
      await this.recoverExpired();
      const r = await this.store.pool.query(
        "UPDATE stellar_operations SET state='PREPARING',lease_owner=$1,lease_until=now()+interval '30 seconds' WHERE id=(SELECT ready.id FROM stellar_operations ready JOIN stellar_wallets rw ON rw.id=ready.wallet_id WHERE ready.state='READY' AND NOT EXISTS(SELECT 1 FROM stellar_operations busy JOIN stellar_wallets bw ON bw.id=busy.wallet_id WHERE bw.address=rw.address AND busy.state IN ('PREPARING','INTENT','TIMEOUT')) ORDER BY ready.created_at FOR UPDATE OF ready SKIP LOCKED LIMIT 1) RETURNING *",
        [this.workerId],
      );
      if (r.rowCount) {
        const task = this.run(r.rows[0]).catch(() => {});
        this.activeRuns.add(task);
        void task.finally(() => this.activeRuns.delete(task));
      }
    } finally {
      this.working = false;
    }
  }
  async run(o: ProductOperation) {
    const pulse = setInterval(() => {
      void this.store.pool
        .query(
          "UPDATE stellar_operations SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 AND state IN ('PREPARING','INTENT') AND lease_until>now()",
          [o.id, this.workerId],
        )
        .catch(() => {});
    }, 5000);
    pulse.unref();
    let result: Record<string, unknown>;
    try {
      const client = await this.store.pool.connect();
      try {
        await client.query("BEGIN");
        await this.guard(client, o, true);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      const wallet = (
        await this.store.pool.query(
          "SELECT * FROM stellar_wallets WHERE id=$1",
          [o.wallet_id],
        )
      ).rows[0] as Wallet;
      const i = await this.store.get("testnet", o.contract_id);
      if (!i || i.interfaceHash !== o.interface_hash) fail("STALE_INTERFACE");
      const signer =
        wallet.mode === "freighter"
          ? new BrowserSigner(wallet.address)
          : managedSigner(
              wallet.address,
              wallet.id,
              o.id,
              this.options.signerUrl,
              this.options.signerToken,
            );
      if (signer instanceof BrowserSigner) this.pending.set(o.id, signer);
      const policy = (
        await this.policies({
          agentId: o.agent_id,
          instanceId: o.instance_id,
          ownerId: o.owner_id,
          credentialId: o.credential_id,
        })
      ).find(
        (p) =>
          p.contract_id === o.contract_id &&
          p.function_name === o.function_name &&
          p.revision === o.policy_revision,
      );
      if (!policy) fail("WRITE_NOT_PERMITTED");
      const config = {
        ...this.config,
        writeMode: this.config.writeMode,
        maxFee:
          o.fee_limit ??
          (wallet.mode === "managed"
            ? policy.exact_grant?.maxFee
            : undefined) ??
          this.config.maxFee ??
          "2000000",
        policies: [
          {
            contractId: o.contract_id,
            function: o.function_name,
            mode: "WRITE" as const,
            principals: [
              agentPrincipal({
                agentId: o.agent_id,
                instanceId: o.instance_id,
              }),
            ],
          },
        ],
      };
      const executor = new Executor(
        config,
        this.server,
        this.store,
        signer,
        async (client, metadata) => {
          await this.guard(client, o, false);
          await client.query(
            "UPDATE stellar_operations SET state='INTENT',result=$2 WHERE id=$1",
            [
              o.id,
              {
                ok: true,
                result_status: "PENDING",
                transaction_hash: metadata.hash,
                mode: "WRITE",
                network: "testnet",
                contract_id: o.contract_id,
                function_name: o.function_name,
              },
            ],
          );
        },
      );
      result = await executor.call(
        i,
        o.function_model,
        o.arguments,
        agentPrincipal({ agentId: o.agent_id, instanceId: o.instance_id }),
        o.idempotency_key,
      );
    } catch (e) {
      result = envelope(e);
    } finally {
      clearInterval(pulse);
      this.pending.get(o.id)?.close();
      this.pending.delete(o.id);
    }
    if (
      !["SUBMITTED_AND_CONFIRMED", "FAILED_ON_CHAIN", "TIMEOUT"].includes(
        String(result.result_status),
      )
    ) {
      const durable = await this.store.find(
        agentPrincipal({ agentId: o.agent_id, instanceId: o.instance_id }),
        "testnet",
        o.idempotency_key,
      );
      if (
        durable?.transaction_hash &&
        ["INTENT", "PENDING", "TIMEOUT"].includes(durable.state)
      )
        result = {
          ok: false,
          result_status: "TIMEOUT",
          error_code: "TRANSACTION_PENDING_TIMEOUT",
          transaction_hash: durable.transaction_hash,
        };
    }
    const state =
      result.result_status === "SUBMITTED_AND_CONFIRMED"
        ? "SUCCESS"
        : result.result_status === "FAILED_ON_CHAIN"
          ? "FAILED"
          : result.result_status === "TIMEOUT"
            ? "TIMEOUT"
            : "REJECTED";
    await this.settle(o, result);
    await this.store.pool.query(
      "UPDATE stellar_operations SET state=$2,result=$3,updated_at=now() WHERE id=$1 AND lease_owner=$4 AND state IN ('PREPARING','INTENT','TIMEOUT')",
      [o.id, state, result, this.workerId],
    );
  }
  async reconcile(
    a: AgentIdentity,
    id: string,
    expire = false,
  ): Promise<Record<string, unknown>> {
    const o = await this.operation(a, id);
    const attempt = await this.store.find(
      agentPrincipal(a),
      "testnet",
      o.idempotency_key,
    );
    if (!attempt?.transaction_hash) return this.publicOperation(o);
    return this.store.lock(
      "testnet",
      attempt.source_account,
      async (client) => {
        const executor = new Executor(
          { ...this.config, pollTimeoutMs: 1000 },
          this.server,
          this.store,
        );
        const { returns: _, ...ctx } = attempt.request;
        const result = await executor.reconcile(attempt, o.function_model, ctx);
        if (expire && result.result_status === "TIMEOUT") {
          const metadata = (
            await client.query(
              "SELECT signed_sequence,signed_max_time FROM stellar_write_attempts WHERE id=$1",
              [attempt.id],
            )
          ).rows[0];
          const net = await this.server.getNetwork();
          if (net.passphrase !== this.config.networkPassphrase)
            fail("INVALID_ARGUMENT");
          const latest = await this.server.getLatestLedger();
          const ledgers = await this.server.getLedgers({
            startLedger: latest.sequence,
            pagination: { limit: 1 },
          });
          const closing = ledgers.ledgers.find(
              (l) => l.sequence === latest.sequence,
            ),
            close = closing?.ledgerCloseTime;
          const snapshot = await this.server.getLedgerEntries(
            xdr.LedgerKey.account(
              new xdr.LedgerKeyAccount({
                accountId: Keypair.fromPublicKey(
                  attempt.source_account,
                ).xdrAccountId(),
              }),
            ),
          );
          const entry = snapshot.entries[0]?.val;
          const sequence =
            entry?.type === "account" ? entry.account.seqNum : undefined;
          if (
            metadata.signed_sequence &&
            metadata.signed_max_time &&
            BigInt(metadata.signed_max_time) > 0n &&
            close &&
            snapshot.latestLedger >= latest.sequence &&
            sequence !== undefined &&
            BigInt(close) > BigInt(metadata.signed_max_time) &&
            BigInt(sequence) < BigInt(metadata.signed_sequence)
          ) {
            const proof = {
              ok: false,
              result_status: "EXPIRED_UNSUBMITTED",
              error_code: "WRITE_NOT_PERMITTED",
              transaction_hash: attempt.transaction_hash,
              human_message:
                "Ledger expiry and source sequence prove this envelope can no longer execute.",
            };
            await this.store.update(attempt.id, "ABANDONED", proof);
            await this.settle(o, proof);
            await this.store.pool.query(
              "UPDATE stellar_operations SET state='EXPIRED_UNSUBMITTED',result=$2 WHERE id=$1",
              [id, proof],
            );
            return { ...proof, operation_id: id };
          }
        }
        if (result.result_status !== "TIMEOUT") {
          await this.settle(o, result);
          await this.store.pool.query(
            "UPDATE stellar_operations SET state=$2,result=$3 WHERE id=$1",
            [
              id,
              result.result_status === "SUBMITTED_AND_CONFIRMED"
                ? "SUCCESS"
                : result.result_status === "EXPIRED_UNSUBMITTED"
                  ? "EXPIRED_UNSUBMITTED"
                  : "FAILED",
              result,
            ],
          );
        }
        return { ...result, operation_id: id };
      },
    );
  }
}
