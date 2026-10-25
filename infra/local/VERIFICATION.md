# Local product verification — 2026-10-25

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
