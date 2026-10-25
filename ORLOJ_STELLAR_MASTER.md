# ORLOJ STELLAR — MASTER ARCHITECTURE & BUILD SPECIFICATION

Version: 1.3 — Read + Write MCP Registry for Stellar/Soroban
Status: Source of truth for AI coding agents
Source: David's specification supplied by the user (24 October, 22:43). Typography normalized from the pasted message.

## 1. Product definition

Build **Orloj Stellar**: a registry that converts Stellar Soroban smart-contract interfaces into MCP (Model Context Protocol) servers so AI agents can discover and call contract functions.

It supports:
- READ operations: simulated contract calls; no chain-state change.
- WRITE operations: explicitly allowlisted, signed, submitted, and confirmed transactions.

The agent never receives, holds, or transmits a private key.

## 2. Non-negotiable invariants

1. Closed-world conversion: a function is either fully supported or excluded.
2. No implicit type coercion.
3. No partial MCP tools: if any input or output type is unsupported, skip the entire function.
4. No runtime type guessing: decoded values must match the generated JSON Schema.
5. The agent never sees secret keys, mnemonics, raw signing material, or raw RPC stack traces.
6. Reads never submit transactions.
7. Writes always simulate before signing and submission.
8. A write is successful only after `getTransaction` returns SUCCESS.
9. All caches are keyed by `network + contract_id + interface_hash`.
10. All errors use stable machine-readable codes.

## 3. System architecture

### Components

1. **Spec Ingestion Service**
   - Input: Stellar contract ID + network, or WASM file + network.
   - Fetch deployed WASM.
   - Extract and validate `contractspecv0`.
   - Output: validated contract specification and WASM hash.
2. **Interface Registry**
   - Read function entries and referenced type definitions; expose only functions as tools.
   - Build canonical `FunctionModel` objects.
   - Apply eligibility rules.
   - Cache by `network + contract_id + interface_hash`.
3. **MCP Gateway**
   - Generate MCP tools from eligible `FunctionModel`s.
   - Validate tool arguments against generated JSON Schema.
   - Route READ calls to the Stellar Read Executor.
   - Route WRITE calls to the Stellar Write Executor.
   - Return structured JSON responses.
4. **Stellar Read Executor**
   - Build one `invokeHostFunction` operation.
   - Call `simulateTransaction`.
   - Reject authorization-required calls.
   - Decode ScVal results to JSON.
   - Never submit.
5. **Stellar Write Executor**
   - Check write gates.
   - Acquire per-source-account write lock.
   - Fetch account and sequence number.
   - Build `invokeHostFunction`.
   - Simulate.
   - Assemble authorization using the SDK.
   - Finalize fee.
   - Sign.
   - Submit once.
   - Poll `getTransaction`.
   - Return final status.
6. **Signer Interface**
   - Abstract interface: `sign_transaction_envelope` and `sign_authorization_entries`.
   - Hackathon implementation: testnet environment key.
   - Production target: KMS/HSM.
   - The signer receives only an internal signing request, never agent-controlled secrets.

### Data flow

READ:
Contract ID/WASM → Spec → FunctionModel → MCP Tool → JSON Schema validation → simulateTransaction → ScVal decode → MCP JSON response.

WRITE:
Contract ID/WASM → Spec → FunctionModel → MCP Tool → JSON Schema validation → write gates → simulateTransaction → assemble auth → finalize fee → sign → sendTransaction → getTransaction → decoded final result → MCP JSON response.

## 4. Canonical data model

### ContractInterface

```ts
{
  network: "testnet" | "mainnet",
  contractId: string,
  sourceKind: "wasm" | "stellar_asset",
  interfaceHash: string,
  wasmHash?: string,
  functions: FunctionModel[],
  generatedAt: string
}
```

### FunctionModel

