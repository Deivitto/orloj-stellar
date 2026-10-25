import { z } from "zod";
import { Networks, StrKey, Keypair } from "@stellar/stellar-sdk";
import { fail } from "./errors.js";
const policy = z
  .object({
    contractId: z.string(),
    function: z.string().min(1),
    mode: z.enum(["READ", "WRITE"]),
    principals: z.array(z.string().min(1)).min(1),
  })
  .strict();
const schema = z
  .object({
    network: z.enum(["testnet", "mainnet"]).default("testnet"),
    rpcUrl: z.url(),
    databaseUrl: z.string().min(1),
    simulationSource: z.string(),
    writeMode: z.boolean().default(false),
    signerSecret: z.string().optional(),
    maxFee: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    policies: z.array(policy).default([]),
    port: z.number().int().min(1).max(65535).default(3002),
    host: z.string().default("127.0.0.1"),
    pollTimeoutMs: z.number().int().min(1).default(120000),
    simulationMaxAgeMs: z.number().int().min(1).max(60000).default(60000),
    rateLimit: z.number().int().positive().default(60),
  })
  .strict();
export type Config = z.infer<typeof schema> & { networkPassphrase: string };
export function parseConfig(input: unknown): Config {
  const r = schema.safeParse(input);
  if (!r.success) fail("INVALID_ARGUMENT");
  const c = r.data;
  if (!StrKey.isValidEd25519PublicKey(c.simulationSource))
    fail("INVALID_ARGUMENT");
  const url = new URL(c.rpcUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    fail("INVALID_ARGUMENT");
  const seen = new Set<string>();
  for (const p of c.policies) {
    if (!StrKey.isValidContract(p.contractId)) fail("INVALID_CONTRACT_ID");
    const k = p.contractId + ":" + p.function;
    if (seen.has(k)) fail("INVALID_ARGUMENT");
    seen.add(k);
  }
  if (c.writeMode) {
    if (c.network !== "testnet") fail("WRITE_NOT_PERMITTED");
    if (!c.signerSecret) fail("SIGNER_NOT_CONFIGURED");
    try {
      Keypair.fromSecret(c.signerSecret);
    } catch {
      fail("SIGNER_NOT_CONFIGURED");
    }
    if (!c.maxFee) fail("FEE_POLICY_REJECTED");
  }
  return {
    ...c,
    networkPassphrase:
      c.network === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    if (
      env.WRITE_MODE !== undefined &&
      !["true", "false"].includes(env.WRITE_MODE)
    )
      fail("INVALID_ARGUMENT");
    return parseConfig({
      network: env.STELLAR_NETWORK ?? "testnet",
      rpcUrl: env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
      databaseUrl: env.DATABASE_URL,
      simulationSource: env.SIMULATION_SOURCE,
      writeMode: env.WRITE_MODE === "true",
      signerSecret: env.STELLAR_SIGNER_SECRET,
      maxFee: env.MAX_FEE,
      policies: JSON.parse(env.STELLAR_POLICIES ?? "[]"),
      port: env.PORT ? Number(env.PORT) : 3002,
      host: env.HOST ?? "127.0.0.1",
      pollTimeoutMs: env.POLL_TIMEOUT_MS ? Number(env.POLL_TIMEOUT_MS) : 120000,
      simulationMaxAgeMs: env.SIM_TO_SUBMIT_MAX_AGE_MS
        ? Number(env.SIM_TO_SUBMIT_MAX_AGE_MS)
        : 60000,
      rateLimit: env.RATE_LIMIT ? Number(env.RATE_LIMIT) : 60,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "SyntaxError")
      fail("INVALID_ARGUMENT");
    throw e;
  }
}
export function permitted(
  c: Config,
  contractId: string,
  fn: string,
  principal: string,
) {
  return c.policies.find(
    (p) =>
      p.contractId === contractId &&
      p.function === fn &&
      p.principals.includes(principal),
  );
}
