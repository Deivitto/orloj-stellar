# Some test cases

**13 unique confirmed Stellar Testnet transactions**, each rechecked with `getTransaction SUCCESS`. These are separate tests, not an atomic PageBook-to-Blend operation. Historical duplicate requests that reused a hash are counted once. Setup transactions are identified separately.

[Watch the three-minute demo](https://www.youtube.com/watch?v=Dph5C0768c8). It shows quote-only PageBook chat, not these transactions being newly submitted.

## Top-ten Stellar TVL projects as the MCP benchmark

We use the top ten Stellar TVL entries as our MCP compatibility benchmark, based on a dated DeFiLlama snapshot. The method sorts Stellar-specific TVL descending, excludes CEX entries and retains the source's overlapping vault/curator categories. This is not a claim of ten independent codebases or complete write access to every project.

Snapshot: **2026-10-25T16:13:53.706262+00:00**. [Source API](https://api.llama.fi/protocols) · [Stellar ranking page](https://defillama.com/chain/stellar) · [Pinned benchmark snapshot](test-cases.json). Rankings can change.

All ten benchmark entries have recorded representative read-only MCP coverage. **Five of ten** have recorded Testnet write coverage: Blend, Aquarius, DeFindex, Stellar DEX and Stellar AMM. Some representative vault/factory addresses are adapter-derived; this is interface interoperability evidence, not project endorsement or proof of every deployment. PageBook is an additional experimental Testnet integration outside this ranking.

| Snapshot rank | Entry | Recorded MCP scope |
| --- | --- | --- |
| 1 | Blend Pools V2 | Representative reads + Testnet writes |
| 2 | Stellar DeFi Hub | Representative reads; no confirmed project Testnet write here |
| 3 | Aquarius Stellar | Representative reads + Testnet writes |
| 4 | Upshift | Representative reads; no confirmed project Testnet write here |
| 5 | Gami Labs | Representative reads; no confirmed project Testnet write here |
| 6 | DeFindex | Representative reads + Testnet writes |
| 7 | Sushi Stellar | Representative reads; no confirmed project Testnet write here |
| 8 | Stellar DEX | Separate classic adapter reads/writes; not Soroban WASM |
| 9 | Templar Protocol | Representative reads; no confirmed project Testnet write here |
| 10 | Stellar AMM | Separate classic adapter reads/writes; not Soroban WASM |

## Confirmed transaction index

| # | Project | Test | Confirmed transaction |
| --- | --- | --- | --- |
| 1 | PageBook | Buy one 10-XLM lot; receive 9.995 XLM after protocol fee | [721446af6c48…](https://stellar.expert/explorer/testnet/tx/721446af6c482efbc898509778fb7a8cb75dc543ae6ea1b7522835c751bede0e) |
| 2 | Blend Pools V2 | Deposit 1 XLM | [af146584981e…](https://stellar.expert/explorer/testnet/tx/af146584981eaea52b0cc7c1d95e011de95b8c7e679254f001955e4ad413a9f4) |
| 3 | Blend Pools V2 | Withdraw 0.5 XLM | [7591ba9cf404…](https://stellar.expert/explorer/testnet/tx/7591ba9cf404bd143eb5fd082b555568190c561f04f413053f3eca59933e26de) |
| 4 | DeFindex | Vault deposit: 10,000,000 desired base units | [8540a061a950…](https://stellar.expert/explorer/testnet/tx/8540a061a950195f41204f743a056f275dfce33f4cffb8d0caa8e0a71b3bb45a) |
| 5 | DeFindex | Withdraw 2,998 vault-share base units | [bcf2bc685f7d…](https://stellar.expert/explorer/testnet/tx/bcf2bc685f7d9f421045c51485c1a47b9028bed46e03cf0092e5cc91382acfcb) |
| 6 | Aquarius Stellar | Output-asset trustline setup (SAC) | [30dd5b5837c3…](https://stellar.expert/explorer/testnet/tx/30dd5b5837c3e8b5300d889d884d7c9dcb16e8786129ad7ae3c3a35b8715624a) |
| 7 | Aquarius Stellar | Swap 0.01 XLM with a minimum output | [32a6faac221b…](https://stellar.expert/explorer/testnet/tx/32a6faac221b286c657b10ee86b43f501e40b516eb69c8dc99bac73e9ffa8472) |
| 8 | Stellar DEX | Fixture-asset trustline setup | [af0192c10749…](https://stellar.expert/explorer/testnet/tx/af0192c10749c4ea9c56c824c3bb5826c98b1f98d9270f87962dae82b9a47d71) |
| 9 | Stellar DEX | Create a fixture-asset offer | [215830b18dd0…](https://stellar.expert/explorer/testnet/tx/215830b18dd02540d45ecad245e409cb4434bdca1605463c9d2c04a7ae436a03) |
| 10 | Stellar DEX | Cancel the recorded offer | [b9782a87e954…](https://stellar.expert/explorer/testnet/tx/b9782a87e954c94072472b47db7c3bf957c9ecd7c07d272b509f4236554768c5) |
| 11 | Stellar AMM | Pool-share trustline setup | [784506abf665…](https://stellar.expert/explorer/testnet/tx/784506abf665f81279e1e858ea352639d6ea88837c0db5f4cf2812fd2b01d6b5) |
| 12 | Stellar AMM | Deposit into the fixture liquidity pool | [2cbeaef85d6d…](https://stellar.expert/explorer/testnet/tx/2cbeaef85d6d48fe92a20ccce0110ee97cf4e3e0834bbb2fd752fa2290b357e2) |
| 13 | Stellar AMM | Withdraw fixture pool shares | [f25300dd50b6…](https://stellar.expert/explorer/testnet/tx/f25300dd50b6785c627f687cdd52b893b528571ff4619399cd31a01efb805f85) |

## MCP examples and receipts

Each collapsed example uses the recorded method and argument encoding. It is illustrative historical evidence, **not a request to replay a transaction**. The idempotency keys below are placeholders, not the original keys. New calls require current interface registration, permissions, funding, preparation and signing. Authentication and private keys are intentionally absent. Amounts remain exact base-unit strings.

### 1. PageBook — Buy one 10-XLM lot; receive 9.995 XLM after protocol fee

Interface: `CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA`

Transaction ID: `721446af6c482efbc898509778fb7a8cb75dc543ae6ea1b7522835c751bede0e`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/721446af6c482efbc898509778fb7a8cb75dc543ae6ea1b7522835c751bede0e) · Ledger **5397614** · Actual network fee **0.0038747 XLM**.

Scope: Direct authenticated Orloj MCP; separate from the quote-only video.

Spent **1.6911 Circle Testnet USDC**, received **9.995 XLM** after the protocol fee and before network fees. The exact one-call grant was removed after confirmation.

<details>
<summary>Example MCP call: <code>place</code></summary>

Local endpoint: `http://localhost:3002/contracts/CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-1",
  "method": "tools/call",
  "params": {
    "name": "place",
    "arguments": {
      "taker": "GCLEKFNVDD75POJDCTVNWN7OBZZ2C6MQT5RANBFSEX6HCE6NQ26CUX3S",
      "market": 0,
      "is_bid": true,
      "limit_tick": 16911,
      "qty_lots": "1",
      "start_tick": 16911,
      "nonce": "117506811297810232",
      "flags": {
        "post_only": false,
        "fill_or_kill": true,
        "no_rest": true
      },
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_1"
    }
  }
}
```

</details>

### 2. Blend Pools V2 — Deposit 1 XLM

Interface: `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`

Transaction ID: `af146584981eaea52b0cc7c1d95e011de95b8c7e679254f001955e4ad413a9f4`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/af146584981eaea52b0cc7c1d95e011de95b8c7e679254f001955e4ad413a9f4) · Ledger **5387417** · Actual network fee **0.0454527 XLM**.

Scope: Historical direct MCP protocol test.

<details>
<summary>Example MCP call: <code>submit</code></summary>

Local endpoint: `http://localhost:3002/contracts/CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-2",
  "method": "tools/call",
  "params": {
    "name": "submit",
    "arguments": {
      "from": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "spender": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "to": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "requests": [
        {
          "address": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          "amount": "10000000",
          "request_type": 0
        }
      ],
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_2"
    }
  }
}
```

</details>

### 3. Blend Pools V2 — Withdraw 0.5 XLM

Interface: `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`

Transaction ID: `7591ba9cf404bd143eb5fd082b555568190c561f04f413053f3eca59933e26de`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/7591ba9cf404bd143eb5fd082b555568190c561f04f413053f3eca59933e26de) · Ledger **5387419** · Actual network fee **0.0012925 XLM**.

Scope: Historical direct MCP protocol test.

<details>
<summary>Example MCP call: <code>submit</code></summary>

Local endpoint: `http://localhost:3002/contracts/CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-3",
  "method": "tools/call",
  "params": {
    "name": "submit",
    "arguments": {
      "from": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "spender": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "to": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "requests": [
        {
          "address": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          "amount": "5000000",
          "request_type": 1
        }
      ],
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_3"
    }
  }
}
```

</details>

### 4. DeFindex — Vault deposit: 10,000,000 desired base units

Interface: `CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6`

Transaction ID: `8540a061a950195f41204f743a056f275dfce33f4cffb8d0caa8e0a71b3bb45a`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/8540a061a950195f41204f743a056f275dfce33f4cffb8d0caa8e0a71b3bb45a) · Ledger **5387422** · Actual network fee **0.0263452 XLM**.

Scope: Historical direct MCP protocol test.

<details>
<summary>Example MCP call: <code>deposit</code></summary>

Local endpoint: `http://localhost:3002/contracts/CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-4",
  "method": "tools/call",
  "params": {
    "name": "deposit",
    "arguments": {
      "amounts_desired": [
        "10000000"
      ],
      "amounts_min": [
        "9900000"
      ],
      "from": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "invest": false,
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_4"
    }
  }
}
```

</details>

### 5. DeFindex — Withdraw 2,998 vault-share base units

Interface: `CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6`

Transaction ID: `bcf2bc685f7d9f421045c51485c1a47b9028bed46e03cf0092e5cc91382acfcb`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/bcf2bc685f7d9f421045c51485c1a47b9028bed46e03cf0092e5cc91382acfcb) · Ledger **5387426** · Actual network fee **0.0014911 XLM**.

Scope: Historical direct MCP protocol test.

Share base units are vault shares, not XLM amounts. The recorded minimum output was zero in this controlled historical test; this is not a recommended default for new withdrawals.

<details>
<summary>Example MCP call: <code>withdraw</code></summary>

Local endpoint: `http://localhost:3002/contracts/CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-5",
  "method": "tools/call",
  "params": {
    "name": "withdraw",
    "arguments": {
      "withdraw_shares": "2998",
      "min_amounts_out": [
        "0"
      ],
      "from": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_5"
    }
  }
}
```

</details>

### 6. Aquarius Stellar — Output-asset trustline setup (SAC)

Interface: `CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5`

Transaction ID: `30dd5b5837c3e8b5300d889d884d7c9dcb16e8786129ad7ae3c3a35b8715624a`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/30dd5b5837c3e8b5300d889d884d7c9dcb16e8786129ad7ae3c3a35b8715624a) · Ledger **5387429** · Actual network fee **0.0007432 XLM**.

Scope: Token setup for Aquarius; not a router swap.

<details>
<summary>Example MCP call: <code>trust</code></summary>

Local endpoint: `http://localhost:3002/contracts/CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-6",
  "method": "tools/call",
  "params": {
    "name": "trust",
    "arguments": {
      "addr": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_6"
    }
  }
}
```

</details>

### 7. Aquarius Stellar — Swap 0.01 XLM with a minimum output

Interface: `CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD`

Transaction ID: `32a6faac221b286c657b10ee86b43f501e40b516eb69c8dc99bac73e9ffa8472`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/32a6faac221b286c657b10ee86b43f501e40b516eb69c8dc99bac73e9ffa8472) · Ledger **5387431** · Actual network fee **0.0023509 XLM**.

Scope: Historical direct MCP protocol test.

<details>
<summary>Example MCP call: <code>swap</code></summary>

Local endpoint: `http://localhost:3002/contracts/CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-7",
  "method": "tools/call",
  "params": {
    "name": "swap",
    "arguments": {
      "user": "GBSBUPFN5LVHMXIUWOTCD2PQ6NSI27TDS72FNYCNSJQXWFAFCC7DCGZA",
      "tokens": [
        "CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5",
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
      ],
      "token_in": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "token_out": "CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5",
      "pool_index": "49136338380911dda8f39cc141fcdbfb001149f9a9fde30c7fa6a098e6a96fd6",
      "in_amount": "100000",
      "out_min": "15798",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_7"
    }
  }
}
```

</details>

### 8. Stellar DEX — Fixture-asset trustline setup

Interface: `classic:stellar-dex`

Transaction ID: `af0192c10749c4ea9c56c824c3bb5826c98b1f98d9270f87962dae82b9a47d71`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/af0192c10749c4ea9c56c824c3bb5826c98b1f98d9270f87962dae82b9a47d71) · Ledger **5387414** · Actual network fee **0.0000100 XLM**.

Scope: Classic Stellar adapter with a project-controlled Testnet fixture asset; not a Soroban contract.

<details>
<summary>Example MCP call: <code>change_trust</code></summary>

Local endpoint: `http://localhost:3002/contracts/classic%3Astellar-dex/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-8",
  "method": "tools/call",
  "params": {
    "name": "change_trust",
    "arguments": {
      "asset": "ORLOJTEST:GCDFNP5M2C3F5KNZBUICFXEFE5IBKQVSE6HC4FSRONXG56L443MSCX3L",
      "limit": "10000000000",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_8"
    }
  }
}
```

</details>

### 9. Stellar DEX — Create a fixture-asset offer

Interface: `classic:stellar-dex`

Transaction ID: `215830b18dd02540d45ecad245e409cb4434bdca1605463c9d2c04a7ae436a03`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/215830b18dd02540d45ecad245e409cb4434bdca1605463c9d2c04a7ae436a03) · Ledger **5387417** · Actual network fee **0.0000100 XLM**.

Scope: Classic Stellar adapter with a project-controlled Testnet fixture asset; not a Soroban contract.

<details>
<summary>Example MCP call: <code>manage_offer</code></summary>

Local endpoint: `http://localhost:3002/contracts/classic%3Astellar-dex/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-9",
  "method": "tools/call",
  "params": {
    "name": "manage_offer",
    "arguments": {
      "selling": "ORLOJTEST:GCDFNP5M2C3F5KNZBUICFXEFE5IBKQVSE6HC4FSRONXG56L443MSCX3L",
      "buying": "native",
      "amount": "10000000",
      "price": {
        "n": 1,
        "d": 1
      },
      "offer_id": "0",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_9"
    }
  }
}
```

</details>

### 10. Stellar DEX — Cancel the recorded offer

Interface: `classic:stellar-dex`

Transaction ID: `b9782a87e954c94072472b47db7c3bf957c9ecd7c07d272b509f4236554768c5`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/b9782a87e954c94072472b47db7c3bf957c9ecd7c07d272b509f4236554768c5) · Ledger **5387419** · Actual network fee **0.0000100 XLM**.

Scope: Classic Stellar adapter with a project-controlled Testnet fixture asset; not a Soroban contract.

<details>
<summary>Example MCP call: <code>manage_offer</code></summary>

Local endpoint: `http://localhost:3002/contracts/classic%3Astellar-dex/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-10",
  "method": "tools/call",
  "params": {
    "name": "manage_offer",
    "arguments": {
      "selling": "ORLOJTEST:GCDFNP5M2C3F5KNZBUICFXEFE5IBKQVSE6HC4FSRONXG56L443MSCX3L",
      "buying": "native",
      "amount": "0",
      "price": {
        "n": 1,
        "d": 1
      },
      "offer_id": "931660",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_10"
    }
  }
}
```

</details>

### 11. Stellar AMM — Pool-share trustline setup

Interface: `classic:stellar-amm`

Transaction ID: `784506abf665f81279e1e858ea352639d6ea88837c0db5f4cf2812fd2b01d6b5`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/784506abf665f81279e1e858ea352639d6ea88837c0db5f4cf2812fd2b01d6b5) · Ledger **5387421** · Actual network fee **0.0000100 XLM**.

Scope: Classic Stellar adapter with a project-controlled Testnet fixture asset; not a Soroban contract.

<details>
<summary>Example MCP call: <code>trust_pool</code></summary>

Local endpoint: `http://localhost:3002/contracts/classic%3Astellar-amm/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-11",
  "method": "tools/call",
  "params": {
    "name": "trust_pool",
    "arguments": {
      "asset_a": "native",
      "asset_b": "ORLOJTEST:GCDFNP5M2C3F5KNZBUICFXEFE5IBKQVSE6HC4FSRONXG56L443MSCX3L",
      "limit": "10000000000",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_11"
    }
  }
}
```

</details>

### 12. Stellar AMM — Deposit into the fixture liquidity pool

Interface: `classic:stellar-amm`

Transaction ID: `2cbeaef85d6d48fe92a20ccce0110ee97cf4e3e0834bbb2fd752fa2290b357e2`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/2cbeaef85d6d48fe92a20ccce0110ee97cf4e3e0834bbb2fd752fa2290b357e2) · Ledger **5387423** · Actual network fee **0.0000100 XLM**.

Scope: Classic Stellar adapter with a project-controlled Testnet fixture asset; not a Soroban contract.

<details>
<summary>Example MCP call: <code>pool_deposit</code></summary>

Local endpoint: `http://localhost:3002/contracts/classic%3Astellar-amm/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-12",
  "method": "tools/call",
  "params": {
    "name": "pool_deposit",
    "arguments": {
      "pool_id": "62778a1506337f4a7781157b673a7892b918729c931741cd7a7bac427a4aa330",
      "max_amount_a": "10000000",
      "max_amount_b": "10000000",
      "min_price": {
        "n": 99,
        "d": 100
      },
      "max_price": {
        "n": 101,
        "d": 100
      },
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_12"
    }
  }
}
```

</details>

### 13. Stellar AMM — Withdraw fixture pool shares

Interface: `classic:stellar-amm`

Transaction ID: `f25300dd50b6785c627f687cdd52b893b528571ff4619399cd31a01efb805f85`

[View confirmed transaction](https://stellar.expert/explorer/testnet/tx/f25300dd50b6785c627f687cdd52b893b528571ff4619399cd31a01efb805f85) · Ledger **5387426** · Actual network fee **0.0000100 XLM**.

Scope: Classic Stellar adapter with a project-controlled Testnet fixture asset; not a Soroban contract.

<details>
<summary>Example MCP call: <code>pool_withdraw</code></summary>

Local endpoint: `http://localhost:3002/contracts/classic%3Astellar-amm/mcp`

```json
{
  "jsonrpc": "2.0",
  "id": "example-13",
  "method": "tools/call",
  "params": {
    "name": "pool_withdraw",
    "arguments": {
      "pool_id": "62778a1506337f4a7781157b673a7892b918729c931741cd7a7bac427a4aa330",
      "amount": "5000000",
      "min_amount_a": "4900000",
      "min_amount_b": "4900000",
      "idempotency_key": "EXAMPLE_ONLY_DO_NOT_REPLAY_13"
    }
  }
}
```

</details>

## Interpretation and evidence

Blend's recorded deposit increased supply; its partial withdrawal reduced supply. It did not withdraw all deposited funds. Classic DEX/AMM tests used a project-controlled fixture asset, not Circle USDC or a third-party privileged role. The Aquarius trust call is token setup, not an additional swap.

Fresh RPC recheck: `2026-10-26T12:11:51.962Z`. The historical 39-transaction snapshot remains separate; this curated list is not added to that total.

[Machine-readable evidence, exact arguments and benchmark snapshot](test-cases.json)