```ts
{
  sorobanName: string;
  mcpToolName: string;
  description: string;
  mode: "READ" | "WRITE";
  params: ParamModel[];
  returns: TypeModel;
  simulationSafe: boolean;
  writeAllowed: boolean;
}
```

### ParamModel

```ts
{
  name: string;
  sorobanType: string;
  jsonSchema: object;
  required: boolean;
  description: string;
  converterId: string;
}
```

### TypeModel

```ts
{
  sorobanType: string;
  jsonSchema: object;
  converterId: string;
  isCollection: boolean;
  itemType?: TypeModel;
  structFields?: FieldModel[];
}
```

## 5. Closed type grammar

### Supported Leaves

| Soroban type | MCP/JSON type | Conversion |
|---|---|---|
| bool | boolean | direct |
| u32 | integer | 0 to 2^32-1 |
| i32 | integer | -2^31 to 2^31-1 |
| u64 | string | canonical decimal string, 0 to 2^64-1 |
| i64 | string | canonical decimal string, -2^63 to 2^63-1 |
| u128 | string | decimal string, 0 to 2^128-1 |
| i128 | string | decimal string, -2^127 to 2^127-1 |
| Symbol | string | valid Soroban symbol |
| Address | string | SDK StrKey validation; G or C |
| Bytes | string | lowercase hex |
| BytesN<N> | string | lowercase hex, exact 2N chars, N <= 256 |
| String | string | UTF-8 output only; otherwise STRING_NOT_UTF8 |
| void | null | no value |

### Supported composites (approved expansion, 25 October 2026)

- Nonrecursive nested structs, vectors, maps, tuples, enums, payload unions and unambiguous options.
- Maps use arrays of `[key,value]` pairs, tuples fixed-length arrays, enums case-name strings, and unions strict `{tag, values}` objects.
- Preserve all existing leaf representations; add SDK-validated MuxedAddress with protocol-gated address variants.
- Maximum type depth 8, collection length 100, aggregate value nodes 1,000, and JSON payload 1 MiB (arguments and results independently).
- Reject recursive definitions, nested Option, Option of a void-encoding type, untyped Val, unknown types and BytesN > 256. Entire unsupported functions remain excluded.

## 6. Function eligibility

A function is eligible only if:

1. It exists in `contractspecv0` or the verified protocol-specific built-in asset specification.
2. Every input and output type is supported.
3. Its name does not collide after MCP sanitization.
4. For READ: an explicit network/contract/function policy permits simulated execution.
5. For WRITE: an explicit network/contract/function policy permits writes, with write mode and a healthy signer configured.

Discovery checks signatures and static policy without fabricating arguments. Simulation, authorization, fee, and dry-run checks run on each invocation using validated arguments. Policy assigns one mode per exposed tool; conflicting assignments fail configuration validation. No authorization requirement or lack of one establishes whether a function changes state.

Do not infer READ/WRITE from function names.

## 7. READ execution rules

1. Validate arguments against the tool JSON Schema.
2. Build one `invokeHostFunction` operation.
3. Use a configured simulation source account.
4. Call `simulateTransaction`.
5. If authorization is required, return `AUTHORIZATION_REQUIRED`.
6. Decode the result strictly.
7. Return `result_status: "SIMULATED"`.
8. Never submit or sign.

## 8. WRITE execution rules

### Eligibility gates

- `WRITE_MODE=true`
- Healthy signer configured
- Function on `WRITE_ALLOWLIST`
- Full signature supported
- Simulation succeeds
- Authorization can be satisfied
- Fee within configured maximum
- Dry-run policy passes

### Pipeline

