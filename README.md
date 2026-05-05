# hyperbalance

`hyperbalance` is a small TypeScript library for clients that need to pay into
HyperBEAM-style local ledgers before making a request.

It is intentionally not tied to one deployment, token, or ledger. A node should
advertise its payment interface, and client tools can then:

1. discover accepted ledgers and tokens,
2. check a local ledger balance,
3. calculate the shortfall,
4. send funds with a token adapter,
5. import the verified deposit into the local ledger,
6. re-check the spendable local balance.

## Install

This repo is local-first for now:

```sh
pnpm install
pnpm build
```

## Basic Usage

```ts
import { HyperbalanceClient } from "hyperbalance"

const client = new HyperbalanceClient({
  nodeUrl: "https://hyperbeam.example.com",
})

const profile = await client.discover()
const address = "payer-wallet-address"

const balance = await client.getBalance({
  profile,
  ledgerId: "local-ao",
  address,
})

console.log(balance.value)

const quote = await client.quote({
  profile,
  action: "hyperbeam-upload",
  params: { bytes: 1234 },
})

console.log(quote.amount)
```

## Funding

Funding needs a token-specific transfer adapter. The core library does not know
how to sign every token transfer. It only coordinates the generic flow.

```ts
await client.ensureCredit({
  profile,
  ledgerId: "local-ao",
  tokenId: "ao",
  recipient: "payer-wallet-address",
  minimumBalance: 1_000_000n,
  transferAdapter,
})
```

## Discovery

A node should expose one of these paths:

```text
/.well-known/hyperbalance
/~payments@1.0/info
/~hyperbalance@1.0/info
```

Example response:

```json
{
  "version": "hyperbalance@0.1",
  "node": {
    "operator": "node-wallet-address"
  },
  "ledgers": [
    {
      "id": "local-ao",
      "type": "process-ledger@1.0",
      "route": "/abc~process@1.0",
      "balancePath": "/abc~process@1.0/now/balance/{address}"
    }
  ],
  "tokens": [
    {
      "id": "ao-mainnet",
      "ticker": "AO",
      "decimals": 12,
      "network": "ao",
      "ledgerId": "local-ao",
      "depositAddress": "node-wallet-address",
      "transfer": {
        "kind": "ao",
        "processId": "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
        "tags": {
          "Action": "Transfer",
          "Recipient": "{depositAddress}",
          "Quantity": "{quantity}",
          "X-HB-Recipient": "{recipient}"
        }
      },
      "import": {
        "method": "POST",
        "path": "/~ao-payment@1.0/ingest",
        "query": {
          "token": "{tokenId}",
          "ledger": "{ledgerId}",
          "message-id": "{messageId}",
          "slot": "{slot}",
          "sender": "{sender}",
          "recipient": "{recipient}",
          "quantity": "{quantity}"
        }
      }
    }
  ],
  "pricing": [
    {
      "action": "hyperbeam-upload",
      "quotePath": "/~hyperbalance@1.0/quote/hyperbeam-upload?bytes={bytes}"
    }
  ]
}
```

## Constants vs Inference

The caller should normally provide:

- node URL,
- signer or wallet,
- intended recipient address if it cannot be inferred,
- minimum balance or intended operation to quote.

The node should advertise:

- ledger IDs and balance routes,
- accepted token IDs,
- token decimals,
- deposit address,
- transfer tag template,
- import route,
- quote routes or pricing policy.

The library should not hardcode:

- a specific deployment URL,
- a specific ledger process ID,
- a specific token process ID,
- deposit address equals operator address,
- upload byte price,
- AO as the only supported token.
