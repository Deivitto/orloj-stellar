import {
  Address,
  StrKey,
  xdr,
  scValToBigInt,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { fail, RegistryError } from "./errors.js";
import type { TypeNode, TypeModel } from "./model.js";
const large = ["u64", "i64", "u128", "i128"];
function decimalUpTo(max: bigint): string {
  const digits = max.toString();
  const options = ["0"];
  if (digits.length > 1)
    options.push("[1-9][0-9]{0," + (digits.length - 2) + "}");
  let prefix = "";
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[i]),
      low = i === 0 ? 1 : 0,
      remaining = digits.length - i - 1;
    if (digit > low) {
      const range =
        digit - low === 1 ? String(low) : "[" + low + "-" + (digit - 1) + "]";
      options.push(
        prefix + range + (remaining ? "[0-9]{" + remaining + "}" : ""),
      );
    }
    prefix += digit;
  }
  options.push(prefix);
  return "(?:" + options.join("|") + ")";
}
export function validator(t: TypeNode): z.ZodType {
  switch (t.kind) {
    case "bool":
      return z.boolean();
    case "void":
      return z.null();
    case "u32":
      return z.number().int().min(0).max(4294967295);
    case "i32":
      return z.number().int().min(-2147483648).max(2147483647);
    case "u64":
    case "i64":
    case "u128":
    case "i128": {
      const signed = t.kind[0] === "i";
      const bits = BigInt(t.kind.slice(1));
      const min = signed ? -(1n << (bits - 1n)) : 0n;
      const max = (1n << (signed ? bits - 1n : bits)) - 1n;
      return z
        .string()
        .max(40)
        .regex(
          new RegExp(
            "^(?:" +
              decimalUpTo(max) +
              (signed ? "|-(?!0$)" + decimalUpTo(-min) : "") +
              ")$",
          ),
        );
    }
    case "Symbol":
      return z.string().regex(/^[a-zA-Z0-9_]{0,32}$/);
    case "String":
      return z
        .string()
        .refine((s) => Buffer.from(s, "utf8").toString("utf8") === s);
    case "Address":
      return z
        .string()
        .refine(
          (s) => StrKey.isValidEd25519PublicKey(s) || StrKey.isValidContract(s),
        );
    case "Bytes":
      return z
        .string()
        .regex(/^(?:[0-9a-f]{2})*$/)
        .max(2 * 1024 * 1024);
    case "BytesN":
      return z.string().regex(new RegExp(`^[0-9a-f]{${2 * t.size!}}$`));
    case "Option":
      return z.union([validator(t.item), z.null()]);
    case "Vec":
      return z.array(validator(t.item)).max(100);
    case "Struct":
      return z.strictObject(
        Object.fromEntries(t.fields.map((f) => [f.name, validator(f.type)])),
      );
  }
}
export function supported(t: TypeNode, depth = 0): void {
  if (depth > 2) fail("TYPE_DEPTH_EXCEEDED");
  if (
    t.kind === "BytesN" &&
    (!Number.isInteger(t.size) || t.size! < 0 || t.size! > 256)
  )
    fail("UNSUPPORTED_SOROBAN_TYPE");
  if (t.kind === "Option" || t.kind === "Vec") {
    if (["Option", "Vec", "Struct"].includes(t.item.kind))
      fail("UNSUPPORTED_SOROBAN_TYPE");
    supported(t.item, depth + 1);
  }
  if (t.kind === "Struct") {
    if (depth > 0) fail("UNSUPPORTED_SOROBAN_TYPE");
    for (const f of t.fields) {
      if (f.type.kind === "Struct" || f.type.kind === "Vec")
        fail("UNSUPPORTED_SOROBAN_TYPE");
      supported(f.type, depth + 1);
    }
  }
}
export function model(node: TypeNode): TypeModel {
  supported(node);
  return {
    node,
    sorobanType: node.kind,
    converterId: JSON.stringify(node),
    isCollection: node.kind === "Vec",
    jsonSchema: z.toJSONSchema(validator(node)) as Record<string, unknown>,
    ...("item" in node ? { itemType: model(node.item) } : {}),
    ...(node.kind === "Struct"
      ? {
          structFields: node.fields.map((f) => ({
            name: f.name,
            type: model(f.type),
            description: f.description,
          })),
        }
      : {}),
  };
}
export function encode(t: TypeNode, value: unknown): xdr.ScVal {
  if (!validator(t).safeParse(value).success) fail("INVALID_ARGUMENT");
  try {
    if (t.kind === "Option")
      return value === null ? xdr.ScVal.scvVoid() : encode(t.item, value);
    if (t.kind === "Vec")
      return xdr.ScVal.scvVec(
        (value as unknown[]).map((v) => encode(t.item, v)),
      );
    if (t.kind === "Struct")
      return xdr.ScVal.scvMap(
        [...t.fields]
          .sort((a, b) =>
            Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
          )
          .map(
            (f) =>
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol(f.name),
                val: encode(f.type, (value as Record<string, unknown>)[f.name]),
              }),
          ),
      );
    if (t.kind === "Address")
      return Address.fromString(value as string).toScVal();
    if (t.kind === "Bytes" || t.kind === "BytesN")
      return xdr.ScVal.scvBytes(Buffer.from(value as string, "hex"));
    if (t.kind === "void") return xdr.ScVal.scvVoid();
    return nativeToScVal(
      large.includes(t.kind) ? BigInt(value as string) : value,
      {
        type: ((
          { Symbol: "symbol", String: "string" } as Record<string, string>
        )[t.kind] ?? t.kind) as NonNullable<
          Parameters<typeof nativeToScVal>[1]
        >["type"],
      },
    );
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    return fail("ARGUMENT_CONVERSION_FAILED");
  }
}
function utf8(
  bytes: Uint8Array,
  code: "STRING_NOT_UTF8" | "RESULT_DECODE_FAILED",
) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail(code);
  }
}
export function decode(t: TypeNode, v: xdr.ScVal): unknown {
  try {
    let out: unknown;
    if (t.kind === "Option")
      out = v.type === "scvVoid" ? null : decode(t.item, v);
    else if (t.kind === "Vec") {
      if (v.type !== "scvVec" || !v.vec || v.vec.length > 100)
        fail("RESULT_DECODE_FAILED");
      out = v.vec.map((x) => decode(t.item, x));
    } else if (t.kind === "Struct") {
      if (v.type !== "scvMap" || !v.map || v.map.length !== t.fields.length)
        fail("RESULT_DECODE_FAILED");
      const obj: Record<string, unknown> = Object.create(null);
      for (const e of v.map) {
        if (e.key.type !== "scvSymbol") fail("RESULT_DECODE_FAILED");
        const k = e.key.sym.toString();
        const f = t.fields.find((f) => f.name === k);
        if (!f || Object.hasOwn(obj, k)) fail("RESULT_DECODE_FAILED");
        obj[k] = decode(f.type, e.val);
      }
      out = obj;
    } else {
      const tags: Record<string, string> = {
        bool: "scvBool",
        u32: "scvU32",
        i32: "scvI32",
        u64: "scvU64",
        i64: "scvI64",
        u128: "scvU128",
        i128: "scvI128",
        Address: "scvAddress",
        Bytes: "scvBytes",
        BytesN: "scvBytes",
        String: "scvString",
        Symbol: "scvSymbol",
        void: "scvVoid",
      };
      if (v.type !== tags[t.kind]) fail("RESULT_DECODE_FAILED");
      switch (v.type) {
        case "scvVoid":
          out = null;
          break;
        case "scvBool":
          out = v.b;
          break;
        case "scvU32":
          out = v.u32;
          break;
        case "scvI32":
          out = v.i32;
          break;
        case "scvU64":
        case "scvI64":
        case "scvU128":
        case "scvI128":
          out = scValToBigInt(v).toString();
          break;
        case "scvAddress":
          out = Address.fromScVal(v).toString();
          break;
        case "scvBytes":
          out = Buffer.from(v.bytes.value).toString("hex");
          break;
        case "scvString":
          out = utf8(v.str.bytes, "STRING_NOT_UTF8");
          break;
        case "scvSymbol":
          out = utf8(v.sym.bytes, "RESULT_DECODE_FAILED");
          break;
        default:
          fail("RESULT_DECODE_FAILED");
      }
    }
    if (!validator(t).safeParse(out).success) fail("RESULT_DECODE_FAILED");
    return out;
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    return fail("RESULT_DECODE_FAILED");
  }
}