1. Validate MCP arguments.
2. Check write gates.
3. Acquire per-source-account write lock.
4. Fetch source account and current sequence number.
5. Build one `invokeHostFunction` operation.
6. Simulate.
7. Assemble authorization using the SDK assembled-transaction flow.
8. Re-simulate or apply resource-fee buffer; enforce maximum fee.
9. Sign final transaction envelope.
10. Atomically persist the locally computed final transaction hash, idempotency binding, and submission intent before attempting `sendTransaction`. If persistence fails, do not submit.
11. Attempt submission once. Persist the observed submission outcome; after an ambiguous response or restart, reconcile by hash without automatic resubmission.
12. Poll `getTransaction` with bounded exponential backoff.
13. On SUCCESS, decode result and return `SUBMITTED_AND_CONFIRMED`.
14. On FAILURE, return `FAILED_ON_CHAIN`.
15. On timeout, return `TIMEOUT`; never automatically resubmit.

### Critical rule

Use the Stellar SDK assembled-transaction lifecycle. Do not manually reconstruct Soroban authorization XDR.

## 9. Error codes

| Code | Meaning |
|---|---|
| INVALID_CONTRACT_ID | StrKey decode fails or wrong address kind |
| SPEC_PARSE_FAILED | WASM/spec cannot be parsed |
| DUPLICATE_FUNCTION_NAME | Exported function names collide |
| UNSUPPORTED_SOROBAN_TYPE | Type outside supported grammar |
| TYPE_DEPTH_EXCEEDED | Type nesting exceeds limits |
| TOOL_NAME_COLLISION | Sanitized MCP names collide |
| INVALID_ARGUMENT | JSON Schema validation fails |
| AUTHORIZATION_REQUIRED | Simulation requires unavailable authorization |
| SIMULATION_FAILED | RPC simulation failed |
| RESULT_DECODE_FAILED | Result does not match declared schema |
| STRING_NOT_UTF8 | Returned String bytes are not valid UTF-8 |
| WRITE_NOT_PERMITTED | Write gates failed |
| SIGNER_NOT_CONFIGURED | No healthy signer |
| ACCOUNT_NOT_FOUND | Source account unavailable |
| ARGUMENT_CONVERSION_FAILED | Valid JSON cannot convert to ScVal |
| AUTHORIZATION_FAILED | Auth assembly/signing failed |
| FEE_POLICY_REJECTED | Fee exceeds policy |
| SIGNING_FAILED | Signer refused or failed |
| SUBMISSION_FAILED | sendTransaction rejected |
| TRANSACTION_PENDING_TIMEOUT | Polling timed out |
| TTL_EXPIRED | Contract or ledger TTL issue |

## 10. Response envelopes

### READ success

```json
{
  "ok": true,
  "result_status": "SIMULATED",
  "mode": "READ",
  "network": "testnet",
  "contract_id": "CABC...",
  "wasm_hash": "abc123...",
  "function_name": "get_user",
  "simulated_at": "2026-10-24T12:00:00Z",
  "data": {}
}
```

### WRITE success

```json
{
  "ok": true,
  "result_status": "SUBMITTED_AND_CONFIRMED",
  "mode": "WRITE",
  "network": "testnet",
  "contract_id": "CABC...",
  "function_name": "increment",
  "transaction_hash": "abc123...",
  "ledger": 123456,
  "fee_charged": "100",
  "data": {}
}
```

### Error

```json
{
  "ok": false,
  "error_code": "AUTHORIZATION_REQUIRED",
  "retryable": false,
  "contract_id": "CABC...",
  "function_name": "get_user",
  "human_message": "This function requires authorization that is not configured."
}
```

## 11. Configuration

| Setting | Hackathon default | Production target |
|---|---|---|
| WRITE_MODE | false until demo | true only for allowlisted tools |
| Network | testnet | mainnet or production network |
| Signer | testnet environment key | KMS/HSM |
| READ_ALLOWLIST | curated functions | contract + function policy |
| WRITE_ALLOWLIST | 1-2 functions | contract + function + argument policy |
| MAX_FEE | small fixed cap | per-tool policy |
| VEC_MAX_ITEMS | 100 | configurable |
| BYTESN_MAX_BYTES | 256 | configurable |
| POLL_TIMEOUT | 60-120 seconds | configurable |
| SIM_TO_SUBMIT_MAX_AGE | 60 seconds | short bounded window |
| RATE_LIMIT | per agent/tool | per agent/tool/contract/account |

