import { createHash } from "node:crypto";
import { contract, StrKey, xdr } from "@stellar/stellar-sdk";
import { model } from "./codec.js";
import { fail, RegistryError, mapped } from "./errors.js";
import type { Config } from "./config.js";
import type { ContractInterface, TypeNode } from "./model.js";
export const wasmHash = (wasm: Uint8Array) =>
  createHash("sha256").update(wasm).digest("hex");
export function contractId(id: string) {
  if (!StrKey.isValidContract(id)) fail("INVALID_CONTRACT_ID");
  return id;
}
export function parseType(
  t: xdr.ScSpecTypeDef,
  entries: xdr.ScSpecEntry[],
  path: string[] = [],
): TypeNode {
  if (path.length > 8) fail("TYPE_DEPTH_EXCEEDED");
  const leaves: Record<string, TypeNode["kind"]> = {
    scSpecTypeBool: "bool",
    scSpecTypeU32: "u32",
    scSpecTypeI32: "i32",
    scSpecTypeU64: "u64",
    scSpecTypeI64: "i64",
    scSpecTypeU128: "u128",
    scSpecTypeI128: "i128",
    scSpecTypeSymbol: "Symbol",
    scSpecTypeAddress: "Address",
    scSpecTypeMuxedAddress: "MuxedAddress",
    scSpecTypeString: "String",
    scSpecTypeBytes: "Bytes",
    scSpecTypeVoid: "void",
  };
  if (leaves[t.type]) return { kind: leaves[t.type] } as TypeNode;
  switch (t.type) {
    case "scSpecTypeBytesN":
      return { kind: "BytesN", size: t.bytesN.n };
    case "scSpecTypeOption":
      return {
        kind: "Option",
        item: parseType(t.option.valueType, entries, [...path, "Option"]),
      };
    case "scSpecTypeVec":
      return {
        kind: "Vec",
        item: parseType(t.vec.elementType, entries, [...path, "Vec"]),
      };
    case "scSpecTypeMap":
      return {
        kind: "Map",
        key: parseType(t.map.keyType, entries, [...path, "Map"]),
        value: parseType(t.map.valueType, entries, [...path, "Map"]),
      };
    case "scSpecTypeTuple":
      return {
        kind: "Tuple",
        items: t.tuple.valueTypes.map((x) =>
          parseType(x, entries, [...path, "Tuple"]),
        ),
      };
    case "scSpecTypeUdt": {
      const name = t.udt.name.toString();
      if (path.includes("udt:" + name)) fail("UNSUPPORTED_SOROBAN_TYPE");
      const e = entries.find(
        (e) =>
          (e.type === "scSpecEntryUdtStructV0" &&
            e.udtStructV0.name.toString() === name) ||
          (e.type === "scSpecEntryUdtEnumV0" &&
            e.udtEnumV0.name.toString() === name) ||
          (e.type === "scSpecEntryUdtUnionV0" &&
            e.udtUnionV0.name.toString() === name),
      );
      if (!e) fail("UNSUPPORTED_SOROBAN_TYPE");
      if (e.type === "scSpecEntryUdtEnumV0")
        return {
          kind: "Enum",
          cases: e.udtEnumV0.cases.map((c) => ({
            name: c.name.toString(),
            value: c.value,
          })),
        };
      if (e.type === "scSpecEntryUdtUnionV0")
        return {
          kind: "Union",
          cases: e.udtUnionV0.cases.map((c) =>
            c.type === "scSpecUdtUnionCaseVoidV0"
              ? { name: c.voidCase.name.toString(), items: [] }
              : {
                  name: c.tupleCase.name.toString(),
                  items: c.tupleCase.type.map((x) =>
                    parseType(x, entries, [...path, "udt:" + name]),
                  ),
                },
          ),
        };
      if (e.type !== "scSpecEntryUdtStructV0") fail("UNSUPPORTED_SOROBAN_TYPE");
      const fields = e.udtStructV0.fields;
      if (
        fields.length &&
        fields.every((f, n) => f.name.toString() === String(n))
      )
        return {
          kind: "Tuple",
          items: fields.map((f) =>
            parseType(f.type, entries, [...path, "udt:" + name]),
          ),
        };
      if (new Set(fields.map((f) => f.name.toString())).size !== fields.length)
        fail("SPEC_PARSE_FAILED");
      return {
        kind: "Struct",
        fields: fields.map((f) => ({
          name: f.name.toString(),
          description: f.doc.toString(),
          type: parseType(f.type, entries, [...path, "udt:" + name]),
        })),
      };
    }
    default:
      return fail("UNSUPPORTED_SOROBAN_TYPE");
  }
}
export function inspect(
  wasm: Uint8Array,
  c: Config,
  id?: string,
  protocolVersion?: number,
): ContractInterface {
  if (
    wasm.length > 10 * 1024 * 1024 ||
    !WebAssembly.validate(new Uint8Array(wasm))
  )
    fail("SPEC_PARSE_FAILED");
  let spec: contract.Spec;
  try {
    spec = contract.Spec.fromWasm(wasm);
  } catch {
    return fail("SPEC_PARSE_FAILED");
  }
  return inspectSpec(spec, c, id, {
    wasmHash: wasmHash(wasm),
    sourceKind: "wasm",
    protocolVersion,
    interfaceHash: wasmHash(
      Buffer.concat([
        Buffer.from(`orloj-encoding-v2:${protocolVersion ?? "unbound"}:`),
        Buffer.from(wasm),
      ]),
    ),
  });
}
export function inspectSpec(
  spec: contract.Spec,
  c: Config,
  id: string | undefined,
  identity: Partial<ContractInterface>,
): ContractInterface {
  if (!spec.entries.length) fail("SPEC_PARSE_FAILED");
  function withProtocol(node: TypeNode): TypeNode {
    if (node.kind === "MuxedAddress") node.protocol = identity.protocolVersion;
    if ("item" in node) withProtocol(node.item);
    if (node.kind === "Map") {
      withProtocol(node.key);
      withProtocol(node.value);
    }
    if (node.kind === "Tuple") node.items.forEach(withProtocol);
    if (node.kind === "Struct")
      node.fields.forEach((f) => withProtocol(f.type));
    if (node.kind === "Union")
      node.cases.forEach((c) => c.items.forEach(withProtocol));
    return node;
  }
  const names = new Set<string>(),
    tools = new Set<string>();
  const result: ContractInterface = {
    network: c.network,
    contractId: id ?? "",
    ...identity,
    inventory: [],
    functions: [],
    excluded: [],
    generatedAt: new Date().toISOString(),
  };
  for (const f of spec.funcs()) {
    const name = f.name.toString();
    if (names.has(name)) fail("DUPLICATE_FUNCTION_NAME");
    names.add(name);
    const tool = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!tool || tool.length > 128 || tools.has(tool))
      fail("TOOL_NAME_COLLISION");
    tools.add(tool);
    try {
      if (f.outputs.length > 1) fail("UNSUPPORTED_SOROBAN_TYPE");
      const params = f.inputs.map((p) => {
        const type = model(withProtocol(parseType(p.type, spec.entries)));
        return {
          name: p.name.toString(),
          sorobanType: type.sorobanType,
          jsonSchema: type.jsonSchema,
          required: type.node.kind !== "Option",
          description: p.doc.toString(),
          converterId: type.converterId,
          type,
        };
      });
      if (new Set(params.map((p) => p.name)).size !== params.length)
        fail("SPEC_PARSE_FAILED");
      const returns = model(
        f.outputs.length
          ? withProtocol(parseType(f.outputs[0], spec.entries))
          : { kind: "void" },
      );
      const policy = c.policies.find(
        (p) => p.contractId === id && p.function === name,
      );
      result.inventory!.push({
        name,
        eligible: true,
        policyStatus: policy ? "enabled" : "disabled",
        signature: {
          sorobanName: name,
          mcpToolName: tool,
          description: f.doc.toString(),
          params,
          returns,
        },
      });
      if (id && !policy) continue;
      if (
        policy?.mode === "WRITE" &&
        params.some((p) => p.name === "idempotency_key")
      ) {
        result.excluded.push({ name, error_code: "TOOL_NAME_COLLISION" });
        Object.assign(result.inventory!.at(-1)!, {
          eligible: false,
          policyStatus: "disabled",
          error_code: "TOOL_NAME_COLLISION",
        });
        continue;
      }
      result.functions.push({
        sorobanName: name,
        mcpToolName: tool,
        description: f.doc.toString(),
        mode: policy?.mode ?? "READ",
        params,
        returns,
        simulationSafe: false,
        writeAllowed: !!(
          policy?.mode === "WRITE" &&
          c.writeMode &&
          (c.signerSecret || c.externalSignerAddress)
        ),
      });
    } catch (e) {
      if (
        e instanceof RegistryError &&
        ["UNSUPPORTED_SOROBAN_TYPE", "TYPE_DEPTH_EXCEEDED"].includes(e.code)
      ) {
        result.excluded.push({ name, error_code: e.code });
        result.inventory!.push({
          name,
          eligible: false,
          policyStatus: "disabled",
          error_code: e.code,
        });
      } else throw e;
    }
  }
  return result;
}
export interface WasmRpc {
  getContractWasmByContractId(id: string): Promise<Uint8Array>;
  getContractInstance?: (
    id: string,
  ) => Promise<{ executable: { type: string } }>;
  getNetwork?: () => Promise<{
    passphrase: string;
    protocolVersion: string | number;
  }>;
}
export async function ingest(
  rpc: WasmRpc,
  c: Config,
  id: string,
  uploaded?: Uint8Array,
) {
  contractId(id);
  if (rpc.getContractInstance) {
    const instance = await mapped("SPEC_PARSE_FAILED", () =>
      rpc.getContractInstance!(id),
    );
    if (instance.executable.type === "contractExecutableStellarAsset") {
      if (uploaded) fail("INVALID_ARGUMENT");
      const net = await mapped("UNSUPPORTED_PROTOCOL", () => rpc.getNetwork!());
      if (net.passphrase !== c.networkPassphrase) fail("INVALID_ARGUMENT");
      const { assetInterface } = await import("./assets.js");
      return assetInterface(c, id, Number(net.protocolVersion));
    }
    if (
      !["contractExecutableWasm", "contractExecutableExternalRef"].includes(
        instance.executable.type,
      )
    )
      fail("SPEC_PARSE_FAILED");
  }
  const wasm = await mapped("SPEC_PARSE_FAILED", () =>
    rpc.getContractWasmByContractId(id),
  );
  if (uploaded && wasmHash(uploaded) !== wasmHash(wasm))
    fail("STALE_INTERFACE");
  const net = rpc.getNetwork
    ? await mapped("SPEC_PARSE_FAILED", () => rpc.getNetwork!())
    : undefined;
  if (net && net.passphrase !== c.networkPassphrase) fail("INVALID_ARGUMENT");
  return inspect(wasm, c, id, net ? Number(net.protocolVersion) : undefined);
}

export function inspectUpload(wasm: Uint8Array, c: Config) {
  const i = inspect(wasm, c);
  return {
    network: i.network,
    wasmHash: i.wasmHash,
    generatedAt: i.generatedAt,
    callable: false,
    excluded: i.excluded,
    functions: i.functions.map(
      ({ mode: _, writeAllowed: __, simulationSafe: ___, ...signature }) =>
        signature,
    ),
  };
}
