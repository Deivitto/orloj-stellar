# AI BUILD PROMPT — ORLOJ STELLAR MCP REGISTRY

You are implementing Orloj Stellar, a read-and-write MCP registry for Stellar Soroban smart contracts.

Read `ORLOJ_STELLAR_MASTER.md` before writing any code. It is the source of truth. If a requested change conflicts with it, stop and ask for clarification.

## Objective

Build a service that:
- Accepts a Stellar contract ID or WASM file.
- Fetches and validates the Soroban contract specification.
- Converts eligible contract functions into MCP tools.
- Supports read-only simulated calls.
- Supports explicitly allowlisted write transactions with signing, submission, and confirmation.
- Returns structured JSON to AI agents.
- Never exposes private keys or signing material to the agent.

## Tech direction

Preferred stack:
- TypeScript + Node.js
- `@stellar/stellar-sdk`
- MCP SDK
- Zod or equivalent for runtime validation
- SQLite or Postgres for persistence
- Vitest or Jest for tests

Use the Stellar SDK's AssembledTransaction lifecycle for writes:
simulate → assemble authorization → sign → submit → monitor.

Do not manually construct Soroban authorization XDR.

## Build order

Implement in this exact order:

1. Configuration loader
   - network
   - RPC URL
   - simulation source account
   - signer configuration
   - read/write allowlists
   - fee cap
   - rate limits
2. Contract ingestion
   - fetch WASM by contract ID
   - extract contract specification
   - validate contractspecv0
   - compute/store WASM hash
   - cache by network + contract ID + WASM hash
3. Canonical model
   - ContractInterface
   - FunctionModel
   - ParamModel
   - TypeModel
   - FieldModel
4. Type converter
   - Implement only the supported closed grammar.
   - Reject unsupported types with UNSUPPORTED_SOROBAN_TYPE.
   - Use canonical decimal strings for u64/i64/u128/i128 as specified in master version 1.2.
   - Validate Address with SDK StrKey decoding.
   - Implement the expanded bounded grammar and SAC ingestion in master version 1.2; reject ambiguous options, recursive and unknown types.
5. MCP tool generator
   - Generate one MCP tool per eligible function.
   - Sanitize tool names.
   - Use additionalProperties: false.
   - Mark non-Option parameters required.
   - Include function documentation when available.
6. Read executor
   - Build invokeHostFunction.
   - Simulate with simulateTransaction.
   - Reject authorization-required functions.
   - Decode ScVal results.
   - Return SIMULATED.
7. Error handling
   - Implement every error code in the master specification.
   - Never leak raw RPC errors, credentials, signatures, or stack traces.
8. Tests
   - Test every supported type.
   - Test boundary values.
   - Test rejection cases.
   - Test read-only simulation.
   - Test authorization-required behavior.
9. Write executor
   - Implement write gates.
   - Acquire per-source-account lock.
   - Fetch sequence immediately before assembly.
   - Simulate.
   - Assemble authorization with the SDK.
   - Finalize fee.
   - Sign.
   - Persist transaction hash, idempotency binding, and submission intent before sending.
   - Attempt submission once; reconcile ambiguous outcomes without resubmission.
   - Poll getTransaction.
   - Return final status.
10. Demo
    - Curate 1-3 testnet contracts.
    - Expose their read functions.
    - Expose at most 1-2 allowlisted write functions.
    - Provide a CLI or minimal web UI.
    - Prepare a recorded fallback demo.

## Hard rules

- Do not invent contract specifications.
- Do not infer read-only status from function names.
- Do not use regex as the sole Address validator.
- Do not convert u128/i128 through floating-point or native 64-bit integers.
- Do not submit a transaction after a failed simulation.
- Do not automatically retry a submitted write.
- Do not treat sendTransaction acceptance as final success.
- Do not treat getTransaction NOT_FOUND during polling as an error.
- Do not expose secrets, signatures, raw XDR, or stack traces in MCP responses.
- Do not implement KMS/HSM in the first version; use the Signer interface instead.

## Definition of done

The implementation is complete when:
- A valid testnet contract can be ingested.
- Eligible functions appear as MCP tools.
- A read-only function can be simulated and decoded.
- Authorization-required functions return AUTHORIZATION_REQUIRED.
- An allowlisted write function can be simulated, signed, submitted, and confirmed.
- All error codes are reachable and tested.
- No secret material appears in MCP requests, responses, or logs.
- The demo works against Stellar testnet.
