import { it, expect } from "vitest";
import { Keypair, scvSortedMap, xdr } from "@stellar/stellar-sdk";
import { encode, decode, model } from "../src/codec.js";
import { inputSchema } from "../src/gateway.js";
import type { TypeNode } from "../src/model.js";
const val: TypeNode = { kind: "Val", protocol: 29 };
const values: unknown[] = [
  { type: "bool", value: false },
  { type: "i128", value: "-170141183460469231731687303715884105728" },
  { type: "u256", value: ((1n << 256n) - 1n).toString() },
  { type: "address", value: Keypair.random().publicKey() },
  { type: "symbol", value: "hello" },
  { type: "string", value: "Stellar ✓" },
  { type: "bytes", value: "00ff" },
  { type: "void", value: null },
  { type: "timepoint", value: "18446744073709551615" },
  { type: "duration", value: "1" },
  { type: "error", value: { kind: "sceContract", code: 999 } },
  { type: "error", value: { kind: "sceBudget", code: 5 } },
  { type: "vec", value: [{ type: "u64", value: "1" }] },
  {
    type: "map",
    value: [
      [
        { type: "symbol", value: "x" },
        { type: "vec", value: [{ type: "i32", value: -1 }] },
      ],
    ],
  },
];
for (const v of values)
  it("round trips explicitly tagged " + JSON.stringify(v), () => {
    expect(decode(val, encode(val, v))).toEqual(v);
  });
it("bounds opaque nesting, collection sizes, integer ranges and internal-only tags before conversion", () => {
  let v: unknown = { type: "void", value: null };
  for (let n = 0; n < 8; n++) v = { type: "vec", value: [v] };
  expect(decode(val, encode(val, v))).toEqual(v);
  for (const bad of [
    { type: "vec", value: [v] },
    { type: "vec", value: Array(101).fill({ type: "void", value: null }) },
    { type: "u64", value: 1 },
    { type: "u32", value: -1 },
    { type: "error", value: { kind: "sceBudget", code: 100 } },
    { type: "contract_instance", value: {} },
    { type: "i128", value: "1", extra: true },
  ])
    expect(() => encode(val, bad)).toThrow();
  expect(() => model({ kind: "Option", item: val })).toThrow("unsupported");
});
it("rejects duplicate opaque map keys and malformed results", () => {
  const pair = [
    { type: "symbol", value: "k" },
    { type: "bool", value: true },
  ];
  expect(() => encode(val, { type: "map", value: [pair, pair] })).toThrow();
  const p = new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("k"),
    val: xdr.ScVal.scvBool(true),
  });
  expect(() => decode(val, xdr.ScVal.scvMap([p, p]))).toThrow();
  expect(() => decode(val, xdr.ScVal.scvLedgerKeyContractInstance())).toThrow();
});
it("emits compact bounded JSON schemas with valid reusable definitions", () => {
  const m = model(val),
    f = {
      sorobanName: "echo",
      mcpToolName: "echo",
      description: "",
      mode: "READ" as const,
      params: [
        {
          name: "v",
          sorobanType: "Val",
          jsonSchema: m.jsonSchema,
          required: true,
          description: "",
          converterId: m.converterId,
          type: m,
        },
      ],
      returns: m,
      writeAllowed: false,
      simulationSafe: false,
    };
  const schema = inputSchema(f);
  expect(JSON.stringify(schema).length).toBeLessThan(150000);
  expect(schema.additionalProperties).toBe(false);
});
for (const kind of ["Timepoint", "Duration"] as const)
  it("round trips declared " + kind, () => {
    expect(decode({ kind }, encode({ kind }, "18446744073709551615"))).toBe(
      "18446744073709551615",
    );
    expect(() => encode({ kind }, "18446744073709551616")).toThrow();
  });

it("preserves declared contract error enum codes without inventing unknown cases", () => {
  const node: TypeNode = {
    kind: "ErrorEnum",
    cases: [
      { name: "Denied", value: 7 },
      { name: "Missing", value: 99 },
    ],
  };
  const wire = encode(node, "Denied");
  if (wire.type !== "scvError") throw Error("expected ScVal Error");
  expect(wire.error.type).toBe("sceContract");
  if (wire.error.type === "sceContract")
    expect(wire.error.contractCode).toBe(7);
  expect(decode(node, encode(node, "Missing"))).toBe("Missing");
  expect(() => encode(node, "Other")).toThrow();
  expect(() =>
    decode(node, xdr.ScVal.scvError(xdr.ScError.sceContract(8))),
  ).toThrow();
});
