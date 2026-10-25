# Orloj Stellar — latest verified status

Updated 25 October 2026. **Run the hackathon demo locally at [localhost:3000/en](http://localhost:3000/en).** The full Stellar app is not deployed on Vercel; the older `app.orloj.xyz` link below describes the original EVM project, not this fork's hosted Stellar release. No paid hosting has been provisioned.

## What has been verified

- Stellar/Soroban interfaces become typed MCP tools, with explicit method policies, strict argument/result validation and visible exclusions. Built-in XLM/issued assets and separate classic DEX/AMM adapters are supported.
- **39 unique Testnet transactions independently returned SUCCESS**, including protocol calls, fixture setup, funding and retained diagnostic probes. This is transaction evidence, not 39 independent integrations.
- Fresh Blend, DeFindex and Aquarius acceptance passed **six writes and twelve safety assertions**. Classic offer/pool state checks and managed administrator/holder/delegate permission tests also passed. Duplicate protocol requests reused the original hash without signing or submitting again.
- A real browser-chat prompt sent **one stroop (0.0000001 Testnet XLM)** and the ledger confirmed it. After a provider interruption, chat recovered the same durable operation without repeating the transfer. The temporary spending grant was removed.
- Chat now uses a bounded runtime context, explicit recovery without automatic replay, registry-sourced operation receipts and exact fee metadata. The verified example is **7228 stroops = 0.0007228 XLM**. Free model-provider quotas still apply.
- The refreshed Stellar TVL audit includes **eleven entries**. Rank eleven, **DeFa by InvoiceMate**, passed three read-only MCP calls against its deployed TVL logger; all sixteen declared signatures are supported. This does not establish lending-pool integration or privileged write access.
- **168 local checks passed:** 153 registry tests, nine app tests and six runtime mount/launcher tests. App/registry builds, typechecks and Compose configuration passed; lint has zero errors and nine existing warnings. GitHub Actions remains disabled.

See the [live transaction and project audit](packages/stellar-registry/demo-contract/top10-audit/REPORT.md), [chat recovery evidence](packages/stellar-registry/demo-contract/top10-audit/chat-recovery-fix-evidence.json), [local verification notes](infra/local/VERIFICATION.md) and [master specification](ORLOJ_STELLAR_MASTER.md).

## Zero-cost hackathon demo

On the prepared development machine, open [the local app](http://localhost:3000/en). Local magic-link email is delivered to [Mailpit](http://localhost:8025); the registry readiness endpoint is [localhost:3002/readyz](http://localhost:3002/readyz). Keep the app, PostgreSQL, registry/worker, isolated signer, Docker runtime broker and model connection running during the demo. Fresh-machine setup and service startup are documented in the [local deployment guide](infra/local/README.md); the combined container stack has not yet passed full end-to-end acceptance.

A useful demonstration is: sign in, register a Testnet contract or XLM, enable selected tools, query a balance through MCP/chat, then request a small owner-approved write and show its confirmed hash and exact fee. Managed unattended grants remain disabled until explicitly configured. Use only faucet-funded Testnet assets. Retain a recording and the checked-in evidence as a fallback for network/provider outages. Whether a public URL is mandatory depends on the hackathon's submission rules.

## Keys, privacy and hosting boundary

The private repository, `.local/` files and signing material must remain private. Freighter keys stay in Freighter. Managed wallet keys are encrypted with AES-256-GCM; the master key belongs only to the isolated signer. Wallet secrets must never be added to Git, browser bundles, MCP responses, chat, logs or agent workspaces. Provider credentials also belong in private service configuration. Database access and write permissions remain owner-authorized; registration alone grants no write authority.

For a future hosted release, Vercel can provide the public entry point while a persistent backend runs the app's session processes, registry/worker, PostgreSQL, signer and isolated runtime. The current implementation is not a drop-in Vercel Functions deployment: sessions and agent files require persistence. Publishing just the UI would not make the wallet/MCP/chat flow ready to use. A backend host, HTTPS origin, production email delivery, private configuration, backups and fresh hosted acceptance are still needed. The local backend has not been exposed publicly.

**Coverage limits:** confirmed third-party/protocol Testnet write coverage exists for five of the eleven ranked entries. Missing official deployments, project attribution and privileged roles remain explicit gaps. Mainnet stayed read-only. Support for a signature does not guarantee every call succeeds or that an account has the required privileges. Full hosted deployment and fresh independent verification remain open.

---

# Orloj Registry [app.orloj.xyz](https://app.orloj.xyz/)

**Stellar/Soroban development:** the independent [Orloj Stellar service](packages/stellar-registry/README.md) provides the registry, CLI, testnet demo, and durable write reconciliation. The original EVM application is documented below.

> *Orloj* (Czech for "astronomical clock") — a nod to Prague's iconic timepiece, built for **ETHPrague Hackathon 2026** and continued at **ETHGlobal Lisbon 2026**.

Orloj is a registry that exposes smart-contract interfaces to AI agents as **MCP (Model Context Protocol) servers**. MCPs are generated dynamically from [Sourcify](https://sourcify.dev/)-verified contract metadata, and signing is delegated to a **pluggable KMS layer** — pick **1Claw** (HSM + TEE) or **SpaceComputer Orbitport** (orbital HSM + SpaceTEE) per vault. Each registered contract is served as its own MCP endpoint by a single hot-pluggable registry process, gated by per-agent bearer tokens — agents never touch keys, RPCs, or gas.

## Highlights

- **Sourcify ABI → typed MCP server, dynamically generated.** Every function in a verified contract becomes an MCP tool with Solidity types parsed by alloy's `JsonAbi` and encoded/decoded at runtime via `DynSolValue` (tuples, dynamic + fixed-size arrays, all integer widths, `bytesN`), proxy ABIs resolved automatically via Sourcify's `proxyResolution` field. Zero per-contract integration: the moment a contract is verified on Sourcify, it is callable by an agent.
- **Hardware-rooted, pluggable KMS — keys never leave the enclave.** Each vault picks its signing backend: SpaceComputer Orbitport (orbital HSM + SpaceTEE; signing happens entirely inside the enclave on a 32-byte digest, with both `ETHEREUM` and `TRANSIT` schemes used in the same product surface for wallet signing *and* envelope-encrypted secret storage) or 1Claw (HSM + TEE intent signing). Both backends are wired into the same `signTransaction` path, so the agent surface is identical regardless of where the key lives.
- **Agents never hold a key, never see a transaction.** The registry constructs every EIP-1559 tx with viem, hashes it, asks the chosen KMS to sign the digest, reassembles `(r, s, yParity)`, and broadcasts. A compromised registry host cannot forge transactions — it can only request signatures it is already authorized to request, on a digest, against a key it does not hold.
- **Per-agent bearer tokens with grant-based authorization.** Each agent has a `mcpk_live_*` token (constant-time-checked against Postgres) and a per-vault grant carrying `permissions`, optional `secret_path_pattern`, and optional `expires_at`. The registry resolves the active grant on every MCP call and routes the signature to the matching KMS key. Revocation is a row update; keys never move.
- **Private personal agents, spawned on demand and wired straight into the Orloj MCPs.** Opening a chat spawns that user's own **ZeroClaw** process with an isolated config dir and workspace. At spawn time the agent's selected MCPs are connected to the agent. Inference runs on **0G Compute** through the 0G router using the **`qwen3.7-max`** model.
- **Immutable curated skills marketplace on 0G Storage.** The curated agent skills in [packages/skills-marketplace/](packages/skills-marketplace/) are published to **0G Storage** and addressed by their Merkle root hash, with the upload registered on 0G Chain. Orloj agents load them **dynamically**: pick a skill from the marketplace and it is fetched by root hash into that agent's workspace, teaching a running personal agent a new capability without redeploying anything.
- **Direct agent access to the Uniswap API — swap, quote, and manage liquidity.** An extra special MCP at gives the agent multichain `quote` and `swap` functionality over the **Uniswap API** on any registered chain, plus **Uniswap V3** liquidity management over the Uniswap Liquidity API.
- **Graph-powered LP manager — live subgraph data turned into liquidity decisions.** An internal `orloj-lp-manager` MCP ([packages/lp-agent/](packages/lp-agent/)) discovers the agent's own Uniswap V3 positions, queries the **Uniswap V3 subgraph on The Graph** for live pool, fee, and volume data, extracts deterministic range/activity features, and produces a strictly cited **HOLD / REDUCE_LIQUIDITY / REBALANCE** decision with a full audit trace. 

## Tracks Applied

### ETH Prague 2026

- Ethereum Core — see [`ETHEREUM-CORE.md`](ETHEREUM-CORE.md) for our integration writeup
- Network Economy — see [`NETWORK-ECONOMY.md`](NETWORK-ECONOMY.md) for our integration writeup
- [Sourcify Bounty](https://ducttapeevents.notion.site/Sourcify-2fe1a305cfe7805c87a7ce855ae2bde6) — see [`SOURCIFY.md`](SOURCIFY.md) for our integration writeup
- [SpaceComputer Bounty](https://ducttapeevents.notion.site/SpaceComputer-3101a305cfe7801ca388f3bc292f148d) — see [`SPACECOMPUTER.md`](SPACECOMPUTER.md) for our integration writeup
- Best UX Flow

### ETH Lisbon 2026

- 0G — 🚀 Keep Building on 0G — see [`0G.md`](0G.md) for our integration writeup
- Uniswap Foundation — 🤖 Best Uniswap API Integration — see [`UNISWAP.md`](UNISWAP.md) for our integration writeup
- The Graph — 🏆 Best AI Use Case of The Graph (Continuity) — see [`THE-GRAPH.md`](THE-GRAPH.md) for our integration writeup  

## The Problem It Solves

AI agents today can read about smart contracts, but can't *safely* use them. To call a contract, an agent has to:

- manage private keys,
- pick an RPC and handle network failures,
- estimate and pay gas,
- understand each contract's ABI and quirks.

Every one of those is a footgun — and a reason teams don't ship agentic on-chain workflows.

Orloj removes the entire surface. Each contract is published as an MCP server, so the agent sees only **typed, verified interfaces** it can call like any other tool. Account management, signing, and gas are abstracted away by the registry layer; the agent never holds a key and never sees a transaction. The result: agents that can act on-chain with the same ergonomics as calling a REST API.

## Why This Matters for Agents

By abstracting key management and gas handling into the MCP boundary:

- **Simplified mental model.** Agents never need context about blockchain infrastructure, private key custody, or transaction mechanics — only contract interfaces. This shrinks cognitive load and reduces reasoning errors.
- **Infrastructure-agnostic.** Key rotation, HSM policies, network selection, and gas strategies are handled outside the agent's control loop. The agent stays focused on *what to do*, not *how to pay for it*.
- **Lower model requirements.** Even less powerful models (that support tool calling) can reliably execute on-chain operations. The agent doesn't need to reason about gas prices, nonce management, or transaction finality — it just calls a tool with clear inputs/outputs.
- **Higher reliability.** By removing accounts and signing from the agent's purview, you eliminate an entire class of bugs: fund loss, key leakage, stuck transactions, failed estimates. The registry layer enforces correctness.
- **Focused reasoning.** Agents can concentrate entirely on business logic — when to call what function and with what parameters — rather than worrying about the infrastructure layer.

## How It Works

Orloj rests on two pillars:

**1. Sourcify-driven MCP generation.** We use the Sourcify verified-contracts dataset as our source of truth for ABIs. The registry fetches a contract's metadata, parses its ABI, and **dynamically builds an MCP server** where every contract function becomes an MCP tool — with typed inputs, descriptions, and structured outputs. No hand-written wrappers; the moment a contract is verified on Sourcify, it's callable by an agent.

**2. Pluggable KMS-backed vaults.** Each vault holds a wallet whose private key never leaves a hardened enclave. At creation time the user picks the KMS provider:

- **1Claw** — HSM + TEE, intent-based signing. The agent issues a 1Claw *intent* and 1Claw signs inside the TEE.
- **SpaceComputer Orbitport** — secp256k1 keys provisioned inside orbital HSMs with **SpaceTEE**, "physically isolated, tamper-proof by any administrator or state actor." The registry constructs the unsigned tx, sends only the digest to Orbitport, assembles `(r,s,v)` into a broadcast-ready transaction, and submits it via RPC. Secrets stored alongside the wallet are protected by a per-vault TRANSIT (AES-256-GCM) key inside the same HSM (envelope encryption — ciphertext lives in our DB, the key never leaves the enclave).

The provider is recorded per vault, so a single deployment can run both side-by-side. The agent surface stays the same regardless of backend: "describe what you want done."

> SpaceComputer's Orbitport KMS is documented as experimental ("not for production"). Use Sepolia / testnets for the SpaceComputer-backed flows during the demo.

![Orloj architecture: agents call MCP tools generated from Sourcify-verified ABIs; signing is delegated to pluggable KMS vaults (1Claw HSM/TEE or SpaceComputer Orbitport).](architecture.png)

## Challenges We Ran Into

*(Placeholder — to be filled in towards the end of the project.)*

## Technologies Used

**Registry server** ([packages/registry/](packages/registry/))

- Rust (Cargo — not a pnpm workspace member)
- axum 0.7 — HTTP server
- [rmcp 0.16](https://github.com/modelcontextprotocol/rust-sdk) — MCP protocol, Streamable HTTP transport
- alloy 2.0 — ABI parsing (`JsonAbi`), calldata encoding/decoding (`DynSolValue`), EIP-1559 tx construction
- sqlx 0.8 — async Postgres; per-agent bearer tokens (`mcpk_live_*`) verified with constant-time comparison

**Frontend / control plane** ([packages/app/](packages/app/))

- Next.js 16, React 19, Tailwind CSS v4, TypeScript
- Better-Auth with magic-link (Resend) + SIWE, ENS lookups via viem
- Postgres (vault ownership, agent ownership, MCP API keys, Orbitport vault metadata + envelope-encrypted secrets)

**Agent runtime** ([packages/zeroclaw-agents/](packages/zeroclaw-agents/))

- ZeroClaw — one private agent process per user, spawned over ACP from a template `config.toml` into an isolated per-agent config dir + workspace
- [0G Compute](https://0g.ai/) — decentralized inference for those agents: model `qwen3.7-max` via the 0G router (`https://router-api.0g.ai/v1`)

**On-chain & infra**

- [Sourcify](https://sourcify.dev/) — verified contract metadata / ABIs (source of truth for MCP generation)
- [1Claw](https://1claw.xyz/) — key vaults, intent-based signing, HSM-backed keys, TEE signing
- [SpaceComputer Orbitport](https://docs.spacecomputer.io/) — orbital HSM-backed KMS (`@spacecomputer-io/orbitport-sdk-ts`) for secp256k1 signing keys + AES-256-GCM envelope-encryption keys
- [0G Storage](https://0g.ai/) — immutable hosting for the curated skills marketplace ([packages/skills-marketplace/](packages/skills-marketplace/)): skill bundles are uploaded to 0G Storage, addressed by Merkle root hash with the upload registered on 0G Chain, and fetched + hash-verified at runtime into an agent's workspace
- viem — local tx construction, digest hashing, signature recovery, broadcasting

**Tooling**

- Claude Code — development
- Claude Design — UI/design exploration

## Run It Locally

The registry reads `.env`; the app reads `.env.local`. Copy the examples and fill in secrets before starting:

```bash
# from repo root
cp packages/registry/.env.example packages/registry/.env
cp packages/app/.env.example      packages/app/.env.local
```

Fill in at least:

- **`packages/registry/.env`** — `DATABASE_URL` (same Postgres as the app), and either `ONECLAW_API_KEY` + `ONECLAW_BASE_URL` or `ORBITPORT_CLIENT_ID` + `ORBITPORT_CLIENT_SECRET` depending on which vault provider you'll sign with.
- **`packages/app/.env.local`** — `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (defaults to `http://localhost:3000`), `RESEND_API_KEY` + `EMAIL_FROM` for magic-link sign-in, `REGISTRY_URL=http://localhost:3001` so the app can proxy to the registry, plus the same KMS credentials. Optional: `ETH_RPC_URL`, `ETH_RPC_URL_SEPOLIA`, `ENS_CHAIN`.

Then run:

```bash
# registry server (http://localhost:3001) — from packages/registry/
cargo run

# frontend (http://localhost:3000) — from repo root or packages/app/
pnpm install   # app only; registry is Rust/Cargo
pnpm --filter app dev
```

Node 24.15.0 and pnpm 10.33.2 are pinned via `.npmrc` and `packageManager` — `pnpm install` will refuse on the wrong versions (applies to the app only).
