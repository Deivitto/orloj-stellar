import {
  Asset,
  Horizon,
  Keypair,
  LiquidityPoolAsset,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config.js";
import { permitted } from "./config.js";
import { formatAmount, parseAmount } from "./assets.js";
import { budget, model, validator } from "./codec.js";
import { fail, mapped } from "./errors.js";
import type { ContractInterface, FunctionModel, TypeNode } from "./model.js";
import type { Signer } from "./signer.js";
import { digest } from "./store.js";
export const classicIds = [
  "classic:stellar-dex",
  "classic:stellar-amm",
] as const;
export const isClassic = (i: ContractInterface) =>
  i.sourceKind === "classic_dex" || i.sourceKind === "classic_amm";
const str: TypeNode = { kind: "String" },
  amount: TypeNode = { kind: "i128" },
  uint: TypeNode = { kind: "u64" },
  hash: TypeNode = { kind: "BytesN", size: 32 };
const struct = (fields: Record<string, TypeNode>): TypeNode => ({
  kind: "Struct",
  fields: Object.entries(fields).map(([name, type]) => ({
    name,
    type,
    description: "",
  })),
});
const vec = (item: TypeNode): TypeNode => ({ kind: "Vec", item });
const price = struct({ n: { kind: "u32" }, d: { kind: "u32" } });
const level = struct({ amount, price });
const balance = struct({
  asset: str,
  balance: amount,
  buying_liabilities: amount,
  selling_liabilities: amount,
  authorized: { kind: "bool" },
});
const offer = struct({ id: uint, selling: str, buying: str, amount, price });
const pool = struct({
  pool_id: hash,
  total_shares: amount,
  total_trustlines: uint,
  reserves: vec(struct({ asset: str, amount })),
});
const definitions: Record<
  string,
  {
    params: Record<string, TypeNode>;
    returns: TypeNode;
    mode: "READ" | "WRITE";
    description: string;
  }
> = {
  account_balances: {
    params: { account: { kind: "Address" } },
    returns: vec(balance),
    mode: "READ",
    description:
      "Read classic balances and liabilities. Amounts are exact base-unit decimal strings (7 decimals).",
  },
  offers: {
    params: { account: { kind: "Address" }, limit: { kind: "u32" } },
    returns: vec(offer),
    mode: "READ",
    description: "Read at most 100 classic offers for an account.",
  },
  orderbook: {
    params: { selling: str, buying: str, limit: { kind: "u32" } },
    returns: struct({ bids: vec(level), asks: vec(level) }),
    mode: "READ",
    description:
      "Read classic order-book prices as exact numerator/denominator pairs. Assets: native or CODE:ISSUER.",
  },
  liquidity_pool: {
    params: { pool_id: hash },
    returns: pool,
    mode: "READ",
    description: "Read a classic constant-product pool and its reserves.",
  },
  change_trust: {
    params: { asset: str, limit: amount },
    returns: { kind: "void" },
    mode: "WRITE",
    description:
      "Set a classic asset trustline limit in base units. Zero removes an empty trustline. Owner approval required.",
  },
  manage_offer: {
    params: { selling: str, buying: str, amount, price, offer_id: uint },
    returns: { kind: "void" },
    mode: "WRITE",
    description:
      "Create/update a classic sell offer. amount is base units; price is buying units per selling unit as n/d. offer_id 0 creates, amount 0 cancels. The offer may execute immediately.",
  },
  trust_pool: {
    params: { asset_a: str, asset_b: str, limit: amount },
    returns: { kind: "void" },
    mode: "WRITE",
    description:
      "Create a pool-share trustline for a 30-bps classic constant-product pool. Assets must be canonically ordered; underlying asset trustlines are required.",
  },
  pool_deposit: {
    params: {
      pool_id: hash,
      max_amount_a: amount,
      max_amount_b: amount,
      min_price: price,
      max_price: price,
    },
    returns: { kind: "void" },
    mode: "WRITE",
    description:
      "Deposit into a classic pool with exact base-unit maxima and rational price bounds. Owner approval required.",
  },
  pool_withdraw: {
    params: {
      pool_id: hash,
      amount,
      min_amount_a: amount,
      min_amount_b: amount,
    },
    returns: { kind: "void" },
    mode: "WRITE",
    description:
      "Withdraw classic pool shares with exact base-unit minimum reserve outputs. Owner approval required.",
  },
};
export const classicMode = (name: string) => definitions[name]?.mode;
export function classicInterface(c: Config, id: string): ContractInterface {
  if (!classicIds.includes(id as (typeof classicIds)[number]))
    fail("INVALID_ARGUMENT");
  const names =
    id === "classic:stellar-dex"
      ? [
          "account_balances",
          "offers",
          "orderbook",
          "change_trust",
          "manage_offer",
        ]
      : [
          "account_balances",
          "liquidity_pool",
          "change_trust",
          "trust_pool",
          "pool_deposit",
          "pool_withdraw",
        ];
  const inventory = names.map((name) => {
    const d = definitions[name];
    return {
      name,
      eligible: true,
      allowedMode: d.mode,
      policyStatus: c.policies.some(
        (p) => p.contractId === id && p.function === name,
      )
        ? ("enabled" as const)
        : ("disabled" as const),
      signature: {
        sorobanName: name,
        mcpToolName: name,
        description: d.description,
        params: Object.entries(d.params).map(([name, node]) => {
          const type = model(node);
          return {
            name,
            type,
            sorobanType: type.sorobanType,
            jsonSchema: type.jsonSchema,
            converterId: type.converterId,
            description: "",
            required: true,
          };
        }),
        returns: model(d.returns),
      },
    };
  });
  return {
    network: c.network,
    contractId: id,
    sourceKind: id === "classic:stellar-dex" ? "classic_dex" : "classic_amm",
    interfaceHash: digest(
      JSON.stringify({
        adapter: "orloj-classic-v1",
        network: c.network,
        inventory: inventory.map((m) => m.signature),
      }),
    ),
    encodingVersion: 1,
    inventory,
    functions: inventory.flatMap((m) => {
      const p = c.policies.find(
        (p) => p.contractId === id && p.function === m.name,
      );
      if (!p) return [];
      if (p.mode !== definitions[m.name].mode) fail("INVALID_ARGUMENT");
      return [
        {
          ...m.signature,
          mode: p.mode,
          simulationSafe: false,
          writeAllowed: p.mode === "WRITE" && c.writeMode,
        },
      ];
    }),
    excluded: [],
    generatedAt: new Date().toISOString(),
  };
}
export function classicHorizon(c: Config) {
  return new Horizon.Server(
    c.network === "testnet"
      ? "https://horizon-testnet.stellar.org"
      : "https://horizon.stellar.org",
  );
}
export function classicAsset(value: unknown): Asset {
  if (value === "native") return Asset.native();
  if (typeof value !== "string") fail("INVALID_ARGUMENT");
  const parts = value.split(":");
  if (
    parts.length !== 2 ||
    !StrKey.isValidEd25519PublicKey(parts[1]) ||
    !/^[a-zA-Z0-9]{1,12}$/.test(parts[0])
  )
    fail("INVALID_ARGUMENT");
  return new Asset(parts[0], parts[1]);
}
function account(v: unknown): string {
  if (typeof v !== "string" || !StrKey.isValidEd25519PublicKey(v))
    fail("INVALID_ARGUMENT");
  return v;
}
function limit(v: unknown) {
  if (typeof v !== "number" || v < 1 || v > 100) fail("INVALID_ARGUMENT");
  return v;
}
function units(v: unknown, zero = true) {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(v) ||
    BigInt(v) > 9223372036854775807n ||
    (!zero && v === "0")
  )
    fail("INVALID_ARGUMENT");
  return formatAmount(v, 7);
}
function rational(v: unknown) {
  const p = v as { n: number; d: number };
  if (
    !p ||
    !Number.isInteger(p.n) ||
    !Number.isInteger(p.d) ||
    p.n < 1 ||
    p.d < 1 ||
    p.n > 2147483647 ||
    p.d > 2147483647
  )
    fail("INVALID_ARGUMENT");
  return p;
}
function orderedPrices(a: unknown, b: unknown) {
  const min = rational(a),
    max = rational(b);
  if (BigInt(min.n) * BigInt(max.d) > BigInt(max.n) * BigInt(min.d))
    fail("INVALID_ARGUMENT");
  return { min, max };
}
function returnedAmount(value: string, decimals: number) {
  try {
    return parseAmount(value, decimals);
  } catch {
    return fail("RESULT_DECODE_FAILED");
  }
}
export async function classicRead(
  c: Config,
  f: FunctionModel,
  args: Record<string, unknown>,
  h = classicHorizon(c),
) {
  let out: unknown;
  switch (f.sorobanName) {
    case "account_balances": {
      const a = await mapped("ACCOUNT_NOT_FOUND", () =>
        h.loadAccount(account(args.account)),
      );
      out = a.balances
        .filter((b) => b.asset_type !== "liquidity_pool_shares")
        .map((b) => ({
          asset:
            b.asset_type === "native"
              ? "native"
              : "asset_code" in b
                ? b.asset_code + ":" + b.asset_issuer
                : "",
          balance: returnedAmount(b.balance, 7),
          buying_liabilities: returnedAmount(
            "buying_liabilities" in b ? b.buying_liabilities : "0",
            7,
          ),
          selling_liabilities: returnedAmount(
            "selling_liabilities" in b ? b.selling_liabilities : "0",
            7,
          ),
          authorized: !("is_authorized" in b) || b.is_authorized === true,
        }));
      break;
    }
    case "offers": {
      const page = await mapped("CLASSIC_QUERY_FAILED", () =>
        h
          .offers()
          .forAccount(account(args.account))
          .limit(limit(args.limit))
          .call(),
      );
      out = page.records.map((o) => ({
        id: o.id,
        selling:
          o.selling.asset_type === "native"
            ? "native"
            : o.selling.asset_code + ":" + o.selling.asset_issuer,
        buying:
          o.buying.asset_type === "native"
            ? "native"
            : o.buying.asset_code + ":" + o.buying.asset_issuer,
        amount: returnedAmount(o.amount, 7),
        price: o.price_r,
      }));
      break;
    }
    case "orderbook": {
      const b = await mapped("CLASSIC_QUERY_FAILED", () =>
        h
          .orderbook(classicAsset(args.selling), classicAsset(args.buying))
          .limit(limit(args.limit))
          .call(),
      );
      out = {
        bids: b.bids.map((v) => ({
          amount: returnedAmount(v.amount, 7),
          price: v.price_r,
        })),
        asks: b.asks.map((v) => ({
          amount: returnedAmount(v.amount, 7),
          price: v.price_r,
        })),
      };
      break;
    }
    case "liquidity_pool": {
      const p = await mapped("CLASSIC_QUERY_FAILED", () =>
        h.liquidityPools().liquidityPoolId(String(args.pool_id)).call(),
      );
      out = {
        pool_id: p.id,
        total_shares: returnedAmount(p.total_shares, 7),
        total_trustlines: p.total_trustlines,
        reserves: p.reserves.map((r) => ({
          asset: r.asset === "native" ? "native" : r.asset,
          amount: returnedAmount(r.amount, 7),
        })),
      };
      break;
    }
    default:
      fail("WRITE_NOT_PERMITTED");
  }
  budget(out, "RESULT_DECODE_FAILED");
  if (!validator(f.returns.node).safeParse(out).success)
    fail("RESULT_DECODE_FAILED");
  return out;
}
export function classicOperation(
  name: string,
  a: Record<string, unknown>,
): xdr.Operation {
  switch (name) {
    case "change_trust": {
      const asset = classicAsset(a.asset);
      if (asset.isNative()) fail("INVALID_ARGUMENT");
      return Operation.changeTrust({ asset, limit: units(a.limit) });
    }
    case "manage_offer": {
      const selling = classicAsset(a.selling),
        buying = classicAsset(a.buying);
      if (
        selling.equals(buying) ||
        BigInt(String(a.offer_id)) > 9223372036854775807n
      )
        fail("INVALID_ARGUMENT");
      return Operation.manageSellOffer({
        selling,
        buying,
        amount: units(a.amount),
        price: rational(a.price),
        offerId: String(a.offer_id),
      });
    }
    case "trust_pool":
      return Operation.changeTrust({
        asset: new LiquidityPoolAsset(
          classicAsset(a.asset_a),
          classicAsset(a.asset_b),
          30,
        ),
        limit: units(a.limit),
      });
    case "pool_deposit": {
      const p = orderedPrices(a.min_price, a.max_price);
      return Operation.liquidityPoolDeposit({
        liquidityPoolId: String(a.pool_id),
        maxAmountA: units(a.max_amount_a, false),
        maxAmountB: units(a.max_amount_b, false),
        minPrice: p.min,
        maxPrice: p.max,
      });
    }
    case "pool_withdraw":
      return Operation.liquidityPoolWithdraw({
        liquidityPoolId: String(a.pool_id),
        amount: units(a.amount, false),
        minAmountA: units(a.min_amount_a),
        minAmountB: units(a.min_amount_b),
      });
    default:
      fail("WRITE_NOT_PERMITTED");
  }
}
export async function prepareClassic(
  c: Config,
  id: string,
  f: FunctionModel,
  a: Record<string, unknown>,
  signer: Signer,
  principal: string,
  h = classicHorizon(c),
): Promise<Transaction> {
  if (
    c.network !== "testnet" ||
    !c.writeMode ||
    permitted(c, id, f.sorobanName, principal)?.mode !== "WRITE"
  )
    fail("WRITE_NOT_PERMITTED");
  const p = definitions[f.sorobanName];
  if (p?.mode !== "WRITE") fail("WRITE_NOT_PERMITTED");
  const source = await mapped("ACCOUNT_NOT_FOUND", () =>
    h.loadAccount(signer.address),
  );
  // Classic transactions have no Soroban simulation endpoint. Horizon supplies current sequence and reserve state; ledger validation is authoritative.
  const root = await mapped("CLASSIC_QUERY_FAILED", () => h.root());
  if (root.network_passphrase !== c.networkPassphrase) fail("INVALID_ARGUMENT");
  const ledger = (
    await mapped("CLASSIC_QUERY_FAILED", () =>
      h.ledgers().order("desc").limit(1).call(),
    )
  ).records[0];
  const operation = classicOperation(f.sorobanName, a);
  const native = source.balances.find((b) => b.asset_type === "native");
  const existing = new Set(
    source.balances.flatMap((b) =>
      "asset_code" in b
        ? [b.asset_code + ":" + b.asset_issuer]
        : b.asset_type === "liquidity_pool_shares"
          ? [b.liquidity_pool_id]
          : [],
    ),
  );
  let extra = 0;
  if (
    f.sorobanName === "change_trust" &&
    !existing.has(String(a.asset)) &&
    BigInt(String(a.limit)) > 0n
  )
    extra = 1;
  if (f.sorobanName === "trust_pool") {
    const poolAsset = new LiquidityPoolAsset(
      classicAsset(a.asset_a),
      classicAsset(a.asset_b),
      30,
    );
    if (!existing.has(poolAsset.toString().slice("liquidity_pool:".length)))
      extra = 2;
    for (const value of [a.asset_a, a.asset_b])
      if (value !== "native" && !existing.has(String(value)))
        fail("ASSET_TRUSTLINE_REQUIRED");
  }
  if (
    f.sorobanName === "manage_offer" &&
    a.offer_id === "0" &&
    a.amount !== "0"
  )
    extra = 1;
  const reserve =
    BigInt(ledger.base_reserve_in_stroops) *
    (2n +
      BigInt(source.subentry_count) +
      BigInt(source.num_sponsoring ?? 0) -
      BigInt(source.num_sponsored ?? 0) +
      BigInt(extra));
  const replaced =
    f.sorobanName === "manage_offer" && a.offer_id !== "0"
      ? await mapped("CLASSIC_QUERY_FAILED", () =>
          h.offers().offer(String(a.offer_id)).call(),
        )
      : undefined;
  if (replaced && replaced.seller !== signer.address) fail("UNAUTHORIZED");
  const assetName = (asset: {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
  }) =>
    asset.asset_type === "native"
      ? "native"
      : asset.asset_code + ":" + asset.asset_issuer;
  const releasedSelling = (asset: Asset) =>
    replaced &&
    assetName(replaced.selling) ===
      (asset.isNative() ? "native" : asset.getCode() + ":" + asset.getIssuer())
      ? BigInt(parseAmount(replaced.amount, 7))
      : 0n;
  const releasedBuying = (asset: Asset) => {
    if (
      !replaced ||
      assetName(replaced.buying) !==
        (asset.isNative()
          ? "native"
          : asset.getCode() + ":" + asset.getIssuer())
    )
      return 0n;
    const n =
        BigInt(parseAmount(replaced.amount, 7)) * BigInt(replaced.price_r.n),
      d = BigInt(replaced.price_r.d);
    return (n + d - 1n) / d;
  };
  const availableNative =
    BigInt(parseAmount(native?.balance ?? "0", 7)) +
    releasedSelling(Asset.native()) -
    BigInt(
      parseAmount(
        native && "selling_liabilities" in native
          ? native.selling_liabilities
          : "0",
        7,
      ),
    );
  const weight = source.signers
    .filter((s) => s.key === signer.address)
    .reduce((n, s) => n + s.weight, 0);
  if (weight < Math.max(1, source.thresholds.med_threshold))
    fail("AUTHORIZATION_FAILED");
  const fee = String(
    await mapped("CLASSIC_QUERY_FAILED", () => h.fetchBaseFee()),
  );
  if (!c.maxFee || BigInt(fee) > BigInt(c.maxFee)) fail("FEE_POLICY_REJECTED");
  if (availableNative - BigInt(fee) < reserve) fail("ASSET_RESERVE_ERROR");
  const line = (asset: Asset) =>
    source.balances.find(
      (b) =>
        "asset_code" in b &&
        b.asset_code === asset.getCode() &&
        b.asset_issuer === asset.getIssuer(),
    );
  function spendable(asset: Asset): bigint {
    if (asset.isNative()) return availableNative - BigInt(fee) - reserve;
    if (asset.getIssuer() === signer.address) return 9223372036854775807n;
    const b = line(asset);
    if (!b) fail("ASSET_TRUSTLINE_REQUIRED");
    if ("is_authorized" in b && !b.is_authorized) fail("ASSET_NOT_AUTHORIZED");
    return (
      BigInt(parseAmount(b.balance, 7)) +
      releasedSelling(asset) -
      BigInt(
        parseAmount(
          "selling_liabilities" in b ? b.selling_liabilities : "0",
          7,
        ),
      )
    );
  }
  function receivable(asset: Asset): bigint {
    if (asset.isNative() || asset.getIssuer() === signer.address)
      return 9223372036854775807n;
    const b = line(asset);
    if (!b) fail("ASSET_TRUSTLINE_REQUIRED");
    if ("is_authorized" in b && !b.is_authorized) fail("ASSET_NOT_AUTHORIZED");
    return (
      BigInt(parseAmount("limit" in b ? b.limit : "0", 7)) +
      releasedBuying(asset) -
      BigInt(parseAmount(b.balance, 7)) -
      BigInt(
        parseAmount("buying_liabilities" in b ? b.buying_liabilities : "0", 7),
      )
    );
  }
  if (f.sorobanName === "change_trust") {
    const b = line(classicAsset(a.asset));
    if (
      b &&
      BigInt(String(a.limit)) <
        BigInt(parseAmount(b.balance, 7)) +
          BigInt(
            parseAmount(
              "buying_liabilities" in b ? b.buying_liabilities : "0",
              7,
            ),
          )
    )
      fail("ASSET_BALANCE_ERROR");
  }
  if (f.sorobanName === "manage_offer" && a.amount !== "0") {
    const selling = classicAsset(a.selling),
      buying = classicAsset(a.buying),
      p = rational(a.price),
      qty = BigInt(String(a.amount));
    // Only the verified source account offer being replaced releases its own liabilities.
    if (
      spendable(selling) < qty ||
      receivable(buying) < (qty * BigInt(p.n) + BigInt(p.d) - 1n) / BigInt(p.d)
    )
      fail("ASSET_BALANCE_ERROR");
  }
  if (f.sorobanName === "pool_deposit" || f.sorobanName === "pool_withdraw") {
    const pool = await mapped("CLASSIC_QUERY_FAILED", () =>
      h.liquidityPools().liquidityPoolId(String(a.pool_id)).call(),
    );
    const shares = source.balances.find(
      (b) =>
        b.asset_type === "liquidity_pool_shares" &&
        b.liquidity_pool_id === a.pool_id,
    );
    if (!shares) fail("ASSET_TRUSTLINE_REQUIRED");
    if (f.sorobanName === "pool_deposit") {
      if (
        spendable(classicAsset(pool.reserves[0].asset)) <
          BigInt(String(a.max_amount_a)) ||
        spendable(classicAsset(pool.reserves[1].asset)) <
          BigInt(String(a.max_amount_b))
      )
        fail("ASSET_BALANCE_ERROR");
    } else {
      const qty = BigInt(String(a.amount)),
        total = BigInt(parseAmount(pool.total_shares, 7));
      if (qty > BigInt(parseAmount(shares.balance, 7)) || total === 0n)
        fail("ASSET_BALANCE_ERROR");
      for (const [n, r] of pool.reserves.entries()) {
        const proceeds = (BigInt(parseAmount(r.amount, 7)) * qty) / total;
        if (
          proceeds < BigInt(String(n === 0 ? a.min_amount_a : a.min_amount_b))
        )
          fail("INVALID_ARGUMENT");
        if (receivable(classicAsset(r.asset)) < proceeds)
          fail("ASSET_BALANCE_ERROR");
      }
    }
  }
  const unsigned = new TransactionBuilder(source, {
    fee,
    networkPassphrase: c.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  const signature = await mapped("SIGNING_FAILED", () =>
    signer.sign_transaction_envelope(unsigned.toXdr(), {
      networkPassphrase: c.networkPassphrase,
      address: signer.address,
    }),
  );
  if (
    signature.error ||
    !signature.signedTxXdr ||
    signature.signerAddress !== signer.address
  )
    fail("SIGNING_FAILED");
  const signed = await mapped("SIGNING_FAILED", async () =>
    TransactionBuilder.fromXdr(signature.signedTxXdr!, c.networkPassphrase),
  );
  if (
    !("source" in signed) ||
    signed.source !== signer.address ||
    !Buffer.from(signed.hash()).equals(Buffer.from(unsigned.hash())) ||
    !signed.signatures.some((s) =>
      Keypair.fromPublicKey(signer.address).verify(
        signed.hash(),
        s.signature.value,
      ),
    )
  )
    fail("SIGNING_FAILED");
  if (
    !signed.timeBounds ||
    BigInt(signed.timeBounds.maxTime) * 1000n <= BigInt(Date.now())
  )
    fail("SIGNING_FAILED");
  return signed;
}