## 12. Test matrix

| Test | Expected |
|---|---|
| bool round-trip | true/false |
| u64 boundaries | 0 and 2^64-1 |
| u128 max | correct decimal string |
| i128 min | correct decimal string |
| G account Address | valid |
| C contract Address | valid |
| BytesN<32> | exactly 64 hex chars |
| Option<u64> null | null |
| Vec<u64> 100 items | accepted |
| Vec<u64> 101 items | rejected before RPC |
| Nested Vec | bounded round-trip |
| Enum payload | tagged round-trip |
| Map | typed pairs, duplicate keys rejected |
| Auth-required READ | AUTHORIZATION_REQUIRED |
| Invalid argument | INVALID_ARGUMENT |
| Simulation failure | SIMULATION_FAILED |
| Write success | SUBMITTED_AND_CONFIRMED |
| Write on-chain failure | FAILED_ON_CHAIN |
| Duplicate submission | same transaction hash reconciled |
| Poll timeout | TIMEOUT with retained hash |

## 13. Approved clarifications (25 October 2026)

The user delegated these decisions. This section resolves ambiguity in version 1.0.

### Exact numeric transport

Use decimal strings for u64, i64, u128, and i128 in both inputs and outputs. Convert through arbitrary-precision integers only. Reject JSON numbers, whitespace, plus signs, leading zeroes (except `0`), negative zero, exponents, and out-of-range values. u32/i32 remain JSON integers with strict range validation.

### Final failure responses

For confirmed on-chain failure, return `ok: false`, `result_status: "FAILED_ON_CHAIN"`, `error_code: "TRANSACTION_FAILED_ON_CHAIN"`, and `retryable: false`. For an unresolved polling deadline, return `ok: false`, `result_status: "TIMEOUT"`, `error_code: "TRANSACTION_PENDING_TIMEOUT"`, and `retryable: false`. Both responses retain network, contract ID, function name, and transaction hash. Timeout means unresolved, not failed on chain. Read-only status reconciliation is permitted; timeout never authorizes automatic resubmission. Add TRANSACTION_FAILED_ON_CHAIN to the stable error codes and tests.

### WASM-only ingestion

Unbound WASM uploads support inspection and preview only. They cannot register callable tools or enter the executable interface cache. Require a deployed contract ID and verify its network and WASM hash before binding. Executable interface caches use network + contract ID + interface hash; WASM interfaces retain their real WASM hash.

### Discovery and policy

Mode is assigned by explicit network/contract/function policy, never inferred from names. List statically eligible tools before argument-dependent simulation; listing is not a promise that all invocations succeed. Recheck policy and all applicable gates for every call. Reads always simulate, even if the contract function would mutate state when submitted.

### Struct resolution

Read referenced specification type definitions to resolve supported structs; only function entries produce tools. Define `FieldModel` as `{ name: string; type: TypeModel; description: string }`. All declared struct fields are required; Option fields may be null. Reject additional fields and all unsupported signatures as a whole.

### Optional function arguments

For top-level Option parameters only, omission and explicit JSON null both mean Soroban None. A supplied non-null value must satisfy the exact inner type. This is the documented Option encoding, not general type coercion. Non-Option parameters are required.

### Durable writes and idempotency

Require a caller-supplied idempotency key for every write. Scope it to the authenticated principal and network. Persist a canonical request fingerprint including contract, WASM hash, function, validated arguments, and source account. Reuse with different input fails with stable IDEMPOTENCY_CONFLICT; reuse with identical input returns or reconciles the existing attempt. Concurrent duplicates must resolve through a durable unique constraint. Add IDEMPOTENCY_CONFLICT to error codes and tests.

