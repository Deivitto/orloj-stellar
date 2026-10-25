# Local product verification — 2026-10-25

## Chat recovery fixes — 25 October 2026

Stellar chat now replaces the inherited 128000-token unbounded runtime profile with a dedicated compact profile: estimated context budget 4000, eight complete history turns, output cap 2048. The pinned 0.8.6 runtime accepted the actual leaf-level patch. `ZEROCLAW_CONTEXT_TOKENS` is operator-configurable; provider quotas and very large active prompts/tool schemas still impose external limits.

Provider errors are categorized from a bounded fresh diagnostic tail without returning raw bodies. The UI warns that transactions may already be pending/confirmed and offers **Restart chat context**. Restart preserves the visible transcript and MCP selections, displays a reset divider, and never replays a request. Reset also supports a dead child through normal ownership/credential checks; unit coverage checks warm reset, respawn and revoked-owner failure.

Exact registry operation fees now include `fee_charged_xlm` without modifying stored history. The owner panel renders 7228 stroops as 0.0007228 XLM. Changed operations append deterministic, labeled registry receipts to chat, including on provider failure; rendering permits only fixed validated fields. Error-ending messages are persisted, and reset clears the old UI error.

Manual browser fault injection stopped the real isolated runtime, produced the safe interruption warning and recovery button, and retained the previously confirmed operation. No write grant was enabled and no additional payment was requested. Final recovery evidence is recorded in `packages/stellar-registry/demo-contract/top10-audit/chat-recovery-fix-evidence.json`.

153 registry tests passed. Nine app checks and six mount/launcher checks passed, along with app/registry production builds, typechecks and Compose validation. Lint has zero errors and nine existing warnings; the existing unrelated branding build trace warning remains. Hosted CI remains disabled.


## Latest: browser read chat verified

A real authenticated browser conversation used the configured Groq gpt-oss-20b provider, the pinned isolated Docker agent runtime, and the app-authenticated MCP endpoints. Soroban XLM balance and classic DEX account_balances both returned 99999993056 base units = 9999.9993056 XLM, matching a separate Horizon account lookup. No write operation was created; existing history remained four successes and one rejection, and unattended grants stayed disabled. Screenshots and the detailed JSON evidence live in `packages/stellar-registry/demo-contract/browser-chat-*`.

Testing fixed native-app mount/path wiring, the runtime IPC path length, custom-provider native tools, unsupported Groq reasoning replay, and a stale classic adapter cache. The temporary provider diagnostic relay was stopped; acceptance uses direct HTTPS to Groq. The free account has an 8,000-token/minute limit; repeated long turns produced a correctly surfaced HTTP 429. The current private test-agent retry settings are bounded (four retries, 10-second base backoff). Free quotas still apply.

Local checks: 152 registry tests, 12 app/runtime/launcher tests, both builds and TypeScript checks pass; lint has zero errors and nine existing warnings. Compose configuration validates. The live setup is a native app plus isolated Docker runtime, not a claim that the complete Compose stack was started. Chat-triggered writes were not retested in this followup, and independent re-review remains pending workspace credits. Older blocker notes below are historical.


Independent verifier: `verify_port_goals` (read-only review). Its concrete findings
were treated as acceptance fixes, including identity epochs, ambiguous submission
retention, expiry proof, worker bounds, runtime isolation and atomic recovery.

| Gate | Evidence |
| --- | --- |
| Real local magic-link login, agent creation, registration and policy configuration | Completed in Brave against localhost:3000; emails delivered to Mailpit |
| Freighter ownership and owner-approved MCP write | `local-product-freighter-evidence.json`: ledger 5383439, confirmed hash, recipient +1 stroop, duplicate same operation/hash |
| Managed wallet creation, funding and unattended MCP write | `local-product-managed-evidence.json`: ledger 5383545, wrong recipient/excess amount denied, recipient +1 stroop, duplicate same operation/hash |
| Managed grant approved by owner | Own Freighter recipient only; 1000 stroops/transfer, 10000 rolling outgoing stroops, 10000000 rolling fee stroops |
| Backend regression and PostgreSQL integration | 108 tests passed across 10 files, with `TEST_DATABASE_URL` configured |
| Existing marketplace regression | 95 tests passed |
| App validation | Typecheck, production build, credential rotation/ownership and selection reconstruction tests passed; lint has zero errors and nine existing warnings |
| Actual pinned runtime lifecycle/isolation | `local-product-runtime-evidence.json`; real Docker patch/ACP/disconnect/restart, nonroot, read-only, capability removal, per-agent volume, no app/signer secret environment |
| Service secret permissions | Real Node container copied a host-owned mode-0600 file into its granted private directory, dropped to UID 1000 and read it successfully without printing its value |
| Readiness and migrations | Native app/auth migrations and registry migration 006 passed; readiness checks RPC network/protocol and signer epoch health |
| Secret scan | Changed/untracked text checked for Stellar secret seeds, private-key blocks and literal live MCP tokens: none found |
| Live natural-language chat | Deferred explicitly by the user; no model prompt or mocked acceptance |

