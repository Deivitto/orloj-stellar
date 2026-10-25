import { describe, it, expect, vi } from "vitest";
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return { ...actual, nativeToScVal: vi.fn(actual.nativeToScVal) };
});
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { encode, decode, model, validator } from "../src/codec.js";
import type { TypeNode } from "../src/model.js";
const cases: [TypeNode, unknown][] = [
  [{ kind: "bool" }, true],
  [{ kind: "bool" }, false],
  [{ kind: "u32" }, 4294967295],
  [{ kind: "i32" }, -2147483648],
  [{ kind: "u64" }, "0"],
  [{ kind: "u64" }, "18446744073709551615"],
  [{ kind: "i64" }, "-9223372036854775808"],
  [{ kind: "i64" }, "9223372036854775807"],
  [{ kind: "u128" }, "340282366920938463463374607431768211455"],
  [{ kind: "i128" }, "-170141183460469231731687303715884105728"],
  [{ kind: "String" }, "hello 🌍"],
  [{ kind: "Symbol" }, "hello_2"],
  [{ kind: "Address" }, Keypair.random().publicKey()],
  [{ kind: "Address" }, StrKey.encodeContract(Buffer.alloc(32, 1))],
  [{ kind: "Bytes" }, "00abcd"],
  [{ kind: "BytesN", size: 32 }, "ab".repeat(32)],
  [{ kind: "void" }, null],
  [{ kind: "Option", item: { kind: "u64" } }, null],
  [{ kind: "Option", item: { kind: "u64" } }, "42"],
  [{ kind: "Vec", item: { kind: "u64" } }, Array(100).fill("1")],
  [
    {
      kind: "Struct",
      fields: [
        { name: "count", description: "", type: { kind: "u64" } },
        {
          name: "maybe",
          description: "",
          type: { kind: "Option", item: { kind: "bool" } },
        },
      ],
    },
    { count: "10", maybe: null },
  ],
];
describe("strict codec", () => {
  for (const [type, value] of cases)
    it(`round trip ${type.kind} ${String(value).slice(0, 40)}`, () =>
      expect(decode(type, encode(type, value))).toEqual(value));
  for (const v of [
    1,
    1n,
    "01",
    "+1",
    "-0",
    "1e2",
    " 1",
    "18446744073709551616",
    "-1",
  ])
    it(`reject u64 ${String(v)}`, () =>
      expect(() => encode({ kind: "u64" }, v)).toThrow("Arguments"));
  it("rejects oversized vectors before conversion", () =>
    expect(() =>
      encode({ kind: "Vec", item: { kind: "u64" } }, Array(101).fill("1")),
    ).toThrow());
  it("rejects invalid addresses and uppercase hex", () => {
    expect(
      validator({ kind: "Address" }).safeParse("G" + "A".repeat(55)).success,
    ).toBe(false);
    expect(() => encode({ kind: "Bytes" }, "AB")).toThrow();
  });
  it("rejects malformed UTF8 and wrong result types", () => {
    expect(() =>
      decode({ kind: "String" }, xdr.ScVal.scvString(new Uint8Array([255]))),
    ).toThrow("UTF-8");
    expect(() => decode({ kind: "bool" }, xdr.ScVal.scvU32(1))).toThrow(
      "declared type",
    );
  });
  for (const node of [
    { kind: "Vec", item: { kind: "Option", item: { kind: "u32" } } },
    { kind: "Option", item: { kind: "Option", item: { kind: "u32" } } },
    { kind: "Vec", item: { kind: "Vec", item: { kind: "u32" } } },
    { kind: "BytesN", size: 257 },
  ] as TypeNode[])
    it(`excludes unsupported ${JSON.stringify(node)}`, () =>
      expect(() => model(node)).toThrow());
  it("requires struct fields and rejects extras", () => {
    const t = cases.at(-1)![0];
    expect(() => encode(t, { count: "1" })).toThrow();
    expect(() => encode(t, { count: "1", maybe: null, extra: true })).toThrow();
  });
});
it("preserves a leading UTF8 BOM as string data", () => {
  const t: TypeNode = { kind: "String" };
  expect(decode(t, encode(t, "\uFEFFtext"))).toBe("\uFEFFtext");
});
it("generated schema constrains full integer ranges without floating point", () => {
  for (const [kind, bits, signed] of [
    ["u64", 64, false],
    ["i64", 64, true],
    ["u128", 128, false],
    ["i128", 128, true],
  ] as const) {
    const t: TypeNode = { kind };
    const schema = model(t).jsonSchema;
    const regex = new RegExp(schema.pattern as string);
    const max = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
    expect(regex.test(max.toString())).toBe(true);
    expect(regex.test((max + 1n).toString())).toBe(false);
    expect(regex.test("-0")).toBe(false);
    if (signed) {
      const min = -(1n << BigInt(bits - 1));
      expect(regex.test(min.toString())).toBe(true);
      expect(regex.test((min - 1n).toString())).toBe(false);
    }
  }
});
it("maps SDK conversion failures without leaking internals", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  vi.mocked(sdk.nativeToScVal).mockImplementationOnce(() => {
    throw new Error("SECRET SDK stack");
  });
  expect(() => encode({ kind: "u32" }, 1)).toThrow("could not be converted");
});
