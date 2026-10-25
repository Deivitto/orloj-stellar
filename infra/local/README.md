# Local Stellar testnet product

This stack runs the Orloj app, Stellar registry and worker, PostgreSQL, Mailpit,
an isolated managed signer, and a pinned ZeroClaw runtime broker. It does not
enable mainnet writes. Existing EVM configuration is separate.

## Start

Prerequisites: a running Docker engine, either the Docker Compose plugin or standalone docker-compose, Node 24.15.0, and the repository-pinned pnpm. The local-stack launcher detects both Compose forms and reports an unavailable engine before attempting startup.
Hardware virtualization is recommended. Software-emulated Colima works on this
development machine but builds are substantially slower.

From the repository root:

```sh
node scripts/setup-local-product.mjs
node scripts/local-stack.mjs build runtime-image broker registry signer app
node scripts/local-stack.mjs up -d
```

For a parallel smoke stack, set `APP_PORT`, `REGISTRY_PORT` and `MAIL_PORT` to
unused local ports; origins and public MCP URLs follow those overrides.

The setup command preserves existing secrets. Review `.local/product.env`
privately. `SIMULATION_SOURCE` must be a funded public Testnet G account. The
default is this project's test wallet; replace it for an independent installation.
Do not commit `.local`, private environment files, database dumps, or wallet keys.

Open <http://localhost:3000/en>. Enter your email and follow the actual magic link
in Mailpit at <http://localhost:8025>. No authentication bypass is installed.
Create an agent, register XLM, USDC, or a deployed contract, and explicitly choose
its READ/WRITE policies. Registration never deploys a contract or grants writes.
Run `node scripts/check-local-product.mjs` in the app environment to check the
origin, control credential, mailbox, migrations, RPC protocol and signer health.
Set `REQUIRE_CHAT=true` to require model and broker configuration too.

Copy the MCP configuration into an MCP client to discover and call the enabled
tools. Registry readiness is <http://localhost:3002/readyz>.

The optional in-app chat needs a compatible model endpoint and private provider
key in `ZEROCLAW_MODEL_API_KEY`, with `ZEROCLAW_MODEL_URL` and `ZEROCLAW_MODEL`.
The default provider remains 0G. Restart the app after changing configuration.
Live Groq/ZeroClaw browser reads, a one-stroop chat-requested transfer and
read-only recovery have been verified; see the latest [verification notes](VERIFICATION.md).
MCP execution itself does not need a model key. Free-provider quotas still apply;
there is no mocked chat acceptance.

## Wallets and amounts

Freighter stays in the browser. Select Testnet, connect, and sign the expiring
ownership challenge. MCP writes return an operation ID. Review the exact contract,
method, arguments, recipient, base-unit amount, network and maximum fee in the
owner screen before approving. Only that screen receives signing payloads.

A managed wallet is a different Ed25519 account per agent instance. The signer
creates and encrypts it; the app and runtime receive only the public address.
The Fund button uses Testnet Friendbot. Managed unattended writes default to
disabled. Verified SAC `transfer` supports recipient, per-transfer, rolling amount
and fee budgets. Other Soroban calls require an owner grant for the exact
contract, interface hash, method and arguments, with call quotas and fee budgets.
Switching wallets suspends those limits until the owner authorizes them again.

Amounts are decimal strings in base units: XLM and USDC have seven decimals, so
`"1"` is 0.0000001 units. Use the registry's exact `amount parse`/`amount format`
CLI helpers or metadata; do not use floating point.

## Status and recovery

Poll `orloj_operation_status` with the operation ID. If that tool name collides
with a declared contract tool, discovery supplies a deterministic numeric suffix.
Reuse the same idempotency key for a duplicate request. A submitted transaction
is never automatically resubmitted; `sendTransaction` acceptance is not success.
Confirmed success requires `getTransaction` SUCCESS.

An approval interrupted before durable intent requires a new explicit request.
After intent, cancellation/revocation cannot guarantee that broadcasting stopped.
The worker retains the hash and spending reservation and reconciles the result.
Use the owner screen, or run the operator command in the registry container:

```sh
node scripts/local-stack.mjs exec registry node dist/src/cli.js recover-operation OPERATION_UUID
node scripts/local-stack.mjs exec registry node dist/src/cli.js recover-operation OPERATION_UUID --prove-expired
```

