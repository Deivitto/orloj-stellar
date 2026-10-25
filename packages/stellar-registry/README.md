# Orloj Stellar registry

A separate TypeScript service for Soroban WASM and built-in Stellar asset contracts. It exposes strict MCP tools, simulates reads, and supports explicitly allowed testnet writes. The existing EVM registry remains separate. The app has a Stellar-first local product mode. See the repository's master specification v1.5 and the [full local product runbook](../../infra/local/README.md) for app login, wallets, managed limits, runtime isolation, backup and recovery.

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

WASM uploads are inspection-only until matched to a deployed contract. Built-in Stellar Asset Contracts use a verified protocol-specific specification and have no WASM hash. Unsupported functions are reported with exclusion reasons. Re-register after a WASM upgrade; invocation rejects stale cached code.

## Writes and recovery

To enable the curated demo write, configure `WRITE_MODE=true`, a testnet environment signer, `MAX_FEE` in stroops, and a WRITE policy for the authenticated principal. Mandatory final enforcement simulation is the v1 dry-run policy. The environment signer owns the source account; unavailable authorizers and custom contract-account signing are rejected. Mainnet writes are rejected.

The service uses SDK assembled transactions and authorization signing, final enforcement simulation, a 20% resource-fee buffer, a 60-second simulation age bound, and a total fee cap. It never automatically restores expired state or submits an extra restoration transaction.

Every write reserves a source account under a PostgreSQL advisory lock and a durable unique constraint. The request fingerprint and final transaction hash are persisted before one submission attempt. Retries with the same key reconcile the existing hash; different arguments with that key are rejected. An uncertain attempt keeps its account reserved across restarts. Polling defaults to 120 seconds with bounded exponential backoff; `NOT_FOUND` is pending. Confirmation timeout is not proof of chain failure. Use `status` to reconcile it later, even with writes disabled.

A crash after durable intent but before submission can leave an attempt that was never broadcast. It is deliberately not resent. There is no automatic account-reservation release for unresolved hashes; use another dedicated source account while investigating. Never manually delete an unresolved reservation to retry a potentially submitted operation. A crash before intent permits abandoning preparation under the account lock, but never reuses the old idempotency key for a fresh attempt.

If on-chain execution succeeds but its result cannot be decoded, the response retains `SUBMITTED_AND_CONFIRMED`, the hash, and a decoding error. Do not repeat that action. Confirmed failures use `FAILED_ON_CHAIN`; polling deadlines use `TIMEOUT` and `TRANSACTION_PENDING_TIMEOUT`.

Credentials are hashed at rest. Logs omit arguments, secrets, signatures, raw XDR, RPC exceptions, and stacks. Requests are limited to 1 MiB and 60 requests per principal/contract per minute, shared through PostgreSQL. The HTTP server binds to loopback by default; place it behind a TLS reverse proxy for remote use. Protect operator filesystem/database access separately from agent credentials.

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

## Test with your Freighter wallet

Use the installed browser wallet without exporting its private key or recovery phrase:

```sh
cd packages/stellar-registry
pnpm build
pnpm wallet:read YOUR_PUBLIC_G_ADDRESS
pnpm wallet:test YOUR_PUBLIC_G_ADDRESS
```

The read command verifies the public account balance, MCP discovery, address conversion, and the authorization guard. The interactive command opens a local operator harness at `http://127.0.0.1:3003`. Open it in Brave/Chrome with Freighter installed, connect the expected wallet on Testnet, and click **Run counter test**. Approve the signing request within 45 seconds. This makes exactly one counter increment through an authenticated MCP client, verifies the confirmed transaction's source account, and repeats the idempotency key to verify reconciliation without another signature. It does not transfer USDC or XLM; the counter write consumes a testnet transaction fee.

These commands use `DATABASE_URL` from the environment, falling back to the existing `.env.demo` database configuration, and the deployed fixture in `demo-contract/deployment.json`. Run the earlier demo setup/deployment commands first for a fresh installation. The private signing key stays inside Freighter. The public address may belong to a different account from the server-side demo key.

The browser SDK is pinned and served locally from the installed package. Signing requests and responses stay in a separate operator-only channel, outside MCP tool arguments/results. The harness enforces loopback binding, exact Host/Origin checks, a same-site HttpOnly session cookie, a custom request header, CSP, and a single test run per process. The signer verifies that the wallet returned the exact requested transaction and a valid signature from the configured address. It rejects changed payloads, wrong signers/networks, declined requests, and expired jobs. SDK-generated authorization preimages use the same internal callback channel.

Keep this operator harness on loopback. It injects `BrowserSigner` into the existing executor; the normal service CLI retains its environment-signer setup. Each explicit process restart can start a new test, subject to the durable account reservation rules. Use Ctrl+C to close the local harness and revoke its temporary MCP credential.

