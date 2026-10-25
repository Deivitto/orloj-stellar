import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { inspect, parseType } from "../src/ingestion.js";
import { parseConfig } from "../src/config.js";
const c = parseConfig({
  rpcUrl: "https://soroban-testnet.stellar.org",
  databaseUrl: "postgres://localhost/test",
  simulationSource: Keypair.random().publicKey(),
});
it("extracts the real demo WASM spec including its newly supported nested vector", async () => {
  const wasm = await readFile(
    new URL(
      "../demo-contract/artifacts/orloj_stellar_demo.wasm",
      import.meta.url,
    ),
  );
  const i = inspect(wasm, c);
  expect(i.functions.length).toBe(20);
  expect(
    i.functions.find((f) => f.sorobanName === "echo_record")?.params[0].type
      .structFields,
  ).toHaveLength(3);
  expect(i.functions.some((f) => f.sorobanName === "unsupported")).toBe(true);
  expect(i.contractId).toBe("");
});
it("rejects malformed WASM and unknown referenced types", () => {
  expect(() => inspect(new Uint8Array([1, 2, 3]), c)).toThrow("specification");
  const types = [xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({name:"Missing"}))];
  for (const t of types) expect(() => parseType(t, [])).toThrow("unsupported");
});
it("rejects duplicate exported functions and sanitized name collisions", async () => {
  const { vi } = await import("vitest");
  const { contract } = await import("@stellar/stellar-sdk");
  const make = (name: string) =>
    xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({
        name,
        doc: "",
        inputs: [],
        outputs: [xdr.ScSpecTypeDef.scSpecTypeU32()],
      }),
    );
  const spy = vi.spyOn(contract.Spec, "fromWasm");
  try {
    spy.mockReturnValue(new contract.Spec([make("a"), make("a")]));
    expect(() =>
      inspect(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), c),
    ).toThrow("duplicate functions");
    spy.mockReturnValue(new contract.Spec([make("a.b"), make("a_b")]));
    expect(() =>
      inspect(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), c),
    ).toThrow("names collide");
  } finally {
    spy.mockRestore();
  }
});
it("reports excessive depth distinctly and does not assign modes to unbound uploads", async () => {
  const { inspectUpload } = await import("../src/ingestion.js");
  let t = xdr.ScSpecTypeDef.scSpecTypeU32() as xdr.ScSpecTypeDef;
  for (let n = 0; n < 10; n++)
    t = xdr.ScSpecTypeDef.scSpecTypeOption(
      new xdr.ScSpecTypeOption({ valueType: t }),
    );
  expect(() => parseType(t, [])).toThrow("depth");
  const wasm = await readFile(
    new URL(
      "../demo-contract/artifacts/orloj_stellar_demo.wasm",
      import.meta.url,
    ),
  );
  const preview = inspectUpload(wasm, c);
  expect(preview.callable).toBe(false);
  expect(preview.functions.every((f) => !("mode" in f))).toBe(true);
});
it("resolves map/tuple/enum/union specifications and rejects recursive definitions", () => {
  const leaf = xdr.ScSpecTypeDef.scSpecTypeU32();
  const udt = (name: string) =>
    xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));
  const en = xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
    new xdr.ScSpecUdtEnumV0({
      doc: "",
      lib: "",
      name: "Choice",
      cases: [new xdr.ScSpecUdtEnumCaseV0({ doc: "", name: "Yes", value: 7 })],
    }),
  );
  const un = xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
    new xdr.ScSpecUdtUnionV0({
      doc: "",
      lib: "",
      name: "Payload",
      cases: [
        xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseTupleV0(
          new xdr.ScSpecUdtUnionCaseTupleV0({
            doc: "",
            name: "Value",
            type: [leaf],
          }),
        ),
      ],
    }),
  );
  const rec = xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      doc: "",
      lib: "",
      name: "Recursive",
      fields: [
        new xdr.ScSpecUdtStructFieldV0({
          doc: "",
          name: "next",
          type: udt("Recursive"),
        }),
      ],
    }),
  );
  expect(parseType(udt("Choice"), [en])).toEqual({
    kind: "Enum",
    cases: [{ name: "Yes", value: 7 }],
  });
  expect(parseType(udt("Payload"), [un])).toEqual({
    kind: "Union",
    cases: [{ name: "Value", items: [{ kind: "u32" }] }],
  });
  expect(() => parseType(udt("Recursive"), [rec])).toThrow("unsupported");
  expect(
    parseType(
      xdr.ScSpecTypeDef.scSpecTypeMap(
        new xdr.ScSpecTypeMap({ keyType: leaf, valueType: udt("Choice") }),
      ),
      [en],
    ).kind,
  ).toBe("Map");
  expect(
    parseType(
      xdr.ScSpecTypeDef.scSpecTypeTuple(
        new xdr.ScSpecTypeTuple({ valueTypes: [leaf] }),
      ),
      [],
    ).kind,
  ).toBe("Tuple");
});