The second command releases an unresolved reservation only with authoritative
ledger expiry proof and source sequence checks under the original account lock.
Legacy attempts missing expiry/sequence metadata remain reserved. Do not delete
their rows to bypass the limit. Confirmed failures settle actual fees and release
the outgoing amount; unresolved reservations count even after 24 hours.

## Backup, restore, and master-key rotation

Stop the app and registry worker before a consistent backup. Back up PostgreSQL,
the `orloj-agent-state` volume, and `.local/secrets` to separate encrypted storage.
The master key is required to recover managed wallets; a database backup alone
cannot recover them. Do not replace an inaccessible master key with a new one.

```sh
node scripts/local-stack.mjs stop app registry signer
node scripts/local-stack.mjs exec -T postgres pg_dump -U orloj -d orloj -Fc > .local/database.dump
```

Restore to a stopped stack using `pg_restore`, restore the matching agent volume
and original secret files with restrictive permissions, then start the signer,
registry and app. Check readiness and reconcile unresolved operations before
enabling new writes. Database migrations preserve write history. Legacy MCP credentials with no
recorded owner or instance are bound to the current owner during migration. If
ownership changed before that history existed, rotate those legacy tokens; the
old schema cannot prove their original owner.

Master-key rotation is an offline signer operation. Stop app, worker and signer;
back up the database and old master key together. Generate a new random 32-byte
base64 key in a mode-0600 file inside the isolated signer environment. Using the
old `SIGNER_MASTER_KEY_FILE`, run:

```sh
node dist/src/managed-signer.js rekey /private/new-master
```

This transaction re-encrypts every managed key with fresh nonces, increments the
authenticated key version, and updates the database epoch. After success,
atomically replace the signer's master secret with the new file. Validate with
`node dist/src/managed-signer.js check-key /run/secrets/master` before restarting.
Do not run old and new signer processes concurrently. A signer with the old epoch
fails closed. If replacing the file fails after rekey, retain the new key and
complete replacement; do not restore only one half of the database/key pair.

## Isolation and compatibility

File-backed Compose secrets retain host ownership. Each service copies only its
granted secret files to a private runtime directory and drops to UID 1000 before
starting. The app has no master-key mount. Agent containers mount only their own directory,
run without root or Linux capabilities on a read-only root filesystem, and have
no application database, wallet storage, signer service or Docker socket mounts.
Only the trusted broker has Docker access. Do not expose it publicly. The pinned
runtime uses supervised mode with exact selected MCP tool permissions; host
shell/file tools and skill bundles are disabled for Stellar sessions.

Direct MCP supports the verified closed type grammar and protocol fixture in the
master specification. Unknown protocols, external-code changes and unsupported
signatures fail closed. ZeroClaw reserves the argument name `approved`, so tools
with that parameter are visibly excluded from its compatibility endpoint; direct
MCP clients can use them. Mainnet writes, classic Stellar operations, arbitrary
unattended contracts, KMS/HSM and hosted deployment are outside this release.

Live evidence is in `packages/stellar-registry/demo-contract/local-product-*-evidence.json`.
It records real app-token MCP discovery, policy denials, confirmed Freighter and
managed transfers, recipient balance changes and duplicate reconciliation without
additional submission. It contains no bearer tokens or signing payloads.

## No hosted CI/CD

GitHub Actions is disabled for this private repository. The former workflow is archived at `infra/local/stellar-ci.disabled.yml`, outside `.github/workflows`, so pushes, pull requests and manual dispatch cannot start it. Validation commands in this runbook run locally and consume no GitHub Actions minutes. Re-enabling hosted workflows is an explicit owner action, not part of startup.

## Manual local validation

Run `node --test scripts/local-stack.test.mjs` for launcher detection checks. Run `TEST_DATABASE_URL=postgres://... node --test packages/app/test/*.test.mts packages/app/test/*.test.mjs` for all app credential/selection/readiness checks. Registry checks use `TEST_DATABASE_URL=postgres://... pnpm --filter @orloj/stellar-registry test`. These are operator-invoked local commands, not hosted workflows.

