# Top-ten Stellar Orloj audit — 25 October 2026


## Remediation implemented — 25 October 2026

The historical audit below is retained. Master v1.4 now covers bounded CPU headroom, declared Result returns, exact 256-bit integers and separate classic DEX/AMM adapters. Newly eligible methods still require explicit policy.

| Entry | Current signature eligibility | Verified outcome / restriction |
|---|---|---|
| Blend Pools V2 | 17/17 mainnet backstop; 27/27 testnet pool | Mainnet reads; fresh testnet deposit/withdrawal confirmed; position decreased after withdrawal. |
| Stellar DeFi Hub | 60/60 selected vault | Mainnet reads pass; project-published ownership provenance unverified. |
| Aquarius Stellar | 74/75 router | Mainnet reads including u256 liquidity; testnet trust/swap confirmed and output balance increased. get_info returns untyped Val and remains excluded. |
| Upshift | 60/60 selected vault | Mainnet reads pass; official testnet writes unverified. |
| Gami Labs | 60/60 selected vault | Mainnet reads pass; shared Upshift infrastructure; official testnet writes unverified. |
| DeFindex | 44/44 selected vault | Result reads and official testnet deposit/withdrawal confirmed; shares increased/decreased. |
| Sushi Stellar | 25/25 selected factory | Mainnet factory reads pass; router/position writes on official testnet unverified. |
| Stellar DEX | Separate classic adapter | Mainnet queries; testnet trustline, offer creation/cancellation; owner Freighter create/cancel confirmed. |
| Templar Protocol | 26/26 experimental proxy | Three Result reads pass; experimental deployment is not verified as the ranked production TVL deployment; writes unverified. |
| Stellar AMM | Separate classic adapter | Mainnet pool read; testnet pool trust, deposit and withdrawal confirmed with state checks. |

32 mainnet HTTP MCP reads across all ten entries passed with zero mainnet submission attempts. A further ten read calls checked the final encoding-v4 interfaces against their regenerated identities. The separate natural-language harness selected the expected tool for all ten entries and received successful MCP results (`agent-remediation-results.json`). This covers the recorded prompts; it does not establish arbitrary-language accuracy or browser chat acceptance.

Blend's historical failure was CPU instruction exhaustion: 1,831,549 attempted versus 1,831,400 declared. Final authorization-enforced simulation now requests configurable CPU leeway separately from fee buffering. Fee caps remain authoritative. Protocol retests used disposable wallets and an explicitly declared maximum of 300 **test** XLM. The app maximum remained 0.2 XLM; cold Blend deposits can still legitimately exceed it. No user fee grant was enlarged.

A top-level Result annotation adds no host value container. The existing depth-8 limit applies to its payload itself, which admits DeFindex's deposit without increasing that limit. Result inputs/nested Results, ambiguous options, recursive types and untyped Val remain excluded. Unknown and foreign contract errors are not guessed.

Classic reads use READ_ONLY and Horizon; classic writes use ledger/reserve/trustline/authorization preflight, owner approval, the shared account lock, durable intent before one submission, and getTransaction confirmation. They never use Soroban simulation. Both policy-enabled DEX and AMM writes were denied under managed custody with no operation created. Duplicate requests reconciled to their original hash.

Actual owner browser acceptance: created a one-stroop offer, hash `484117c427b7e185f7d948121d6ca7d2fe21be4795cc2f57a6a79b17d74ae7fc`; cancelled offer 931559, hash `26be04aeae06091fd29ef7f6697121360cda074a5e0cadc13c6ad1badaf2dd23`. Both displayed SUBMITTED_AND_CONFIRMED and independently returned SUCCESS; Horizon confirms the offer is absent. Each charged 100 stroops. An earlier approval expired before submission and remains REJECTED/SIGNING_FAILED with no hash. There was no automatic rebuild or resubmission.

The active app wallet is managed again. Unattended grants are intentionally disabled after switching wallets and require explicit owner reauthorization. Signing payloads and private credentials are absent from public evidence.

Manual checks: 126 registry tests including database-backed writes/recovery; two new app tests; app typecheck/build pass; lint has zero errors and nine pre-existing warnings. GitHub checks remain manual-only. Independent review found no remaining source-level safety blocker in the main implementation and independently verified Freighter and DeFindex transactions. The final unit-tuple/encoding-v4 followup passed local tests; independent re-review was stopped by workspace credit exhaustion.

**Remaining acceptance gaps:** integrated browser chat has no running isolated runtime broker on this host. It now fails visibly with HTTP 503 before creating/replacing agent configuration. No browser chat pass or reproducible full-stack startup is claimed. Missing official testnet deployments/provenance above still limit project write coverage. Signature eligibility is not blanket execution coverage.

