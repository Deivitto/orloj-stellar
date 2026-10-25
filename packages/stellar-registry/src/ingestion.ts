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
  if (path.length > 2) fail("TYPE_DEPTH_EXCEEDED");
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
    case "scSpecTypeUdt": {
      const name = t.udt.name.toString();
      if (path.includes(name)) fail("UNSUPPORTED_SOROBAN_TYPE");
      const e = entries.find(
        (e) =>
          e.type === "scSpecEntryUdtStructV0" &&
          e.udtStructV0.name.toString() === name,
      );
      if (!e || e.type !== "scSpecEntryUdtStructV0")
        fail("UNSUPPORTED_SOROBAN_TYPE");
      const fields = e.udtStructV0.fields;
      if (fields.some((f) => /^\d+$/.test(f.name.toString())))
        fail("UNSUPPORTED_SOROBAN_TYPE");
      if (new Set(fields.map((f) => f.name.toString())).size !== fields.length)
        fail("SPEC_PARSE_FAILED");
      return {
        kind: "Struct",
        fields: fields.map((f) => ({
          name: f.name.toString(),
          description: f.doc.toString(),
          type: parseType(f.type, entries, [...path, name]),
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
  if (!spec.entries.length) fail("SPEC_PARSE_FAILED");
  const names = new Set<string>(),
    tools = new Set<string>();
  const result: ContractInterface = {
    network: c.network,
    contractId: id ?? "",
    wasmHash: wasmHash(wasm),
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
        const type = model(parseType(p.type, spec.entries));
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
          ? parseType(f.outputs[0], spec.entries)
          : { kind: "void" },
      );
      const policy = c.policies.find(
        (p) => p.contractId === id && p.function === name,
      );
      if (id && !policy) continue;
      if (
        policy?.mode === "WRITE" &&
        params.some((p) => p.name === "idempotency_key")
      ) {
        result.excluded.push({ name, error_code: "TOOL_NAME_COLLISION" });
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
      )
        result.excluded.push({ name, error_code: e.code });
      else throw e;
    }
  }
  return result;
}
export interface WasmRpc {
  getContractWasmByContractId(id: string): Promise<Uint8Array>;
}
export async function ingest(
  rpc: WasmRpc,
  c: Config,
  id: string,
  uploaded?: Uint8Array,
) {
  contractId(id);
  const wasm = await mapped("SPEC_PARSE_FAILED", () =>
    rpc.getContractWasmByContractId(id),
  );
  if (uploaded && wasmHash(uploaded) !== wasmHash(wasm))
    fail("STALE_INTERFACE");
  return inspect(wasm, c, id);
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
