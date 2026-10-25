import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Asset, contract, StrKey, xdr } from "@stellar/stellar-sdk";
import { fail } from "./errors.js";
import { inspectSpec, ingest, type WasmRpc } from "./ingestion.js";
import type { Config } from "./config.js";
import type { ContractInterface } from "./model.js";
const fixtureRoot = new URL(
  import.meta.url.includes("/dist/") ? "../../fixtures/" : "../fixtures/",
  import.meta.url,
);
const fixture = JSON.parse(
  readFileSync(new URL("sac-v29.json", fixtureRoot), "utf8"),
) as {
  protocols: number[];
  source: string;
  sourceSha256: string;
  adapterVersion: number;
  encodingVersion: number;
  methods: {
    name: string;
    params: { name: string; type: string }[];
    returns: string;
  }[];
};
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
if (
  hash(readFileSync(new URL("sac-v29.contract.rs", fixtureRoot))) !==
  fixture.sourceSha256
)
  fail("SPEC_PARSE_FAILED");
export const assetProvenance = {
  source: fixture.source,
  source_sha256: fixture.sourceSha256,
  protocols: fixture.protocols,
};
export function assetSpec(protocol: number) {
  if (!fixture.protocols.includes(protocol)) fail("UNSUPPORTED_PROTOCOL");
  const types: Record<string, () => xdr.ScSpecTypeDef> = {
    Address: () => xdr.ScSpecTypeDef.scSpecTypeAddress(),
    MuxedAddress: () => xdr.ScSpecTypeDef.scSpecTypeMuxedAddress(),
    i128: () => xdr.ScSpecTypeDef.scSpecTypeI128(),
    u32: () => xdr.ScSpecTypeDef.scSpecTypeU32(),
    bool: () => xdr.ScSpecTypeDef.scSpecTypeBool(),
    String: () => xdr.ScSpecTypeDef.scSpecTypeString(),
    void: () => xdr.ScSpecTypeDef.scSpecTypeVoid(),
  };
  return new contract.Spec(
    fixture.methods.map((f) =>
      xdr.ScSpecEntry.scSpecEntryFunctionV0(
        new xdr.ScSpecFunctionV0({
          name: f.name,
          doc: `Stellar Asset Contract ${f.name}. Amounts are exact base-unit decimal strings.`,
          inputs: f.params.map(
            (p) =>
              new xdr.ScSpecFunctionInputV0({
                name: p.name,
                doc: "",
                type: types[p.type](),
              }),
          ),
          outputs: f.returns === "void" ? [] : [types[f.returns]()],
        }),
      ),
    ),
  );
}
export function assetInterface(
  c: Config,
  id: string,
  protocol: number,
): ContractInterface {
  const spec = assetSpec(protocol);
  const interfaceHash = hash(
    JSON.stringify({
      spec: spec.entries.map((e) => e.toXdr("base64")),
      protocol,
      adapter: fixture.adapterVersion,
      encoding: fixture.encodingVersion,
    }),
  );
  const i = inspectSpec(spec, c, id, {
    sourceKind: "stellar_asset",
    interfaceHash,
    protocolVersion: protocol,
  });
  const native = id === Asset.native().contractId(c.networkPassphrase);
  if (native) {
    i.asset = { kind: "native" };
    const unsupported = new Set([
      "admin",
      "set_admin",
      "mint",
      "clawback",
      "set_authorized",
      "burn",
      "burn_from",
      "trust",
    ]);
    for (const m of i.inventory!)
      if (unsupported.has(m.name)) {
        m.restriction = "Unavailable for native XLM.";
        m.eligible = false;
        m.error_code = "ASSET_OPERATION_UNSUPPORTED";
      }
    i.functions = i.functions.filter((f) => !unsupported.has(f.sorobanName));
  }
  return i;
}
export type AssetDescriptor = NonNullable<ContractInterface["asset"]>;
export async function ingestAsset(
  server: WasmRpc,
  c: Config,
  asset: AssetDescriptor,
) {
  if (
    asset.kind !== "native" &&
    (asset.kind !== "issued" ||
      !/^[a-zA-Z0-9]{1,12}$/.test(asset.code) ||
      !StrKey.isValidEd25519PublicKey(asset.issuer))
  )
    fail("INVALID_ARGUMENT");
  const id = (
    asset.kind === "native"
      ? Asset.native()
      : new Asset(asset.code, asset.issuer)
  ).contractId(c.networkPassphrase);
  const i = await ingest(server, c, id);
  if (i.sourceKind !== "stellar_asset") fail("SPEC_PARSE_FAILED");
  i.asset = asset;
  return i;
}
export function parseAmount(amount: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 38 ||
    !/^\d+(?:\.\d+)?$/.test(amount)
  )
    fail("INVALID_ARGUMENT");
  const [whole, fraction = ""] = amount.split(".");
  if (
    (whole.length > 1 && whole.startsWith("0")) ||
    fraction.length > decimals ||
    whole.length > 39
  )
    fail("INVALID_ARGUMENT");
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units > (1n << 127n) - 1n) fail("INVALID_ARGUMENT");
  return units.toString();
}
export function formatAmount(units: string, decimals: number): string {
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(units) ||
    units.length > 39 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 38 ||
    BigInt(units) > (1n << 127n) - 1n
  )
    fail("INVALID_ARGUMENT");
  if (!decimals) return units;
  const s = units.padStart(decimals + 1, "0");
  return s.slice(0, -decimals) + "." + s.slice(-decimals);
}
