import { expect, it } from "vitest";
import { Address, contract, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { decode, encode, model } from "../src/codec.js";
import { inspectSpec } from "../src/ingestion.js";
import { parseConfig, loadConfig } from "../src/config.js";
import { declaredContractError, requireSimulation } from "../src/executor.js";
import { envelope } from "../src/errors.js";
import type { TypeNode } from "../src/model.js";
const result: TypeNode = {
  kind: "Result",
  ok: { kind: "u64" },
  errors: [{ name: "InsufficientBalance", value: 7 }],
};
it("decodes host Result success without a vector wrapper and rejects malformed success", () => {
  expect(
    decode(result, encode({ kind: "u64" }, "18446744073709551615")),
  ).toEqual({ tag: "Ok", values: ["18446744073709551615"] });
  expect(() => decode(result, xdr.ScVal.scvBool(true))).toThrow();
  expect(() => encode(result, { tag: "Ok", values: ["1"] })).toThrow();
  expect(() => model({ kind: "Vec", item: result })).toThrow();
  expect(
    decode(
      { kind: "Result", ok: { kind: "Tuple", items: [] }, errors: [] },
      xdr.ScVal.scvVoid(),
    ),
  ).toEqual({ tag: "Ok", values: [[]] });
});
for (const kind of ["u256", "i256"] as const)
  it(`round trips exact ${kind} boundaries`, () => {
    const max = kind === "u256" ? (1n << 256n) - 1n : (1n << 255n) - 1n;
    const min = kind === "u256" ? 0n : -(1n << 255n);
    for (const n of [min, 0n, max])
      expect(decode({ kind }, encode({ kind }, n.toString()))).toBe(
        n.toString(),
      );
    for (const n of [min - 1n, max + 1n])
      expect(() => encode({ kind }, n.toString())).toThrow();
    expect(() => encode({ kind }, 1)).toThrow();
  });
const id = StrKey.encodeContract(Buffer.alloc(32, 4));
function diagnostic(contractId = id, code = 7) {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: new xdr.ContractId(StrKey.decodeContract(contractId)),
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: [
            xdr.ScVal.scvSymbol("error"),
            xdr.ScVal.scvError(xdr.ScError.sceContract(code)),
          ],
          data: xdr.ScVal.scvString("PRIVATE RPC DETAIL"),
        }),
      ),
    }),
  });
}
it("only attributes declared typed contract errors and never emits raw diagnostics", () => {
  const d = diagnostic();
  const error = declaredContractError([d], id, result);
  expect(envelope(error)).toMatchObject({
    error_code: "CONTRACT_EXECUTION_FAILED",
    contract_error: { code: 7, name: "InsufficientBalance" },
  });
  expect(JSON.stringify(envelope(error))).not.toContain("PRIVATE");
  expect(
    declaredContractError(
      [diagnostic(StrKey.encodeContract(Buffer.alloc(32, 5)))],
      id,
      result,
    ),
  ).toBeUndefined();
  expect(
    declaredContractError([diagnostic(id, 8)], id, result),
  ).toBeUndefined();
  expect(
    declaredContractError([d, diagnostic(id, 8)], id, result),
  ).toBeUndefined();
  expect(
    declaredContractError([d], id, { ...result, errors: [] }),
  ).toBeUndefined();
  expect(
    declaredContractError([d], id, {
      ...result,
      errors: [],
      genericError: true,
    })?.contractError,
  ).toEqual({ code: 7 });
  expect(() =>
    requireSimulation(
      {
        id: "1",
        _parsed: true,
        latestLedger: 1,
        error: "private",
        events: [d],
      },
      undefined,
      { id, returns: result },
    ),
  ).toThrow("The contract returned an execution error.");
});
it("discovers declared Result methods but leaves new tools disabled and preserves unsupported signatures", () => {
  const udt = xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
    new xdr.ScSpecUdtErrorEnumV0({
      doc: "",
      lib: "",
      name: "Error",
      cases: [
        new xdr.ScSpecUdtErrorEnumCaseV0({
          doc: "",
          name: "InsufficientBalance",
          value: 7,
        }),
      ],
    }),
  );
  const f = (name: string, output: xdr.ScSpecTypeDef) =>
    xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({
        doc: "",
        name,
        inputs: [],
        outputs: [output],
      }),
    );
  const spec = new contract.Spec([
    udt,
    f(
      "balance",
      xdr.ScSpecTypeDef.scSpecTypeResult(
        new xdr.ScSpecTypeResult({
          okType: xdr.ScSpecTypeDef.scSpecTypeU64(),
          errorType: xdr.ScSpecTypeDef.scSpecTypeUdt(
            new xdr.ScSpecTypeUdt({ name: "Error" }),
          ),
        }),
      ),
    ),
    f("untyped", xdr.ScSpecTypeDef.scSpecTypeVal()),
    f(
      "muxed",
      xdr.ScSpecTypeDef.scSpecTypeResult(
        new xdr.ScSpecTypeResult({
          okType: xdr.ScSpecTypeDef.scSpecTypeMuxedAddress(),
          errorType: xdr.ScSpecTypeDef.scSpecTypeError(),
        }),
      ),
    ),
  ]);
  const c = parseConfig({
    rpcUrl: "https://soroban-testnet.stellar.org",
    databaseUrl: "postgres://localhost/test",
    simulationSource: Keypair.random().publicKey(),
  });
  const i = inspectSpec(spec, c, id, {
    sourceKind: "wasm",
    protocolVersion: 29,
  });
  expect(i.functions).toHaveLength(0);
  const muxed = i.inventory?.find((m) => m.name === "muxed")?.signature?.returns
    .node;
  expect(muxed).toMatchObject({
    kind: "Result",
    genericError: true,
    ok: { kind: "MuxedAddress", protocol: 29 },
  });
  const publicKey = Keypair.random().publicKey();
  const m = StrKey.encodeMed25519PublicKey(
    Buffer.concat([
      Buffer.from(StrKey.decodeEd25519PublicKey(publicKey)),
      Buffer.alloc(8),
    ]),
  );
  expect(decode(muxed!, Address.fromString(m).toScVal())).toEqual({
    tag: "Ok",
    values: [m],
  });
  expect(i.inventory?.[0]).toMatchObject({
    name: "balance",
    eligible: true,
    policyStatus: "disabled",
  });
  expect(i.inventory?.[1]).toMatchObject({
    name: "untyped",
    eligible: false,
    declaredSignature: { name: "untyped" },
    exclusion: { location: "outputs[0]", type: "val" },
  });
});
it("validates bounded configurable instruction leeway", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/test",
    SIMULATION_SOURCE: Keypair.random().publicKey(),
  };
  expect(loadConfig(env).instructionLeeway).toBe(1000000);
  expect(
    loadConfig({ ...env, CPU_INSTRUCTION_LEEWAY: "0" }).instructionLeeway,
  ).toBe(0);
  for (const v of ["-1", "10000001", "NaN", "1.2"])
    expect(() => loadConfig({ ...env, CPU_INSTRUCTION_LEEWAY: v })).toThrow();
});