Evidence is written to `demo-contract/wallet-read-evidence.json` and `demo-contract/freighter-evidence.json`, containing public account/transaction data only. Built-in USDC contract support remains a separate adapter task; this wallet test uses the WASM counter contract.

## Complete interfaces and assets (v1.2)

Run `pnpm cli migrate` before starting this release. Migration 003 adds source kind and interface identity, backfills existing WASM records, and preserves write attempts and hashes. Re-register contracts to regenerate expanded schemas and the complete inventory. Existing WASM responses retain `wasm_hash`; all new responses include `source_kind` and `interface_hash`. Asset responses omit `wasm_hash`.

```sh
pnpm cli register-asset native
pnpm cli register-asset USDC GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
pnpm cli inventory YOUR_CONTRACT_ID
pnpm cli amount parse 1.0000001 7
```

Registration verifies the executable and never deploys or signs. A contract ID works for both WASM and assets. Asset descriptors derive IDs using the configured network; they do not prove deployment until RPC verification succeeds. The initial SAC adapter verifies protocol **29** only. Other protocols return `UNSUPPORTED_PROTOCOL`; upgrades require a verified adapter and re-registration. Provenance and the upstream license are in `fixtures/`.

MCP `resources/list` exposes `orloj://contracts/<contractId>/interface`; `resources/read` returns all public signatures, eligibility, native-asset restrictions, exclusion reasons and the caller's current tool availability. `tools/list` exposes policy-enabled methods only. All 17 public asset methods are represented, including `trust`, allowance operations and administrative methods. Initialization belongs to deployment and is excluded. Native XLM cannot mint, burn, claw back, change administrators or create asset trustlines. Issued assets require actual admin authority; balances, trustlines, authorization and clawback flags still govern calls. Currently, the signer supports one G account per executor; arbitrary multisignature or contract-account authorization is not implemented.

SAC parameter names follow the pinned host interface: `balance` takes `addr`, `transfer` takes `from`, `to_mux`, `amount`, and `approve` takes `from`, `spender`, `amount`, `live_until_ledger`. Use discovery for exact names. `Address` accepts G/C; protocol-29 `MuxedAddress` also accepts M. Future W addresses remain disabled until the protocol adapter is verified. Stable asset error codes explain balance, authorization, missing trustline, allowance, reserve and unsupported-operation failures without exposing RPC diagnostics.

Amounts are i128 decimal strings in **base units**. Verified SAC decimals are 7, so 1 USDC is `"10000000"`. `parseAmount`/`formatAmount` in `src/assets.ts` and the `amount` CLI convert exactly without rounding. Resolve asset identity by network and contract/issuer, not symbol alone. The AI client translates plain text into these discovered tools; Orloj does not add an AI chat model.

The expanded grammar supports bounded vectors, typed maps as pair arrays, fixed tuples, enums as case-name strings, unions as strict `{tag,values}` objects and nested nonrecursive structs. Options use null for None; nested options and Option<void> remain excluded. u64/i64/u128/i128 retain decimal strings. Limits: type depth 8, 100 items per collection, 1,000 aggregate value nodes and 1 MiB arguments/results. A function with any unsupported type is excluded in full. Recursive definitions, ambiguous options and nested/input Result annotations remain excluded. Declared Val uses explicit tagged JSON; Result returns and u256/i256 are supported as described below. Map keys are encoded and canonically sorted by the SDK; duplicate encoded keys are rejected.

### Reproducible asset checks

```sh
pnpm build
pnpm assets:read YOUR_PUBLIC_G_ADDRESS
pnpm assets:test
pnpm wallet:test YOUR_PUBLIC_G_ADDRESS PROJECT_TEST_RECIPIENT_G_ADDRESS
```

The read script checks live XLM and Circle USDC through authenticated MCP. The write script creates isolated Friendbot-funded accounts and a disposable ORLOJTEST asset, then exercises all 17 public methods, expected authorization failures and duplicate reconciliation. Its keys exist only inside the test process. Setup uses classic operations separately; registry registration never submits them. Freighter's optional recipient argument selects a single **one-stroop testnet XLM transfer**, while omitting it retains the counter test. The local page displays the recipient and amount before running.

Public evidence is saved in `demo-contract/assets-read-evidence.json`, `assets-write-evidence.json`, and `freighter-asset-evidence.json`. The Freighter asset test confirmed transaction `9eceeeeac7a61007427ebadbb199ab09d3cddabf4958df32d94a11669f4e3bdc` at ledger 5382311 with one signature; its duplicate returned the same hash. Tests do not enable production write policies or mainnet writes.


## Audit remediation and classic Stellar

WASM schema identity now uses encoding v5. Re-register existing WASM contracts before invoking them with this build; old write attempts remain reconcilable with their original schemas and hashes. New eligible functions do not acquire policies automatically.