Managed exact-call permissions extend the original SAC transfer budgets. They bind an invocation to its interface hash and exact normalized arguments, with call quotas and fee reservations. See [the registry guide](../../packages/stellar-registry/README.md#managed-exact-call-grants-and-declared-val). Mainnet stays read-only and Classic writes still require Freighter. Re-register WASM contracts when upgrading to encoding v5. Run migration 008 before starting the updated app/registry/signer; keep the database and original signer master key backed up together.

## Native app with an isolated Docker runtime

A native app can use the same pinned container runtime through the native broker. Set `ZEROCLAW_AGENTS_DIR` to a short, private, persistent directory (for example `$HOME/.orloj/agents`), and set the broker's `AGENT_BIND_ROOT` to that exact canonical path. Each agent directory must be at most 70 bytes long, including its UUID: longer paths exceed the runtime's Unix socket limit. Move existing agent directories while the app is stopped; preserve their owner stamps and selection sidecars. This does not move or replace managed wallet storage.

The native broker binds only the requested agent directory at the identical path, checks its instance stamp, rejects symlink escapes and runs with that directory's nonroot UID/GID. It never mounts the checkout, root of all agents, signer secrets or Docker socket into the runtime. Bind the native broker to loopback with `HOST=127.0.0.1`; retain its private runtime credential. Container stacks continue using per-agent named-volume subpaths by default.

Set `STELLAR_RUNTIME_REGISTRY_URL` when containers need a different route from the app's control channel. On this Colima host, `http://host.lima.internal:3002` reaches the native loopback registry. `STELLAR_REGISTRY_URL` and public/browser URLs retain their separate meanings; EVM URLs are unchanged. Check reachability from the runtime network before startup.


For a model that supports OpenAI native tool schemas, set `ZEROCLAW_NATIVE_TOOLS=true`; use `false` only for a provider/model requiring text fallback, or leave it empty to retain the runtime's default. This is a wire-format setting, not a grant: the exact MCP allowlist and blocked built-in tools remain in force. The pinned runtime documents this override in its [custom provider reference](https://docs.zeroclaw.com/v0.8.6/en/providers/custom.html). Groq's gpt-oss-20b accepts native tool schemas; text-fallback requests without tool definitions can be rejected with `tool_use_failed`.

For Groq, also set `ZEROCLAW_REPLAY_REASONING=false`: its assistant-history schema rejects `reasoning_content`. The custom runtime provider otherwise replays that field after a successful tool call, causing the final-answer request to fail. The setting changes only provider history formatting and leaves the exact tool allowlist and signing policies intact.

Example native broker startup, from the checkout root (private app configuration must use the same agents directory):

```sh
AGENT_BIND_ROOT="$HOME/.orloj/agents" AGENT_NETWORK=bridge \
  AGENT_VOLUME=orloj-native-runtime HOST=127.0.0.1 \
  RUNTIME_TOKEN_FILE="$PWD/.local/secrets/runtime" \
  node infra/local/runtime-broker.mjs
```

The free Groq account used in live acceptance has an 8,000 token/minute limit. Longer tool conversations can reach HTTP 429 even when a request is smaller than the model's context window. The current private test-agent configuration uses `[reliability] provider_backoff_ms = 10000` and `provider_retries = 4` to give bounded provider retries time to wait. Keep operator settings above the app-managed marker; the app preserves them. These settings concern model HTTP calls, never Stellar submission retries. Free-provider quotas can still delay or reject chat; the UI reports that explicitly. No additional keys, account rotation or paid upgrade is required by this configuration.

Stellar chat now selects a dedicated bounded runtime profile instead of the inherited unbounded template. It retains eight complete history turns, uses compact bootstrap, limits output to 2048 tokens, and starts pruning at an estimated 4000 context tokens (`ZEROCLAW_CONTEXT_TOKENS`, range 1000..128000). Tool/result groups for the active turn are not replayed by the app. Large MCP schemas or provider quotas can still exceed external limits; select fewer MCPs or restart chat context. Restart context preserves the visible transcript and MCP selection with a context-reset divider and never repeats a prompt. Reset clears the conversation after confirmation and can recreate a dead runtime through normal owner/credential checks.

Provider errors distinguish request size from temporary quota when fresh runtime diagnostics are available; only a bounded tail is inspected and no raw body is returned. New or changed durable operations append registry-sourced receipts even when the model final answer fails. The owner panel and MCP operation status show exact `fee_charged` stroops plus `fee_charged_xlm`; 7228 stroops is 0.0007228 XLM. These values do not depend on model arithmetic. Do not infer transaction failure from a chat error: inspect operation status before requesting another write.
