import { z } from "zod";
import { budget } from "./codec.js";
import { canonical } from "./store.js";
import { fail } from "./errors.js";
import type { ContractInterface, FunctionModel } from "./model.js";
export const MAX_EXACT_FEE = 3000000000n,
  MAX_DAILY_FEE = 10000000000n;
const fee = z.string().regex(/^[1-9][0-9]{0,10}$/);
export const exactGrantSchema = z
  .strictObject({
    interfaceHash: z.string().regex(/^[a-f0-9]{64}$/),
    arguments: z.record(z.string(), z.unknown()),
    maxCalls: z.number().int().min(1).max(100).default(1),
    maxFee: fee.default("3000000000"),
    rollingFee: fee.default("10000000000"),
  })
  .refine(
    (g) =>
      BigInt(g.maxFee) <= MAX_EXACT_FEE &&
      BigInt(g.rollingFee) <= MAX_DAILY_FEE &&
      BigInt(g.maxFee) <= BigInt(g.rollingFee),
  );
export type ExactGrant = z.infer<typeof exactGrantSchema>;
export function checkedGrant(value: unknown): ExactGrant {
  const result = exactGrantSchema.safeParse(value);
  if (!result.success) fail("INVALID_ARGUMENT");
  budget(result.data.arguments);
  return result.data;
}
export function checkExactGrant(
  i: ContractInterface,
  f: FunctionModel,
  args: Record<string, unknown>,
  grant: ExactGrant,
) {
  if (
    i.network !== "testnet" ||
    !["wasm", "stellar_asset"].includes(i.sourceKind ?? "wasm") ||
    f.mode !== "WRITE" ||
    grant.interfaceHash !== i.interfaceHash ||
    canonical(grant.arguments) !== canonical(args)
  )
    fail("WRITE_NOT_PERMITTED");
}