Top-level declared `Result<T,E>` returns produce `{ "tag": "Ok", "values": [value] }` on successful execution. Declared contract failures use `CONTRACT_EXECUTION_FAILED` and sanitized numeric/name metadata. Result inputs/nested Results and ambiguous options remain excluded. u256/i256 use exact canonical decimal strings. Inventory exclusions now retain the declared signature and failing type location.

`CPU_INSTRUCTION_LEEWAY` defaults to 1,000,000 instructions and accepts integers from 0 through 10,000,000. It is passed to the final enforced SDK simulation. It changes resource declarations and their fee estimate; `MAX_FEE` remains the hard cap. The separate 20% resource-fee buffer does not add CPU instructions. A rejected fee estimate never authorizes increasing a wallet grant.

Register classic adapters with `register classic:stellar-dex` or `register classic:stellar-amm`, or use the app's registration buttons. These identifiers are explicit adapter IDs, not Soroban addresses. Their MCP routes are `/contracts/classic:stellar-dex/mcp` and `/contracts/classic:stellar-amm/mcp`, preserving the registry's shared routing/policy convention. They have `source_kind` classic_dex/classic_amm and no WASM hash. Run migration 007 before starting the upgraded service.

Classic tools cover account balances, offers, order books, constant-product pool reads, asset/pool trustlines, sell-offer creation/update/cancellation, pool deposits and withdrawals. Assets use `native` or `CODE:ISSUER`; amounts use base-unit decimal strings (seven decimals), and prices use exact `{n,d}` rational objects. READ_ONLY means a Horizon query, not Soroban simulation. Writes perform ledger/account/reserve/authorization preflight, use the shared durable lock/intent/single-submission/getTransaction pipeline, and require owner Freighter approval in product mode. Managed wallets cannot execute classic writes. Network state can still change after preflight, so confirmed failure remains a possible terminal result.

Manual acceptance commands (no scheduled or push-triggered checks):

```sh
TEST_DATABASE_URL=postgres://... pnpm --filter @orloj/stellar-registry test
node --test packages/app/test/stellar-mcp-selection.test.mjs
DATABASE_URL=postgres://... node packages/stellar-registry/scripts/test-classic-testnet.mjs
```

The last command creates disposable Friendbot-funded wallets and a project fixture asset; it does not use a Freighter key. Public audit evidence is in `demo-contract/top10-audit/`. User-wallet signing payloads remain confined to the owner signing channel. Browser owner acceptance is separately recorded in `classic-app-results.json`.

### Managed exact-call grants and declared Val

The owner can enable a managed Testnet wallet for an exact invocation from the wallet/tool screen. The grant binds `interfaceHash` and normalized `arguments`, with `maxCalls` (1–100 calls per rolling day), `maxFee` (at most 3,000,000,000 stroops = 300 test XLM), and `rollingFee` (at most 10,000,000,000 stroops = 1,000 test XLM). Defaults allow one call. Writes remain disabled until explicitly configured. Classic adapters still require Freighter.

An exact grant authorizes the complete invocation, including its asset effects. It does not infer spending amounts from arbitrary arguments. Existing SAC transfer grants continue to enforce recipients and exact amount budgets. Call quotas span policy revisions for each wallet/contract/method, unresolved reservations count regardless of age, and all managed calls share the rolling fee exposure. Credential, owner, wallet, code identity and policy checks still apply before durable intent. No automatic resubmission is added. Upgrades require re-registration and an owner-issued grant for the new interface hash.

Declared `Val` uses `{ "type": "i128", "value": "123" }`, `{ "type": "address", "value": "G..." }`, `{ "type": "vec", "value": [...] }` or `{ "type": "map", "value": [[key,value],...] }`. Other tags mirror supported ScVal leaves: bool, u32, i32, u64, i64, u128, u256, i256, string, symbol, bytes, void, timepoint, duration and error. Void carries null. Error carries `{kind:"sceContract",code:7}` or an SDK error category and code. Values retain exact existing integer/address encodings; nothing guesses a type from its contents. Eight value containers, 100 items/collection, 1,000 aggregate nodes and 1 MiB payload limits apply. Option<Val> is excluded because Void makes its encoding ambiguous. Internal ledger-key/contract-instance values are excluded. Direct declared error enums encode their real contract error codes and expose declared case names.

Manual live acceptance (requires an existing local PostgreSQL test database; consumes free Testnet assets only):

```sh
pnpm --filter @orloj/stellar-registry build
TEST_DATABASE_URL=postgres://localhost/orloj_stellar node packages/stellar-registry/scripts/test-managed-calls.mjs
```

This creates an isolated schema and managed administrator/holder/delegate wallets, then exercises real MCP asset methods and confirms each submitted hash. The isolated signer master key is ephemeral: these test wallets are disposable, cannot be recovered after the script exits, and are separate from product wallets. History is retained in the test schema for inspection. It neither configures existing user grants nor claims browser-chat acceptance. The mainnet `test-tagged-mainnet.mjs` probe requires a private read-only mainnet env file and performs no submissions.
