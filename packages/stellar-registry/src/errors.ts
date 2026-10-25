export const codes = [
  "INVALID_CONTRACT_ID",
  "UNSUPPORTED_PROTOCOL",
  "ASSET_OPERATION_UNSUPPORTED",
  "ASSET_BALANCE_ERROR",
  "ASSET_NOT_AUTHORIZED",
  "ASSET_TRUSTLINE_REQUIRED",
  "ASSET_ALLOWANCE_ERROR",
  "ASSET_RESERVE_ERROR",

  "SPEC_PARSE_FAILED",
  "DUPLICATE_FUNCTION_NAME",
  "UNSUPPORTED_SOROBAN_TYPE",
  "TYPE_DEPTH_EXCEEDED",
  "TOOL_NAME_COLLISION",
  "INVALID_ARGUMENT",
  "AUTHORIZATION_REQUIRED",
  "SIMULATION_FAILED",
  "RESULT_DECODE_FAILED",
  "STRING_NOT_UTF8",
  "WRITE_NOT_PERMITTED",
  "SIGNER_NOT_CONFIGURED",
  "ACCOUNT_NOT_FOUND",
  "ARGUMENT_CONVERSION_FAILED",
  "AUTHORIZATION_FAILED",
  "FEE_POLICY_REJECTED",
  "SIGNING_FAILED",
  "SUBMISSION_FAILED",
  "TRANSACTION_PENDING_TIMEOUT",
  "TTL_EXPIRED",
  "TRANSACTION_FAILED_ON_CHAIN",
  "IDEMPOTENCY_CONFLICT",
  "STALE_INTERFACE",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof codes)[number];
const messages: Record<ErrorCode, string> = {
  UNSUPPORTED_PROTOCOL: "This network protocol has no verified asset adapter.",
  ASSET_BALANCE_ERROR:
    "The asset balance is insufficient or below its required reserve.",
  ASSET_NOT_AUTHORIZED:
    "The asset balance or trustline is not authorized for this operation.",
  ASSET_TRUSTLINE_REQUIRED: "The destination needs a trustline for this asset.",
  ASSET_ALLOWANCE_ERROR: "The delegated allowance is insufficient or expired.",
  ASSET_RESERVE_ERROR:
    "The account has insufficient XLM reserve to create the trustline.",
  ASSET_OPERATION_UNSUPPORTED: "This operation is unavailable for this asset.",
  INVALID_CONTRACT_ID: "A valid Stellar contract address is required.",
  SPEC_PARSE_FAILED: "The contract specification could not be read.",
  DUPLICATE_FUNCTION_NAME: "The specification has duplicate functions.",
  UNSUPPORTED_SOROBAN_TYPE: "This signature contains an unsupported type.",
  TYPE_DEPTH_EXCEEDED: "This signature exceeds supported type depth.",
  TOOL_NAME_COLLISION: "Function tool names collide.",
  INVALID_ARGUMENT: "Arguments do not match the tool schema.",
  AUTHORIZATION_REQUIRED:
    "This function requires authorization that is not configured.",
  SIMULATION_FAILED: "Contract simulation failed.",
  RESULT_DECODE_FAILED: "The result does not match the declared type.",
  STRING_NOT_UTF8: "The returned string is not valid UTF-8.",
  WRITE_NOT_PERMITTED: "Write policy does not permit this operation.",
  SIGNER_NOT_CONFIGURED: "A healthy signer is not configured.",
  ACCOUNT_NOT_FOUND: "The source account is unavailable.",
  ARGUMENT_CONVERSION_FAILED: "Arguments could not be converted.",
  AUTHORIZATION_FAILED: "Contract authorization could not be satisfied.",
  FEE_POLICY_REJECTED: "The transaction exceeds the fee policy.",
  SIGNING_FAILED: "Transaction signing failed.",
  SUBMISSION_FAILED: "Transaction submission was rejected.",
  TRANSACTION_PENDING_TIMEOUT:
    "Transaction confirmation is unresolved; reconcile by hash.",
  TTL_EXPIRED: "Contract state requires restoration.",
  TRANSACTION_FAILED_ON_CHAIN: "The transaction failed on chain.",
  IDEMPOTENCY_CONFLICT: "The idempotency key is bound to a different request.",
  STALE_INTERFACE:
    "The deployed code changed; refresh registration and tool discovery.",
  UNAUTHORIZED: "Authentication is required.",
  RATE_LIMITED: "The request rate limit was exceeded.",
  INTERNAL_ERROR: "The operation could not be completed.",
};
export class RegistryError extends Error {
  constructor(public code: ErrorCode) {
    super(messages[code]);
  }
}
export function fail(code: ErrorCode): never {
  throw new RegistryError(code);
}
export function envelope(
  error: unknown,
  context: Record<string, unknown> = {},
) {
  const e =
    error instanceof RegistryError
      ? error
      : new RegistryError("INTERNAL_ERROR");
  return {
    ...context,
    ok: false,
    error_code: e.code,
    retryable: false,
    human_message: e.message,
  };
}
export async function mapped<T>(
  code: ErrorCode,
  f: () => Promise<T>,
): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    return fail(code);
  }
}
