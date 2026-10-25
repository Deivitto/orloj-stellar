import { z } from "zod";
import { xdr, scvSortedMap } from "@stellar/stellar-sdk";
import { encode, decode, validator } from "./codec.js";
import { fail } from "./errors.js";
import type { Leaf, TypeNode } from "./model.js";
export const errorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sceContract"),
    code: z.number().int().min(0).max(4294967295),
  }),
  z.strictObject({
    kind: z.enum([
      "sceWasmVm",
      "sceContext",
      "sceStorage",
      "sceObject",
      "sceCrypto",
      "sceEvents",
      "sceBudget",
      "sceValue",
      "sceAuth",
    ]),
    code: z.number().int().min(0).max(9),
  }),
]);
const leaves: Record<string, Leaf> = {
  bool: "bool",
  u32: "u32",
  i32: "i32",
  u64: "u64",
  i64: "i64",
  u128: "u128",
  i128: "i128",
  u256: "u256",
  i256: "i256",
  string: "String",
  symbol: "Symbol",
  address: "MuxedAddress",
  bytes: "Bytes",
  void: "void",
  timepoint: "Timepoint",
  duration: "Duration",
  error: "Error",
};
const cache = new Map<number, z.ZodType>();
export function taggedSchema(protocol = 0): z.ZodType {
  const cached = cache.get(protocol);
  if (cached) return cached;
  const variants = Object.entries(leaves).map(([type, kind]) =>
    z.strictObject({
      type: z.literal(type),
      value: validator({ kind, protocol } as TypeNode),
    }),
  );
  let schema: z.ZodType = z.union(
    variants as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
  );
  // A finite graph with shared nodes generates compact $defs, not an unbounded recursive schema.
  for (let depth = 0; depth < 8; depth++) {
    const child = schema;
    schema = z.union([
      ...variants,
      z.strictObject({
        type: z.literal("vec"),
        value: z.array(child).max(100),
      }),
      z.strictObject({
        type: z.literal("map"),
        value: z.array(z.tuple([child, child])).max(100),
      }),
    ] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  cache.set(protocol, schema);
  return schema;
}
export function encodeError(value: unknown): xdr.ScVal {
  const r = errorSchema.safeParse(value);
  if (!r.success) fail("INVALID_ARGUMENT");
  if (r.data.kind === "sceContract")
    return xdr.ScVal.scvError(xdr.ScError.sceContract(r.data.code));
  const create = xdr.ScError[r.data.kind] as (
    code: xdr.ScErrorCode,
  ) => xdr.ScError;
  return xdr.ScVal.scvError(create(xdr.ScErrorCode.fromValue(r.data.code)));
}
export function decodeError(value: xdr.ScVal) {
  if (value.type !== "scvError") fail("RESULT_DECODE_FAILED");
  return {
    kind: value.error.type,
    code:
      value.error.type === "sceContract"
        ? value.error.contractCode
        : value.error.code.value,
  };
}
export function encodeTagged(value: unknown, protocol = 0): xdr.ScVal {
  if (!taggedSchema(protocol).safeParse(value).success)
    fail("INVALID_ARGUMENT");
  const v = value as { type: string; value: unknown };
  if (v.type === "vec")
    return xdr.ScVal.scvVec(
      (v.value as unknown[]).map((v) => encodeTagged(v, protocol)),
    );
  if (v.type === "map") {
    const pairs = (v.value as [unknown, unknown][]).map(
      ([k, v]) =>
        new xdr.ScMapEntry({
          key: encodeTagged(k, protocol),
          val: encodeTagged(v, protocol),
        }),
    );
    if (new Set(pairs.map((p) => p.key.toXdr("base64"))).size !== pairs.length)
      fail("INVALID_ARGUMENT");
    return scvSortedMap(pairs);
  }
  return encode({ kind: leaves[v.type], protocol } as TypeNode, v.value, true);
}
export function decodeTagged(v: xdr.ScVal, protocol = 0, depth = 0): unknown {
  if (depth > 8) fail("RESULT_DECODE_FAILED");
  if (v.type === "scvVec") {
    if (!v.vec || v.vec.length > 100) fail("RESULT_DECODE_FAILED");
    return {
      type: "vec",
      value: v.vec.map((v) => decodeTagged(v, protocol, depth + 1)),
    };
  }
  if (v.type === "scvMap") {
    if (
      !v.map ||
      v.map.length > 100 ||
      new Set(v.map.map((p) => p.key.toXdr("base64"))).size !== v.map.length ||
      scvSortedMap(v.map).toXdr("base64") !== v.toXdr("base64")
    )
      fail("RESULT_DECODE_FAILED");
    return {
      type: "map",
      value: v.map.map((p) => [
        decodeTagged(p.key, protocol, depth + 1),
        decodeTagged(p.val, protocol, depth + 1),
      ]),
    };
  }
  const tags: Record<string, string> = {
    scvBool: "bool",
    scvU32: "u32",
    scvI32: "i32",
    scvU64: "u64",
    scvI64: "i64",
    scvU128: "u128",
    scvI128: "i128",
    scvU256: "u256",
    scvI256: "i256",
    scvBytes: "bytes",
    scvString: "string",
    scvSymbol: "symbol",
    scvAddress: "address",
    scvVoid: "void",
    scvTimepoint: "timepoint",
    scvDuration: "duration",
    scvError: "error",
  };
  const type = tags[v.type];
  if (!type) fail("RESULT_DECODE_FAILED");
  return {
    type,
    value: decode({ kind: leaves[type], protocol } as TypeNode, v, true),
  };
}
