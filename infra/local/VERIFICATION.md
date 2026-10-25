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
| App validation | Typecheck, production build, selection reconstruction test passed; lint has zero errors and nine existing warnings |
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