it("rejects undeclared or host ScVal errors instead of guessing Result variants", () => {
  expect(() =>
    decode(result, xdr.ScVal.scvError(xdr.ScError.sceContract(999))),
  ).toThrow("declared type");
  try {
    decode(result, xdr.ScVal.scvError(xdr.ScError.sceContract(7)));
    throw Error("expected failure");
  } catch (e) {
    expect(envelope(e)).toMatchObject({
      error_code: "CONTRACT_EXECUTION_FAILED",
      contract_error: { code: 7, name: "InsufficientBalance" },
    });
  }
});

it("does not attribute a later foreign same-code failure to a caught target error", () => {
  const target = diagnostic(id, 7),
    foreign = diagnostic(StrKey.encodeContract(Buffer.alloc(32, 6)), 7);
  const terminal = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: [
            xdr.ScVal.scvSymbol("host_fn_failed"),
            xdr.ScVal.scvError(xdr.ScError.sceContract(7)),
          ],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  });
  expect(
    declaredContractError([target, foreign, terminal], id, result),
  ).toBeUndefined();
  expect(
    declaredContractError([foreign, target, terminal], id, result)
      ?.contractError,
  ).toEqual({ code: 7, name: "InsufficientBalance" });
});

it("applies the bounded grammar to Result payload itself without an invented host container", () => {
  let ok: TypeNode = { kind: "u64" };
  for (let n = 0; n < 8; n++) ok = { kind: "Vec", item: ok };
  expect(() => model({ kind: "Result", ok, errors: [] })).not.toThrow();
  expect(() =>
    model({ kind: "Result", ok: { kind: "Vec", item: ok }, errors: [] }),
  ).toThrow("depth");
});
