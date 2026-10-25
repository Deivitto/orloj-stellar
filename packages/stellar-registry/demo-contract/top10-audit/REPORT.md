# Top-ten Stellar Orloj audit — 25 October 2026

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
