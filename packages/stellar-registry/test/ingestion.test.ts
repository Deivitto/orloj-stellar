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
it("extracts the real demo WASM spec and excludes its nested vector function", async () => {
  const wasm = await readFile(
    new URL(
      "../demo-contract/artifacts/orloj_stellar_demo.wasm",
      import.meta.url,
    ),
  );
  const i = inspect(wasm, c);
  expect(i.functions.length).toBe(19);
  expect(
    i.functions.find((f) => f.sorobanName === "echo_record")?.params[0].type
      .structFields,
  ).toHaveLength(3);
  expect(i.excluded).toContainEqual({
    name: "unsupported",
    error_code: "UNSUPPORTED_SOROBAN_TYPE",
  });
  expect(i.contractId).toBe("");
});
it("rejects malformed WASM and unsupported map, tuple, result, val and recursive types", () => {
  expect(() => inspect(new Uint8Array([1, 2, 3]), c)).toThrow("specification");
  const types = [
    xdr.ScSpecTypeDef.scSpecTypeVal(),
    xdr.ScSpecTypeDef.scSpecTypeU256(),
  ];
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
  for (let n = 0; n < 4; n++)
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