The runtime smoke uses no model prompt. The Freighter and managed evidence use the
app's actual agent bearer credential internally; that credential and all signing
payloads are omitted from evidence. Earlier `assets-*` evidence covers the complete
verified protocol-29 SAC inventory with a separate project-controlled asset.

Full Compose image build/start verification is a separate gate from the passing
native app and isolated runtime tests. The current Mac has no usable hardware
virtualization; the build is running under software-emulated Colima/QEMU. Do not
interpret source inspection or `compose config` as proof that every service has
started together. Hosted CI must also be reported separately; earlier runs were
rejected before jobs started because of the repository account's billing limit.

Hosted CI attempted on review commit `07dfd17`: run `40207645870` was rejected
before starting the verification job: recent account payments failed or the
spending limit must be increased. This is an account billing blocker, not a
reported test failure.

Final verifier review found no remaining source-level blocker after correcting
signer migration configuration and avoiding runtime Corepack activation. Actual
CLI migration was also tested with the signer environment, without a simulation
account. The combined Compose startup gate remains separate.


## Audit remediation (25 October 2026)

Master v1.4 / migration 007 add CPU headroom, declared Result returns, u256/i256, WASM encoding-v4 refresh and separate classic adapters. Current coverage and real hashes are in `packages/stellar-registry/demo-contract/top10-audit/REPORT.md`. All ten ranked entries have representative successful mainnet reads. Blend/DeFindex testnet deposit/withdrawal, Aquarius trust/swap, and classic offers/pools confirmed. The actual owner Freighter offer creation/cancellation passed in the browser. Managed custody is active again; unattended grants remain disabled until explicitly reauthorized.

Integrated browser chat remains blocked: no isolated runtime broker is running on port 3010. New readiness checks fail before agent configuration is provisioned/replaced and return HTTP 503; the browser visibly reports chat unavailable. A separate ten-project real-provider tool harness passed, which does not substitute for browser/runtime acceptance. Full Compose startup remains unverified. Automatic GitHub checks remain disabled.


CI/CD followup: GitHub Actions permissions were set to `enabled=false` for Deivitto/orloj-stellar and verified through the GitHub API; active and queued run counts were both zero. The workflow is archived outside `.github/workflows`. All four app tests (including credential rotation) passed locally; three launcher tests cover plugin detection, standalone Compose fallback and missing Compose. Docker engine recovery is still required on this host before container/chat acceptance.

## Generic calls followup (master v1.5, migration 008)

151 registry tests and seven app/launcher tests pass locally. The app production build and TypeScript checks pass; lint has no errors and nine existing warnings. An authenticated browser login through the local mail sink loaded the updated contract inventory and the exact-call permission explanation, with unattended permission unchecked. `demo-contract/managed-permission-ui.jpg` records that screen. No new permission was saved on the existing user wallet.

Real authenticated MCP HTTP tests confirmed 15 managed asset calls with administrator/user/delegate roles, and two WASM calls (counter state change and source-wallet authorization). Three additional asset setup transactions are clearly labeled operator setup. Unauthorized transfers and wrong-authorizer calls failed without a transaction hash. Balance/allowance and duplicate operation assertions passed. Mainnet Aquarius get_info returned typed Val JSON successfully; its router has 75/75 supported schemas. See the latest section of the audit REPORT and the evidence files.

Native services use migration 008 and refreshed v5 WASM interfaces. A private pre-migration database backup was taken; previous write history remains intact. The signer accepted the original persisted master key and the existing managed wallet remained active with unattended grants disabled.

The Colima engine was restored and accepts builds. A full Compose image build was attempted again on software-emulated QEMU; complete combined startup and integrated browser chat remain unverified. Independent re-review of this followup is still unavailable because workspace credits were exhausted. Hosted Actions remains disabled.
