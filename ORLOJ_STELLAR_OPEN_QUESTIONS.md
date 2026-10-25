# Specification decisions — resolved

On 25 October 2026, the user delegated all seven decisions. Master specification version 1.1 section 13 contains the authoritative resolutions.

1. Use canonical decimal strings for full-range 64-bit and 128-bit integers.
2. Define stable final-failure and timeout envelopes retaining the transaction hash.
3. Unbound WASM supports inspection/preview until verified against a deployed contract.
4. Explicit policy assigns mode; static discovery precedes invocation-specific simulation.
5. Resolve referenced struct definitions; only functions become tools; define FieldModel.
6. Omitted top-level Option arguments and explicit null both encode None.
7. Require durable idempotency and persist submission intent/hash before sending; reconcile ambiguous outcomes without resubmission.

These decisions are implemented in `packages/stellar-registry`. Live testnet read/write and duplicate-key reconciliation evidence is recorded in `demo-contract/evidence.json`; the package README documents operational limits and verification.

The approved complete-interface plan is incorporated in master version 1.2: bounded composite types, verified built-in SAC ingestion, interface identity migration, complete inventory and policy-gated administrative methods. Protocol 29 is the initial verified SAC adapter.
