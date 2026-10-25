import { it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { parseConfig } from "../src/config.js";
import { codes, envelope, RegistryError } from "../src/errors.js";
const base = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  databaseUrl: "postgres://localhost/demo",
  simulationSource: Keypair.random().publicKey(),
};
it("defaults to testnet and disabled writes", () => {
  expect(parseConfig(base).writeMode).toBe(false);
  expect(parseConfig(base).network).toBe("testnet");
});
it("rejects mainnet writes, absent signer, absent fee, and conflicting modes", () => {
  expect(() =>
    parseConfig({ ...base, network: "mainnet", writeMode: true }),
  ).toThrow("policy");
  expect(() => parseConfig({ ...base, writeMode: true })).toThrow("signer");
  expect(() =>
    parseConfig({
      ...base,
      writeMode: true,
      signerSecret: Keypair.random().secret(),
    }),
  ).toThrow("fee");
  const p = {
    contractId: StrKey.encodeContract(Buffer.alloc(32)),
    function: "f",
    mode: "READ",
    principals: ["p"],
  };
  expect(() =>
    parseConfig({ ...base, policies: [p, { ...p, mode: "WRITE" }] }),
  ).toThrow();
});
it("sanitizes every registered code and unexpected exceptions", () => {
  for (const code of codes) {
    const e = envelope(new RegistryError(code));
    expect(e.error_code).toBe(code);
    expect(e.retryable).toBe(false);
  }
  const result = JSON.stringify(
    envelope(new Error("SECRET RPC stack signed XDR")),
  );
  expect(result).not.toContain("SECRET");
  expect(result).not.toContain("stack");
});
it("rejects invalid WRITE_MODE text and malformed environment policy", async () => {
  const { loadConfig } = await import("../src/config.js");
  const env = {
    DATABASE_URL: base.databaseUrl,
    SIMULATION_SOURCE: base.simulationSource,
    WRITE_MODE: "yes",
  };
  expect(() => loadConfig(env)).toThrow("Arguments");
  expect(() =>
    loadConfig({ ...env, WRITE_MODE: "false", STELLAR_POLICIES: "{bad" }),
  ).toThrow("Arguments");
});
