# Verified Stellar Asset Contract adapter

`sac-v29.contract.rs` is the unmodified official Stellar host implementation at commit `a721944b5a4ea830a4bf5c2dbb8dbe8c1e1354c5` (release v29.0.0). The URL and SHA-256 are recorded in `sac-v29.json` and verified on adapter load. The source is distributed under the upstream Apache-2.0 license (see `STELLAR-LICENSE`).

The JSON fixture transcribes all 17 public method signatures directly from that source. Omit the initialization hook `init_asset`: deployment invokes it; it is not a post-deployment asset operation. Keep source parameter names (`addr`, `to_mux`, `live_until_ledger`) rather than the stale SDK binding aliases. MCP uses those names; on-chain arguments remain positional. Return `Result<T, HostError>` is the host implementation boundary, not a Soroban `Result` value: successful output is T, and errors abort execution.

Only protocol 29 is verified. Do not extend the protocol list without reviewing the corresponding official host source, types and behavior, pinning its source and checksum, and running compatibility and live testnet checks. A network upgrade fails closed until a verified adapter is added and contracts are re-registered. The SDK already parses future address variants, but that does not enable them on an older protocol.

`contract.Client.from()` is intentionally not the specification authority: SDK 17.3.0 embeds an older 16-method SAC spec that omits `trust` and declares the old transfer destination type.
