import { expect, it, vi } from "vitest";
import {
  Asset,
  Keypair,
  Networks,
  StrKey,
  contract,
} from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  assetInterface,
  assetSpec,
  assetProvenance,
  ingestAsset,
  parseAmount,
  formatAmount,
} from "../src/assets.js";
import { ingest } from "../src/ingestion.js";
import { parseConfig } from "../src/config.js";
import { Executor } from "../src/executor.js";
const id = StrKey.encodeContract(Buffer.alloc(32, 9));
const c = parseConfig({
  rpcUrl: "https://soroban-testnet.stellar.org",
  databaseUrl: "postgres://localhost/test",
  simulationSource: Keypair.random().publicKey(),
});
const rpcMock = () => ({
  getNetwork: vi.fn(async () => ({
    passphrase: Networks.TESTNET,
    protocolVersion: "29",
  })),
  getContractInstance: vi.fn(async () => ({
    executable: { type: "contractExecutableStellarAsset" },
  })),
  getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
});
it("pins the full public SAC interface to official source and checksum", () => {
  const source = readFileSync(
    new URL("../fixtures/sac-v29.contract.rs", import.meta.url),
  );
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    assetProvenance.source_sha256,
  );
  const names = [...source.toString().matchAll(/pub\(crate\) fn (\w+)\(/g)]
    .map((m) => m[1])
    .filter((n) => n !== "init_asset");
  expect(
    assetSpec(29)
      .funcs()
      .map((f) => f.name.toString()),
  ).toEqual(names);
  expect(names).toHaveLength(17);
  const i = assetInterface(c, id, 29);
  expect(i.inventory).toHaveLength(17);
  expect(i.functions).toHaveLength(0);
  expect(
    i.inventory?.find((m) => m.name === "transfer")?.signature?.params[1].type
      .node.kind,
  ).toBe("MuxedAddress");
  expect(i.inventory?.find((m) => m.name === "trust")?.eligible).toBe(true);
  expect(i.wasmHash).toBeUndefined();
  expect(() => assetSpec(30)).toThrow("verified asset adapter");
});
it("ingests built-in executables without fetching WASM or deploying", async () => {
  const r = rpcMock();
  const i = await ingest(r, c, id);
  expect(i.sourceKind).toBe("stellar_asset");
  expect(r.getContractWasmByContractId).not.toHaveBeenCalled();
  expect(i.interfaceHash).toBe(assetInterface(c, id, 29).interfaceHash);
  await expect(ingest(r, c, id, new Uint8Array())).rejects.toThrow("Arguments");
  r.getNetwork.mockResolvedValue({
    passphrase: Networks.TESTNET,
    protocolVersion: "30",
  });
  await expect(ingest(r, c, id)).rejects.toThrow("verified asset adapter");
});
it("derives verified native and issued asset contract IDs and exposes native restrictions", async () => {
  const r = rpcMock();
  const n = await ingestAsset(r, c, { kind: "native" });
  expect(n.contractId).toBe(Asset.native().contractId(Networks.TESTNET));
  expect(n.inventory?.find((m) => m.name === "mint")?.restriction).toContain(
    "native",
  );
  const descriptor = {
    kind: "issued" as const,
    code: "TEST",
    issuer: Keypair.random().publicKey(),
  };
  const i = await ingestAsset(r, c, descriptor);
  expect(i.asset).toEqual(descriptor);
  expect(i.contractId).toBe(
    new Asset(descriptor.code, descriptor.issuer).contractId(Networks.TESTNET),
  );
});
it("only exposes explicitly enabled methods, including admin methods", () => {
  const i = assetInterface(
    {
      ...c,
      policies: [
        { contractId: id, function: "mint", mode: "WRITE", principals: ["p"] },
      ],
    },
    id,
    29,
  );
  expect(i.functions.map((f) => f.sorobanName)).toEqual(["mint"]);
  expect(i.functions[0].mode).toBe("WRITE");
  expect(i.functions[0].writeAllowed).toBe(false);
});
it("invalidates SAC calls on executable or protocol changes", async () => {
  const r = rpcMock();
  const e = new Executor(c, r as never, {} as never);
  const i = assetInterface(c, id, 29);
  await e.current(i);
  r.getNetwork.mockResolvedValue({
    passphrase: Networks.TESTNET,
    protocolVersion: "30",
  });
  await expect(e.current(i)).rejects.toThrow("verified asset adapter");
});
it("converts human amounts exactly without coercion or rounding", () => {
  expect(parseAmount("1.0000001", 7)).toBe("10000001");
  expect(formatAmount("10000001", 7)).toBe("1.0000001");
  expect(parseAmount("170141183460469231731687303715884105727", 0)).toBe(
    "170141183460469231731687303715884105727",
  );
  for (const v of ["01", "-1", "1e2", "1.00000001", " 1"])
    expect(() => parseAmount(v, 7)).toThrow();
  expect(() =>
    parseAmount("170141183460469231731687303715884105728", 0),
  ).toThrow();
});
it("maps only verified contract diagnostic errors and never returns raw RPC text", async () => {
  const { xdr } = await import("@stellar/stellar-sdk");
  const { requireSimulation } = await import("../src/executor.js");
  const event = (contractId: string, n: number) =>
    new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId: new xdr.ContractId(StrKey.decodeContract(contractId)),
        type: xdr.ContractEventType.diagnostic,
        body: xdr.ContractEventBody.v0(
          new xdr.ContractEventV0({
            topics: [
              xdr.ScVal.scvSymbol("error"),
              xdr.ScVal.scvError(xdr.ScError.sceContract(n)),
            ],
            data: xdr.ScVal.scvVoid(),
          }),
        ),
      }),
    });
  const sim = {
    id: "1",
    latestLedger: 1,
    _parsed: true,
    error: "PRIVATE RPC DETAIL",
    events: [event(id, 13)],
  };
  expect(() => requireSimulation(sim, id)).toThrow("trustline");
  expect(() =>
    requireSimulation(sim, StrKey.encodeContract(Buffer.alloc(32, 3))),
  ).toThrow("simulation failed");
  expect(() =>
    requireSimulation({ ...sim, events: [event(id, 10)] }, id),
  ).toThrow("balance");
});
