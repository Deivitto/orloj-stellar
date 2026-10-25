# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`orloj-registry` — MCP contracts/interfaces for AI agents. ETHPrague Hackathon 2026 project. Three implemented workspaces: a registry server that turns Sourcify-verified ABIs into MCP servers and signs via pluggable KMS, a Next.js control-plane that owns auth, vaults, agents, and MCP API keys, and a skills marketplace that publishes agent skills to 0G Storage and is read back at runtime by the control plane.

## Repo layout

pnpm workspace monorepo (see [pnpm-workspace.yaml](pnpm-workspace.yaml)):

- [packages/skills-marketplace/](packages/skills-marketplace/) — publishes the skills in `skills/` to 0G Storage and holds the read side the app consumes (`gateway.ts` fetch + Merkle verification, `install-plan.ts` path hardening and add/remove diffing). Not a Next.js concern: it has its own `node --test` suite, which is why every decidable rule lives here rather than in `packages/app`. `packages/app` links it with `link:../skills-marketplace` — **not** `workspace:^`, because `packages/app` has its own `pnpm-lock.yaml` and its `pnpm-workspace.yaml` declares no `packages:`.
- [packages/registry/](packages/registry/) — Rust (axum + rmcp) registry server. **Not a pnpm workspace member** (no `package.json`); managed entirely by Cargo. Endpoints: `GET /healthz`, `GET /mcp` (manifest list), `POST /register` (Sourcify lookup → persists to Postgres → builds in-memory MCP), `POST /register-native` (native token MCP), `POST /interface/:name/mcp` (bearer-auth, per-agent MCP over Streamable HTTP). ABI → MCP tool mapping in `src/abi_codec.rs`; signing routed through `src/vault/sign_transaction.rs` (Orbitport KMS or 1Claw). In-memory registry with 30-min idle eviction in `src/registry.rs`. Auth in `src/auth.rs` (constant-time `mcp_api_key` lookup). Also serves a hand-written Uniswap MCP at `POST /interface/uniswap/mcp` (`src/mcps/uniswap/`) covering swaps via the Uniswap Trading API on any registered chain, plus Uniswap V3 liquidity-position management (`get_v3_position`, `create_v3_position`, `decrease_v3_position`, `claim_v3_fees`) via the separate Uniswap Liquidity API — Ethereum Sepolia only. Full details in [packages/registry/CLAUDE.md](packages/registry/CLAUDE.md). Runs on `:3001` by default.
- [packages/app/](packages/app/) — Next.js 16 control plane. Pages: `/`, `/explore`, `/register`, `/profile`, `/docs`, `/session/[agentId]`, `/agents/[id]` (all locale-prefixed under `app/[lang]/`). **`/{lang}/session/{agentId}` is the agent app** — the chat, and the `start_url`/`scope` of the per-agent PWA manifest, so it is the only page that links the manifest and can offer the install; `/{lang}/agents/{id}` is just that app's branding page (custom name + PNG icon). API routes under `app/api/`: `agents`, `agents/[id]`, `agents/[id]/rotate-key`, `agents/[id]/mcps` (GET session config, PUT session MCP selection), `agents/[id]/skills` (GET installed skills, PUT skill selection), `agents/[id]/{branding,icon/[size],manifest.webmanifest}`, `session`, `session/[id]`, `session/[id]/{chat,reset}`, `vaults`, `vaults/[id]`, `vaults/[id]/secrets`, `vaults/[id]/key-grants`, `vaults/[id]/sign-test`, `register` (proxies registry), `mcps`, `skills` (the 0G skills catalog), `metrics`, `auth/[...all]`. `lib/auth.ts` is Better-Auth with magic-link (Resend) + SIWE + post-SIWE ENS refresh. `lib/db.ts` provisions schema on first pool acquire (`vault_ownership`, `agent_ownership`, `mcp_api_key`, `agent_app_branding`, `orbitport_vault`, `orbitport_secret`, `orbitport_grant`), and drops the retired `agent_mcp_binding` table. Authorization is bearer-token-only: the registry resolves `mcp_api_key` → `agent_id` and that agent may call any MCP the registry serves — there is no per-agent MCP allowlist. `lib/vault-providers/{oneclaw,orbitport}.ts` are the TS provider abstraction; the Orbitport provider provisions one secp256k1 + one AES-256-GCM key per vault and stores ciphertext rows in our Postgres (envelope encryption). `lib/mcp-tokens.ts` issues `mcpk_live_*` bearer tokens that the registry verifies. Agent **skills** are installed per agent at `<agentDir>/shared/skills/orloj/<name>/`, downloaded from 0G Storage and verified by Merkle root before anything is written (`lib/session/skill-catalog.ts`, `lib/session/skill-install.ts`); the filesystem is the only selection state — no sidecar, no table. Note the location is NOT `<workspace>/skills/`: with no skill bundle configured, zeroclaw silently relocates that directory to `shared/skills/` and then does not load it, so `applyManagedConfig` registers a `skill_bundles.orloj` bundle on every session start.