Use a per-network/source-account lock covering sequence acquisition, assembly, signing, durable intent, and submission. Enforce equivalent cross-process serialization when multiple workers run. Persist intent and the deterministic signed-transaction hash before any send. A crash after intent but before a recorded send outcome is ambiguous and must be reconciled without resending. Never claim exactly-once delivery or successful execution from an accepted submission.

Keep unresolved attempts and their hashes across restarts. NOT_FOUND remains pending until the polling deadline. A separate status lookup may continue reconciliation later. Never silently rebuild or re-sign a timed-out write. Any new attempt needs an explicit new request and a policy that prevents accidental duplication of an unresolved operation. No raw signed XDR or signing material is returned to agents or logged.

## 14. Approved complete interface and asset support (25 October 2026)

Detect WASM versus built-in Stellar Asset Contract executables before fetching code. Built-in assets have no WASM hash. Use pinned official, protocol-versioned SAC definitions with provenance and checksums; unknown protocols fail UNSUPPORTED_PROTOCOL. Support contract IDs and verified native/issued asset descriptors without deploying during registration.

Interfaces carry sourceKind and interfaceHash. WASM retains its real wasmHash; SAC fingerprints canonical specification, protocol, adapter and encoding versions. Cache migration preserves existing records and write history. New response envelopes include source_kind/interface_hash and omit wasm_hash for SAC. Preserve historical idempotency fingerprints and reconcile submitted writes using their original metadata.

Inventory includes all declared methods with signatures, eligibility, policy state and exclusion reasons; only explicitly permitted methods become callable tools. Support administrative methods with real authorization; possession does not confer issuer privileges. Native-asset restrictions remain visible. No classic operations outside the SAC API are implied. SAC amounts remain base-unit decimal strings, with exact formatting/parsing helpers. Default writes remain testnet only and individually allowlisted. No signing, submission, fee, account-lock or secret-handling invariant is relaxed.

Asset diagnostic codes: ASSET_OPERATION_UNSUPPORTED, ASSET_BALANCE_ERROR, ASSET_NOT_AUTHORIZED, ASSET_TRUSTLINE_REQUIRED, ASSET_ALLOWANCE_ERROR, ASSET_RESERVE_ERROR. Map only typed diagnostic errors attributed to the target SAC; unknown failures remain SIMULATION_FAILED. Never return diagnostic payloads.

## 15. Approved local testnet product (25 October 2026)

The user approved a Stellar-first local product, preserving EVM compatibility. Integrate app registration/catalog/chat and existing agent credentials. Owner-authorize all control-plane actions. Registration grants no write permission. Signing modes: owner-linked Freighter approval and a separate encrypted managed testnet wallet per agent. Managed unattended execution is restricted to verified SAC transfers with explicit recipient, per-write, rolling-24-hour amount and fee budgets; default deny. Reserve pending exposure atomically, including unresolved old operations.

MCP writes are durable asynchronous operations with operation IDs and AWAITING_APPROVAL/PENDING states. Add a collision-free read-only operation status tool. Signing payloads stay in the owner-only signing channel. Recheck credentials, current ownership, wallet binding and policy revision atomically at durable intent. Revocation blocks new intent; existing intent is reconciled, never automatically resubmitted. Persist signed sequence and maximum time before any send. Release an ambiguous reservation only under the source-account lock after confirmed terminal status or authoritative ledger expiry/non-inclusion proof; legacy incomplete metadata remains blocked.

Managed keys use AES-256-GCM with random nonces and authenticated agent/network/key-version metadata. Master keys belong only to a dedicated signer service. Wallet secrets and signer material never enter agent runtime environment or mounts. Ownership changes suspend unattended grants. Provision actual isolated agent runtime and configurable model provider, magic-link local delivery and reproducible local stack. Mainnet writes, hosted deployment, KMS/HSM and arbitrary unattended contract methods remain outside this release. Real browser-to-chat acceptance and independent verification are mandatory; missing provider credentials or hosted CI billing failures must remain explicit blockers, not claimed passes.
