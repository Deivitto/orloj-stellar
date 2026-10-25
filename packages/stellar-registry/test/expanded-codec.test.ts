import { expect, it } from "vitest";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { budget, decode, encode, model } from "../src/codec.js";
import type { TypeNode } from "../src/model.js";
const u: TypeNode = { kind: "u64" };
const cases: [TypeNode, unknown][] = [
  [{ kind: "Vec", item: { kind: "Vec", item: u } }, [["1", "2"], []]],
  [{ kind: "Vec", item: { kind: "Option", item: u } }, [null, "3"]],
  [{ kind: "Option", item: { kind: "Vec", item: u } }, ["5"]],
  [
    { kind: "Map", key: { kind: "i64" }, value: { kind: "Vec", item: u } },
    [
      ["-2", ["1"]],
      ["1", []],
    ],
  ],
  [{ kind: "Tuple", items: [] }, []],
  [{ kind: "Tuple", items: [u, { kind: "bool" }] }, ["3", false]],
  [
    {
      kind: "Enum",
      cases: [
        { name: "A", value: 4 },
        { name: "B", value: 8 },
      ],
    },
    "B",
  ],
  [
    {
      kind: "Union",
      cases: [
        { name: "None", items: [] },
        { name: "Some", items: [u, { kind: "bool" }] },
      ],
    },
    { tag: "Some", values: ["8", true] },
  ],
  [
    { kind: "Union", cases: [{ name: "Only", items: [] }] },
    { tag: "Only", values: [] },
  ],
  [
    {
      kind: "Struct",
      fields: [
        {
          name: "inner",
          description: "",
          type: {
            kind: "Struct",
            fields: [{ name: "n", description: "", type: u }],
          },
        },
      ],
    },
    { inner: { n: "3" } },
  ],
];
for (const [t, v] of cases)
  it(`round-trips expanded ${JSON.stringify(t)}`, () => {
    expect(model(t).jsonSchema).toBeDefined();
    expect(decode(t, encode(t, v))).toEqual(v);
  });
it("sorts maps numerically and rejects duplicate keys on both boundaries", () => {
  const t: TypeNode = { kind: "Map", key: { kind: "i64" }, value: u };
  expect(
    decode(
      t,
      encode(t, [
        ["1", "1"],
        ["-2", "2"],
      ]),
    ),
  ).toEqual([
    ["-2", "2"],
    ["1", "1"],
  ]);
  expect(() =>
    encode(t, [
      ["1", "1"],
      ["1", "2"],
    ]),
  ).toThrow();
  const e = new xdr.ScMapEntry({
    key: encode(t.key, "1"),
    val: encode(t.value, "2"),
  });
  expect(() => decode(t, xdr.ScVal.scvMap([e, e]))).toThrow();
});
it("rejects malformed enum, union, tuple and extra union properties", () => {
  const en = cases[6][0],
    un = cases[7][0],
    tu = cases[5][0];
  expect(() => decode(en, xdr.ScVal.scvU32(9))).toThrow();
  expect(() =>
    decode(un, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other")])),
  ).toThrow();
  expect(() => encode(un, { tag: "None", values: [], extra: 1 })).toThrow();
  expect(() => encode(tu, ["2"])).toThrow();
  expect(() => decode(tu, xdr.ScVal.scvVec([]))).toThrow();
});
it("enforces depth, aggregate nodes, bytes and ambiguous option exclusions", () => {
  let t: TypeNode = u;
  for (let n = 0; n < 9; n++) t = { kind: "Vec", item: t };
  expect(() => model(t)).toThrow("depth");
  expect(() => model({ kind: "Option", item: { kind: "void" } })).toThrow();
  expect(() => budget(Array(100).fill(Array(10).fill(1)))).toThrow();
  expect(() => encode({ kind: "String" }, "x".repeat(1024 * 1024))).toThrow();
  expect(() =>
    decode({ kind: "String" }, xdr.ScVal.scvString("x".repeat(1024 * 1024))),
  ).toThrow();
});
it("keeps muxed account addresses separate from plain Address and protocol-gated", () => {
  const mux = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1));
  expect(() => encode({ kind: "Address" }, mux)).toThrow();
  expect(() => encode({ kind: "MuxedAddress", protocol: 22 }, mux)).toThrow();
  expect(
    decode(
      { kind: "MuxedAddress", protocol: 29 },
      encode({ kind: "MuxedAddress", protocol: 29 }, mux),
    ),
  ).toBe(mux);
  const w = Address.muxedContract(
    Buffer.concat([Buffer.alloc(32, 2), Buffer.alloc(8, 3)]),
  ).toString();
  expect(() => encode({ kind: "MuxedAddress", protocol: 29 }, w)).toThrow();
  expect(
    decode(
      { kind: "MuxedAddress", protocol: 30 },
      encode({ kind: "MuxedAddress", protocol: 30 }, w),
    ),
  ).toBe(w);
});