New evidence: `blend-failure-diagnosis.json`, `discovery-mainnet-v4.json`, `mcp-mainnet-remediation-results.json`, `new-signature-results.json`, `agent-remediation-results.json`, `testnet-remediation-results.json`, `classic-testnet-results.json`, `classic-app-results.json`, `remediation-transaction-verification.json`, `remediation-review.json`, `encoding-v4-read-results.json`.

## Historical baseline

Outcome: **not issue-free and not ten complete integrations**. Seven representative Soroban contracts have callable read MCPs; Templar has an ingested inventory but no callable tools; two entries are classic protocol systems.

## Ranking and scope

Snapshot: 2026-10-25T16:13:53.706262+00:00. Source: [DeFiLlama protocol API](https://api.llama.fi/protocols). Sort Stellar-specific TVL descending and exclude CEX entries. Preserve source categories and overlapping vault products: these TVLs must not be summed as independent capital. This is a TVL ranking, not a ranking of every Stellar ecosystem project.

Mainnet is read-only, with no signer and WRITE_MODE=false. A submission guard recorded zero mainnet submission attempts. Writes and Friendbot funding used disposable Testnet wallets only. Existing Freighter/managed wallet grants were not changed.

|Rank|Project|Stellar TVL USD at snapshot|Read MCP|Finding|
|---|---|---:|---|---|
|1|Blend Pools V2|132,510,611.25|2 successful calls / 2 enabled tools|Mainnet reads pass. Testnet deposit confirmed; withdrawal failed with resource_limit_exceeded. Default fee cap also rejected a cold-state deposit.|
|2|Stellar DeFi Hub|112,433,646.34|3 successful calls / 3 enabled tools|Evergreen vault reads pass. Contract selected from DeFiLlama adapter; project-published ownership provenance remains unverified. Earlier pre-deposit vault has no public read entrypoints.|
|3|Aquarius Stellar|37,837,156.97|4 successful calls / 4 enabled tools|Mainnet and testnet reads pass. Testnet trustline and 0.01 XLM swap confirmed; output balance increased.|
|4|Upshift|30,277,239.65|4 successful calls / 4 enabled tools|Selected earnXLM vault mainnet reads pass. Public official testnet deployment not established; writes untested.|
|5|Gami Labs|30,277,233.72|3 successful calls / 3 enabled tools|Selected earnUSDC vault mainnet reads pass. Shares vault infrastructure with Upshift; this is not an independent stack. Testnet writes untested.|
|6|DeFindex|19,122,707.70|3 successful calls / 3 enabled tools|Metadata/fee reads pass. Only 16/44 methods supported; deposit, withdraw and managed-funds reads excluded by unsupported signatures.|
|7|Sushi Stellar|15,353,198.92|3 successful calls / 3 enabled tools|Factory reads pass. Only 18/25 signatures supported; swaps/positions not write-tested on an official testnet deployment.|
|8|Stellar DEX|14,894,953.59|No callable tools|Classic protocol order book, not a Soroban contract. No fake contract ID or callable Soroban MCP generated.|
|9|Templar Protocol|11,858,177.29|No callable tools|Official experimental tTUSDC mainnet proxy discovered. All 26 entrypoints excluded (Result signatures); zero callable tools. This is explicitly not a production vault.|
|10|Stellar AMM|8,453,183.34|No callable tools|Classic protocol liquidity pools, not Soroban contracts. Requires a separate classic-operation adapter outside current release.|

## What was actually exercised

- 22 actual HTTP MCP calls simulated successfully across seven mainnet contracts. Arguments/results were validated through Orloj codecs; no mainnet transaction was signed or submitted.
- Seven live Groq natural-language prompts selected declared tools, which executed through the actual MCP endpoints and returned SIMULATED. This is an audit harness, not a claim that the browser chat/session flow was tested.
- Official testnet deployments were ingested for Blend, Aquarius and DeFindex. DeFindex metadata reads passed; its deposit/withdraw tools were excluded before RPC.
- Blend supplied 1 test XLM successfully. Its subsequent 0.5 test XLM withdrawal failed on-chain with resource_limit_exceeded. The failed hash was retained; no automatic resubmission occurred; its position was unchanged after failure.
- Aquarius created the required test-asset trustline and swapped 0.01 test XLM, both confirmed; the received-token balance increased.
- Two disposable accounts were funded by Friendbot. Every funding and submitted protocol transaction was independently queried through getTransaction.

## Transaction verification

|Action|Hash|RPC status|Ledger|
|---|---|---|---|
|Friendbot funding / create_account|`015d75588bb5fcae17c10830e815a30a4a1f63a114313b5723923b2bf43e9092`|SUCCESS|5384354|
|Friendbot funding / create_account|`7588934794b05d4677a2aca98ec6cc104d0c8dd32ef0c1d32ad6aabf62d3c424`|SUCCESS|5384385|
|Blend Pools V2 / submit|`4f4349d769adf053b59a5dd5b945aa47d528120f34ab9517d04e988bbd2cb8d1`|SUCCESS|5384387|
|Blend Pools V2 / submit|`b49b1ae49f28d266db55add6d30626eede3b288303b4d8ea29e359b5c3c7ba31`|FAILED|5384388|
|Aquarius Stellar / trust|`3f227d83e7d1e4a22cde5f8207c98e9001233f2193e5e8ba2f7f0073927394ea`|SUCCESS|5384391|
|Aquarius Stellar / swap|`7d11d067ca2445c97c4f69cff589922ff6023d2374632aaaa6adc62887355220`|SUCCESS|5384393|

The default 0.2 XLM fee cap rejected the first Blend deposit before signing. A separate explicitly configured disposable-wallet run used a maximum of 300 **test** XLM per transaction. The successful Blend deposit charged 160.2180861 test XLM; the Aquarius swap charged 5.1630627 test XLM. These are cold-state/rent-heavy testnet results, not acceptable evidence for a universal small-fee policy or a production cost estimate. The current app wallet fee grants were not enlarged.

## Compatibility gaps

DeFindex deposit/withdraw return Result values, with additional deeply optional/nested allocation structures in some signatures. Templar proxy views also return Result and all 26 are excluded. Sushi has seven excluded signatures. Current closed-world exclusion is correct; supporting these calls needs a reviewed grammar/codec extension, not silently unwrapping or guessing results.

The Blend withdrawal failure needs a resource-estimation/buffering investigation and a confirmed retest before claiming that write flow works. A successful simulation did not guarantee inclusion with adequate resources. The on-chain failure was reported correctly.

Stellar DEX and Stellar AMM require classic-operation adapters. Current master specification excludes those adapters. Official testnet deployment addresses and contract-specific funding/setup are still needed for Hub, Upshift/Gami and Sushi write acceptance. Templar has a canonical experimental mainnet deployment record, but it is not a verified production-TVL contract.

## Local MCP access

The dedicated read-only gateway runs at `http://127.0.0.1:3012`; paths are `/contracts/<contract_id>/mcp`. Private client configuration is `.local/top10-mainnet.mcp.json`, with its credential in `.local/top10-mainnet.token`. Do not share or commit either file. The existing app remains testnet-first. Official Blend, Aquarius and DeFindex testnet contracts were also registered under the current owner/agent with explicit READ policies; the actual app credential, manifest visibility and one read per contract were verified in `app-registration.json`. Existing policies were preserved and no new app WRITE grant was added. Mainnet endpoints are standalone Orloj registry endpoints, not newly selected browser-agent sessions.

Restart the gateway from the repository root:

```sh
node --env-file=.local/top10-mainnet.env packages/stellar-registry/dist/src/cli.js serve
```

## Sources and evidence

- `ranking.json`: time-stamped ranking and methodology.
- `discovery-mainnet.json`, `discovery-testnet.json`: actual deployed specifications, WASM/interface identities, eligibility and exclusion inventory.
- `mcp-mainnet-results.json`: endpoint discovery and actual mainnet read results, with per-contract source links.
- `app-registration.json`: owner-authorized testnet registration, catalog visibility and actual app-token MCP reads.
- `agent-results.json`: Groq natural-language tool selection and real MCP responses.
- `testnet-default-fee-results.json`: original fee-policy rejection, with no protocol submission.
- `testnet-results.json`: funded testnet execution and state checks.
- `transaction-verification.json`: independent final RPC statuses and decoded failure code.

Primary deployment references: [Blend](https://docs.blend.capital/mainnet-deployments), [Aquarius](https://docs.aqua.network/developers/code-examples/prerequisites-and-basics), [Upshift/Gami](https://docs.upshift.finance/contracts/addresses), [DeFindex](https://github.com/paltalabs/defindex/blob/main/public/testnet.contracts.json), [Sushi](https://github.com/sushi-labs/sushiswap/blob/master/apps/web/src/app/(networks)/(non-evm)/stellar/_common/lib/soroban/contracts/index.ts), [Templar experimental manifest](https://github.com/Templar-Protocol/contracts/blob/dev/contract/vault/deployments/tTUSDC/mainnet/manifest.json). Hub address attribution is from the [DeFiLlama adapter](https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/stellarDefiHub/index.js), not independently verified project-published ownership.
