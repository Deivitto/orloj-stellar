# Orloj Stellar registry

A separate TypeScript service for Soroban WASM contracts. It exposes strict MCP tools, simulates reads, and supports explicitly allowed testnet writes. The existing EVM registry and web app remain separate. See the repository's master specification v1.1.

## Local setup

Use Node **24.15.0**, pnpm **10.33.2**, PostgreSQL **17**, and Stellar CLI **27.0.0** for the demo contract. Rust needs the `wasm32v1-none` target.

From the repository root:

```sh
pnpm install --frozen-lockfile --filter @orloj/stellar-registry
cd packages/stellar-registry
cp .env.example .env
chmod 600 .env
docker compose up -d
pnpm build
```

Fill in `.env` with a funded testnet `SIMULATION_SOURCE` G address. Keep writes disabled initially. The operator configures policies; callers cannot supply an RPC URL, network passphrase, source account, or signer.

Example `STELLAR_POLICIES` (one JSON line in `.env`):

```json
[{"contractId":"YOUR_DEPLOYED_C_ADDRESS","function":"count","mode":"READ","principals":["demo"]},{"contractId":"YOUR_DEPLOYED_C_ADDRESS","function":"increment","mode":"WRITE","principals":["demo"]}]
```

Only functions explicitly assigned a mode and principal are callable. Restart after policy changes and re-register to refresh persisted tool definitions. READ means simulation only; it does not assert that the contract function itself cannot mutate state.

```sh
pnpm cli migrate
pnpm cli credential demo /absolute/path/demo.token
pnpm cli register YOUR_DEPLOYED_C_ADDRESS
pnpm start
```

The credential command writes a new token file with mode 0600 and never prints its contents. Set `STELLAR_TOKEN_FILE` to that file for CLI `list`, `call`, and `status`. Use `pnpm cli revoke /absolute/path/demo.token` to revoke it.

## Interfaces

- `POST /contracts/:contractId/mcp`: bearer-authenticated, stateless Streamable HTTP MCP; discovery and calls follow principal policy. Contract arguments are generated from the deployed spec. WRITE tools additionally require `idempotency_key` (1–128 ASCII letters, digits, hyphens, or underscores). Functions with a conflicting parameter name are excluded from MCP exposure.
- `GET /healthz`: process health. `GET /readyz`: database schema, network passphrase, and required signer readiness.
- Operator CLI: `inspect <wasm>`, `register <contractId> [matching-wasm]`, `credential <principal> <new-token-file>`, `revoke <token-file>`, `migrate`.
- Authenticated CLI: `list <contractId>`, `call <contractId> <tool> <arguments-json-file> [idempotency-key]`, `status <idempotency-key>`. Arguments are read from a file to avoid shell quoting and accidental secret interpolation. JSON envelopes go to stdout; sanitized operational events go to stderr.

WASM uploads are inspection-only until matched to a deployed contract. Built-in Stellar Asset Contracts have no deployed WASM and are outside this release. Unsupported functions are reported with exclusion reasons. Re-register after a WASM upgrade; invocation rejects stale cached code.

## Writes and recovery

To enable the curated demo write, configure `WRITE_MODE=true`, a testnet environment signer, `MAX_FEE` in stroops, and a WRITE policy for the authenticated principal. Mandatory final enforcement simulation is the v1 dry-run policy. The environment signer owns the source account; unavailable authorizers and custom contract-account signing are rejected. Mainnet writes are rejected.

The service uses SDK assembled transactions and authorization signing, final enforcement simulation, a 20% resource-fee buffer, a 60-second simulation age bound, and a total fee cap. It never automatically restores expired state or submits an extra restoration transaction.

Every write reserves a source account under a PostgreSQL advisory lock and a durable unique constraint. The request fingerprint and final transaction hash are persisted before one submission attempt. Retries with the same key reconcile the existing hash; different arguments with that key are rejected. An uncertain attempt keeps its account reserved across restarts. Polling defaults to 120 seconds with bounded exponential backoff; `NOT_FOUND` is pending. Confirmation timeout is not proof of chain failure. Use `status` to reconcile it later, even with writes disabled.

A crash after durable intent but before submission can leave an attempt that was never broadcast. It is deliberately not resent. There is no automatic account-reservation release for unresolved hashes; use another dedicated source account while investigating. Never manually delete an unresolved reservation to retry a potentially submitted operation. A crash before intent permits abandoning preparation under the account lock, but never reuses the old idempotency key for a fresh attempt.

If on-chain execution succeeds but its result cannot be decoded, the response retains `SUBMITTED_AND_CONFIRMED`, the hash, and a decoding error. Do not repeat that action. Confirmed failures use `FAILED_ON_CHAIN`; polling deadlines use `TIMEOUT` and `TRANSACTION_PENDING_TIMEOUT`.

Credentials are hashed at rest. Logs omit arguments, secrets, signatures, raw XDR, RPC exceptions, and stacks. Requests are limited to 2 MiB and 60 requests per principal/contract per minute, shared through PostgreSQL. The HTTP server binds to loopback by default; place it behind a TLS reverse proxy for remote use. Protect operator filesystem/database access separately from agent credentials.

## Tests and reproducible testnet demo

```sh
rustup target add wasm32v1-none
pnpm contract:build
TEST_DATABASE_URL=postgres://orloj:local-development-only@127.0.0.1:55432/orloj_stellar pnpm test
pnpm typecheck
pnpm build
pnpm demo:setup
pnpm demo:deploy
pnpm demo
```

`demo:setup` creates a dedicated testnet key in ignored, mode-0600 `.env.demo` and funds it through Friendbot. Set `DATABASE_URL` before setup to override the local Compose database. It uses a demo-only 2,000,000-stroop cap. Deployment signs only a testnet fixture contract. Each `demo` run explicitly requests one new counter write, then verifies duplicate-key reconciliation and the single increment through an actual MCP client.

`demo-contract/deployment.json` records the deployed ID/hash. `evidence.json` records successful live checks. `fallback.cast` is the recorded terminal output from that same execution; replay using an asciinema-compatible player. Testnet resets can invalidate the recorded deployment, so rebuild/redeploy for a new live demonstration. Recorded output remains labeled historical evidence.

Unit tests run offline. PostgreSQL tests require `TEST_DATABASE_URL` and otherwise report skips; CI supplies a disposable PostgreSQL database and compiles the real contract fixture. CI does not require or expose testnet signing credentials. Live testnet verification is separate from deterministic CI.

## Additional stable service errors

Alongside the master specification's codes, service infrastructure uses `STALE_INTERFACE`, `UNAUTHORIZED`, `RATE_LIMITED`, and `INTERNAL_ERROR`. All responses carry sanitized public messages. Authentication errors return HTTP 401, principal-hidden interfaces return 404, origin violations return 403, and rate limits return 429. Contract execution errors use the MCP `isError` result and structured error envelope.
