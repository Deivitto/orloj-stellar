import {
  taggedSchema,
  encodeTagged,
  decodeTagged,
  errorSchema,
  encodeError,
  decodeError,
} from "./tagged-value.js";
import {
  Address,
  StrKey,
  xdr,
  scValToBigInt,
  nativeToScVal,
  scvSortedMap,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { fail, RegistryError } from "./errors.js";
import type { TypeNode, TypeModel } from "./model.js";
const large = ["u64", "i64", "u128", "i128", "u256", "i256"];
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
    case "Val":
      return taggedSchema(t.protocol);
    case "Error":
      return errorSchema;
    case "Timepoint":
    case "Duration":
      return validator({ kind: "u64" });
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
    case "i128":
    case "u256":
    case "i256": {
      const signed = t.kind[0] === "i";
      const bits = BigInt(t.kind.slice(1));
      const min = signed ? -(1n << (bits - 1n)) : 0n;
      const max = (1n << (signed ? bits - 1n : bits)) - 1n;
      return z
        .string()
        .max(79)
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
    case "MuxedAddress":
      return z
        .string()
        .refine(
          (s) =>
            StrKey.isValidEd25519PublicKey(s) ||
            StrKey.isValidContract(s) ||
            ((t.protocol ?? 0) >= 23 && StrKey.isValidMed25519PublicKey(s)) ||
            ((t.protocol ?? 0) >= 30 && StrKey.isValidMuxedContract(s)),
        );
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
    case "Result":
      return z.strictObject({
        tag: z.literal("Ok"),
        values: z.tuple([validator(t.ok)]),
      });
    case "Option":
      return z.union([validator(t.item), z.null()]);
    case "Vec":
      return z.array(validator(t.item)).max(100);
    case "Map":
      return z.array(z.tuple([validator(t.key), validator(t.value)])).max(100);
    case "Tuple":
      return z.tuple(t.items.map(validator) as [z.ZodType, ...z.ZodType[]]);
    case "ErrorEnum":
    case "Enum":
      return z.enum(t.cases.map((c) => c.name) as [string, ...string[]]);
    case "Union":
      return z.union(
        t.cases.map((c) =>
          z.strictObject({
            tag: z.literal(c.name),
            values: z.tuple(
              c.items.map(validator) as [z.ZodType, ...z.ZodType[]],
            ),
          }),
        ) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
      );
    case "Struct":
      return z.strictObject(
        Object.fromEntries(t.fields.map((f) => [f.name, validator(f.type)])),
      );
  }
}
export function supported(t: TypeNode, depth = 0, resultAllowed = true): void {
  if (
    t.kind === "Result" &&
    (new Set(t.errors.map((e) => e.value)).size !== t.errors.length ||
      new Set(t.errors.map((e) => e.name)).size !== t.errors.length ||
      t.errors.some(
        (e) =>
          !Number.isInteger(e.value) || e.value < 0 || e.value > 4294967295,
      ))
  )
    fail("SPEC_PARSE_FAILED");
  if (t.kind === "Result" && !resultAllowed) fail("UNSUPPORTED_SOROBAN_TYPE");
  if (depth > 8) fail("TYPE_DEPTH_EXCEEDED");
  if (
    t.kind === "BytesN" &&
    (!Number.isInteger(t.size) || t.size! < 0 || t.size! > 256)
  )
    fail("UNSUPPORTED_SOROBAN_TYPE");
  if (
    t.kind === "Option" &&
    (["Option", "void", "Val"].includes(t.item.kind) ||
      (t.item.kind === "Tuple" && t.item.items.length === 0))
  )
    fail("UNSUPPORTED_SOROBAN_TYPE");
  const children =
    t.kind === "Result"
      ? [t.ok]
      : "item" in t
        ? [t.item]
        : t.kind === "Map"
          ? [t.key, t.value]
          : t.kind === "Tuple"
            ? t.items
            : t.kind === "Struct"
              ? t.fields.map((f) => f.type)
              : t.kind === "Union"
                ? t.cases.flatMap((c) => c.items)
                : [];
  if (t.kind === "Enum" || t.kind === "ErrorEnum" || t.kind === "Union") {
    if (
      !t.cases.length ||
      new Set(t.cases.map((c) => c.name)).size !== t.cases.length
    )
      fail("SPEC_PARSE_FAILED");
    if (
      t.kind === "Union" &&
      t.cases.some((c) => !/^([a-zA-Z0-9_]){1,32}$/.test(c.name))
    )
      fail("SPEC_PARSE_FAILED");
    if (
      (t.kind === "Enum" || t.kind === "ErrorEnum") &&
      new Set(t.cases.map((c) => c.value)).size !== t.cases.length
    )
      fail("SPEC_PARSE_FAILED");
  }
  if (children.length > 100) fail("UNSUPPORTED_SOROBAN_TYPE");
  for (const child of children)
    supported(child, depth + (t.kind === "Result" ? 0 : 1), false);
}
export function budget(
  value: unknown,
  code: "INVALID_ARGUMENT" | "RESULT_DECODE_FAILED" = "INVALID_ARGUMENT",
) {
  let count = 0;
  function visit(v: unknown, depth: number) {
    if (++count > 1000 || depth > 48) fail(code);
    if (v && typeof v === "object")
      for (const x of Object.values(v)) visit(x, depth + 1);
  }
  visit(value, 0);
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024)
      fail(code);
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    fail(code);
  }
}
function checkResultBudget(v: xdr.ScVal, depth = 0, state = { count: 0 }) {
  if (++state.count > 1000 || depth > 24) fail("RESULT_DECODE_FAILED");
  if (v.type === "scvVec")
    for (const x of v.vec ?? []) checkResultBudget(x, depth + 1, state);
  if (v.type === "scvMap")
    for (const e of v.map ?? []) {
      checkResultBudget(e.key, depth + 1, state);
      checkResultBudget(e.val, depth + 1, state);
    }
}
export function model(node: TypeNode): TypeModel {
  supported(node);
  return {
    node,
    sorobanType: node.kind,
    converterId: JSON.stringify(node),
    isCollection: ["Vec", "Map", "Tuple"].includes(node.kind),
    jsonSchema: z.toJSONSchema(validator(node), { reused: "ref" }) as Record<
      string,
      unknown
    >,
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
export function encode(t: TypeNode, value: unknown, nested = false): xdr.ScVal {
  if (!nested) {
    supported(t);
    budget(value);
  }
  if (!validator(t).safeParse(value).success) fail("INVALID_ARGUMENT");
  try {
    if (t.kind === "Val") return encodeTagged(value, t.protocol);
    if (t.kind === "Error") return encodeError(value);
    if (t.kind === "Timepoint")
      return xdr.ScVal.scvTimepoint(BigInt(value as string));
    if (t.kind === "Duration")
      return xdr.ScVal.scvDuration(BigInt(value as string));
    if (t.kind === "Result") fail("UNSUPPORTED_SOROBAN_TYPE");
    if (t.kind === "Option")
      return value === null ? xdr.ScVal.scvVoid() : encode(t.item, value, true);
    if (t.kind === "Vec")
      return xdr.ScVal.scvVec(
        (value as unknown[]).map((v) => encode(t.item, v, true)),
      );
    if (t.kind === "Tuple" && t.items.length === 0) return xdr.ScVal.scvVoid();
    if (t.kind === "Tuple")
      return xdr.ScVal.scvVec(
        t.items.map((type, n) => encode(type, (value as unknown[])[n], true)),
      );
    if (t.kind === "ErrorEnum")
      return xdr.ScVal.scvError(
        xdr.ScError.sceContract(t.cases.find((c) => c.name === value)!.value),
      );
    if (t.kind === "Enum")
      return xdr.ScVal.scvU32(t.cases.find((c) => c.name === value)!.value);
    if (t.kind === "Union") {
      const u = value as { tag: string; values: unknown[] };
      const c = t.cases.find((c) => c.name === u.tag)!;
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol(c.name),
        ...c.items.map((type, n) => encode(type, u.values[n], true)),
      ]);
    }
    if (t.kind === "Map") {
      const entries = (value as unknown[][]).map(
        ([k, v]) =>
          new xdr.ScMapEntry({
            key: encode(t.key, k, true),
            val: encode(t.value, v, true),
          }),
      );
      if (
        new Set(entries.map((e) => e.key.toXdr("base64"))).size !==
        entries.length
      )
        fail("INVALID_ARGUMENT");
      return scvSortedMap(entries);
    }
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
                val: encode(
                  f.type,
                  (value as Record<string, unknown>)[f.name],
                  true,
                ),
              }),
          ),
      );
    if (t.kind === "Address" || t.kind === "MuxedAddress")
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
export function decode(t: TypeNode, v: xdr.ScVal, nested = false): unknown {
  if (!nested) {
    checkResultBudget(v);
    if (v.toXdr().length > 1024 * 1024) fail("RESULT_DECODE_FAILED");
  }
  try {
    let out: unknown;
    if (t.kind === "Val") out = decodeTagged(v, t.protocol);
    else if (t.kind === "Error") out = decodeError(v);
    else if (t.kind === "Timepoint" || t.kind === "Duration") {
      if (t.kind === "Timepoint" && v.type === "scvTimepoint")
        out = v.timepoint.toString();
      else if (t.kind === "Duration" && v.type === "scvDuration")
        out = v.duration.toString();
      else fail("RESULT_DECODE_FAILED");
    } else if (t.kind === "Result") {
      if (v.type === "scvError") {
        if (v.error.type !== "sceContract") fail("RESULT_DECODE_FAILED");
        const code = v.error.contractCode,
          declared = t.errors.find((e) => e.value === code);
        if (!t.genericError && !declared) fail("RESULT_DECODE_FAILED");
        throw new RegistryError("CONTRACT_EXECUTION_FAILED", {
          code,
          ...(declared ? { name: declared.name } : {}),
        });
      }
      out = {
        tag: "Ok",
        values: [
          t.ok.kind === "Tuple" && !t.ok.items.length && v.type === "scvVoid"
            ? []
            : decode(t.ok, v, true),
        ],
      };
    } else if (t.kind === "Option")
      out = v.type === "scvVoid" ? null : decode(t.item, v, true);
    else if (t.kind === "Vec") {
      if (v.type !== "scvVec" || !v.vec || v.vec.length > 100)
        fail("RESULT_DECODE_FAILED");
      out = v.vec.map((x) => decode(t.item, x, true));
    } else if (t.kind === "Tuple" && t.items.length === 0) {
      if (v.type !== "scvVoid") fail("RESULT_DECODE_FAILED");
      out = [];
    } else if (t.kind === "Tuple" || t.kind === "Union") {
      if (v.type !== "scvVec" || !v.vec) fail("RESULT_DECODE_FAILED");
      if (t.kind === "Tuple") {
        if (v.vec.length !== t.items.length) fail("RESULT_DECODE_FAILED");
        out = t.items.map((type, n) => decode(type, v.vec![n], true));
      } else {
        const tag = v.vec[0];
        if (tag?.type !== "scvSymbol") fail("RESULT_DECODE_FAILED");
        const c = t.cases.find(
          (c) => c.name === utf8(tag.sym.bytes, "RESULT_DECODE_FAILED"),
        );
        if (!c || v.vec.length !== c.items.length + 1)
          fail("RESULT_DECODE_FAILED");
        out = {
          tag: c.name,
          values: c.items.map((type, n) => decode(type, v.vec![n + 1], true)),
        };
      }
    } else if (t.kind === "ErrorEnum") {
      if (v.type !== "scvError" || v.error.type !== "sceContract")
        fail("RESULT_DECODE_FAILED");
      const code = v.error.contractCode,
        c = t.cases.find((c) => c.value === code);
      if (!c) fail("RESULT_DECODE_FAILED");
      out = c.name;
    } else if (t.kind === "Enum") {
      if (v.type !== "scvU32") fail("RESULT_DECODE_FAILED");
      const c = t.cases.find((c) => c.value === v.u32);
      if (!c) fail("RESULT_DECODE_FAILED");
      out = c.name;
    } else if (t.kind === "Map") {
      if (v.type !== "scvMap" || !v.map || v.map.length > 100)
        fail("RESULT_DECODE_FAILED");
      const sorted = scvSortedMap(v.map);
      if (
        sorted.toXdr("base64") !== v.toXdr("base64") ||
        new Set(v.map.map((e) => e.key.toXdr("base64"))).size !== v.map.length
      )
        fail("RESULT_DECODE_FAILED");
      out = v.map.map((e) => [
        decode(t.key, e.key, true),
        decode(t.value, e.val, true),
      ]);
    } else if (t.kind === "Struct") {
      if (v.type !== "scvMap" || !v.map || v.map.length !== t.fields.length)
        fail("RESULT_DECODE_FAILED");
      const obj: Record<string, unknown> = Object.create(null);
      for (const e of v.map) {
        if (e.key.type !== "scvSymbol") fail("RESULT_DECODE_FAILED");
        const k = e.key.sym.toString();
        const f = t.fields.find((f) => f.name === k);
        if (!f || Object.hasOwn(obj, k)) fail("RESULT_DECODE_FAILED");
        obj[k] = decode(f.type, e.val, true);
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
        u256: "scvU256",
        i256: "scvI256",
        Address: "scvAddress",
        MuxedAddress: "scvAddress",
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
        case "scvU256":
        case "scvI256":
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
    if (!nested) budget(out, "RESULT_DECODE_FAILED");
    return out;
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    return fail("RESULT_DECODE_FAILED");
  }
}
