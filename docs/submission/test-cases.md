# Some test cases

Real Stellar **Testnet** transactions executed through Orloj MCP and rechecked with `getTransaction`: all three returned `SUCCESS`. These are separate protocol tests using separate wallets, not an atomic PageBook-to-Blend operation. The three-minute video shows quote-only PageBook chat; it does not depict these transactions being newly submitted.

[Watch the submission video](https://www.youtube.com/watch?v=Dph5C0768c8)

## 1. PageBook — Buy one 10-XLM lot; receive 9.995 XLM after protocol fee

Contract: `CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA`

Transaction ID: `721446af6c482efbc898509778fb7a8cb75dc543ae6ea1b7522835c751bede0e`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/721446af6c482efbc898509778fb7a8cb75dc543ae6ea1b7522835c751bede0e)

Ledger: **5397614**. Actual network fee: **0.0038747 XLM**.

Spent **1.6911 Circle Testnet USDC**. Received **9.995 XLM** after PageBook's protocol fee and before the network fee. The order filled one lot and did not rest. Public liquidity was used. The exact one-call permission was removed afterward.

## 2. Blend Pools V2 — Deposit 1 XLM

Contract: `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`

Transaction ID: `af146584981eaea52b0cc7c1d95e011de95b8c7e679254f001955e4ad413a9f4`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/af146584981eaea52b0cc7c1d95e011de95b8c7e679254f001955e4ad413a9f4)

Ledger: **5387417**. Actual network fee: **0.0454527 XLM**.

## 3. Blend Pools V2 — Withdraw 0.5 XLM

Contract: `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`

Transaction ID: `7591ba9cf404bd143eb5fd082b555568190c561f04f413053f3eca59933e26de`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/7591ba9cf404bd143eb5fd082b555568190c561f04f413053f3eca59933e26de)

Ledger: **5387419**. Actual network fee: **0.0012925 XLM**.

The Blend deposit increased the recorded supply position; the 0.5-XLM withdrawal reduced it. This was a partial withdrawal, not a full exit. The Blend evidence predates the PageBook purchase.

RPC verification timestamp: `2026-10-26T12:06:42.762Z`.

[Machine-readable evidence](test-cases.json)