The root `package.json` declares no scripts; commands are run inside individual packages.

## Toolchain (non-obvious)

- **Node 24.15.0** is pinned via [.npmrc](.npmrc) (`use-node-version=24.15.0`) with `engine-strict=true`. pnpm will refuse to install on the wrong Node.
- **pnpm 10.33.2** is pinned via `packageManager` in root [package.json](package.json) and `manage-package-manager-versions=true` in `.npmrc`. Use `pnpm`, not `npm`/`yarn`.
- `prefer-frozen-lockfile=true` — install with `pnpm install --frozen-lockfile` in CI-like contexts; locally `pnpm install` is fine when adding deps.
- `link-workspace-packages=false` — workspace packages are NOT auto-linked. To depend on another workspace package, declare it explicitly with the `workspace:` protocol (saved as `workspace:^` per `save-workspace-protocol=rolling`).

## Common commands

From `packages/app/`:

```bash
pnpm dev      # next dev — local development server on :3000
pnpm build    # next build
pnpm start    # next start (after build)
pnpm lint     # eslint (eslint-config-next core-web-vitals + typescript)
```

From `packages/registry/`:

```bash
cargo build                    # compile
cargo run                            # run (port :3001)
cargo check                    # fast type-check without linking
```

The registry reads env vars via `dotenvy::dotenv_override()` — loads `.env` only (not `.env.local`). There is no test runner configured yet, and no root-level orchestration scripts.

## Critical: Next.js 16 is not the Next.js you know

[packages/app/AGENTS.md](packages/app/AGENTS.md) (also imported by [packages/app/CLAUDE.md](packages/app/CLAUDE.md)) warns:

> This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

Before editing anything in `packages/app/`, consult `packages/app/node_modules/next/dist/docs/` for the correct current API. Do not rely on memorized Next.js patterns. Tailwind is v4 (PostCSS plugin only — `@tailwindcss/postcss`), not v3.

## TypeScript path alias

Inside `packages/app/`, `@/*` maps to the package root (see [packages/app/tsconfig.json](packages/app/tsconfig.json)) — e.g. `@/app/page` → `./app/page`.

## Adding dependencies

Before installing any new dependency:

1. **Ask the user to confirm** the addition — do not silently add deps to `package.json`.
2. **Look up the latest published version** (e.g. `pnpm view <pkg> version`) rather than using a version from training data, which is likely stale.
3. **Install it pinned to that exact latest version**. `.npmrc` already sets `save-exact=true`, so `pnpm add <pkg>` will write the exact resolved version — but always verify the version that landed in `package.json` matches the latest you looked up. Do not write `^` / `~` ranges by hand.

## Orloj Stellar build target

This private mirror is the base for Orloj Stellar. Read `ORLOJ_STELLAR_MASTER.md` (version 1.1) and `ORLOJ_STELLAR_BUILD_PROMPT.md` before implementation. The master specification and its approved clarifications govern Stellar work; the existing EVM implementation is reference code. Decisions are recorded in `ORLOJ_STELLAR_OPEN_QUESTIONS.md`. If a requested change conflicts with the master, ask for clarification.
