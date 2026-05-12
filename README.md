# hyperbalance

`hyperbalance` is a small TypeScript library for clients that need to pay into
AO-backed HyperBEAM local ledgers before making a request.

For the standard AO-paid HyperBEAM bundler flow, no new payment metadata device
is required. The library uses the routes HyperBEAM already exposes:

```text
/~meta@1.0/info/address
/~meta@1.0/info/ao-payment-deposit-address
/~arweave-byte-pricing@1.0/quote?resource=arweave-bytes&amount={bytes}
/ledger~node-process@1.0/now/balance/{address}
/~ao-payment@1.0/ingest
```

Client tools can then:

1. find the node AO deposit address,
2. quote the intended request,
3. check the payer's local ledger balance,
4. calculate the shortfall,
5. send AO to the advertised deposit address,
6. import the verified AO deposit into the local ledger,
7. re-check the spendable local balance.

## Install

Install from npm:

```sh
npm install hyperbalance
```

## Basic Usage

```ts
import {
  DEFAULT_AO_TOKEN_ID,
  HYPERBEAM_AO_BUNDLER_QUOTE_ACTION,
  HYPERBEAM_DEFAULT_LEDGER_ID,
  HyperbalanceClient,
  discoverHyperbeamAoBundlerProfile,
} from "hyperbalance"

const client = new HyperbalanceClient({
  nodeUrl: "https://hyperbeam.example.com",
})

const profile = await discoverHyperbeamAoBundlerProfile({
  nodeUrl: "https://hyperbeam.example.com",
})
const address = "payer-wallet-address"

const balance = await client.getBalance({
  profile,
  ledgerId: HYPERBEAM_DEFAULT_LEDGER_ID,
  address,
})

console.log(balance.value)

const quote = await client.quote({
  profile,
  action: HYPERBEAM_AO_BUNDLER_QUOTE_ACTION,
  params: { bytes: 1234 },
})

console.log(quote.amount)
```

## Funding

Funding needs a transfer adapter that can sign and submit AO token messages.
`AoTokenTransferAdapter` provides the HyperBEAM-compatible tag construction; the
caller supplies wallet-specific signing/submission.

```ts
await client.ensureCredit({
  profile,
  ledgerId: HYPERBEAM_DEFAULT_LEDGER_ID,
  tokenId: DEFAULT_AO_TOKEN_ID,
  recipient: "payer-wallet-address",
  minimumBalance: 1_000_000n,
  transferAdapter,
})
```

## Constants vs Inference

The caller should normally provide:

- node URL,
- signer or wallet,
- intended recipient address if it cannot be inferred,
- minimum balance or intended operation to quote.

The node provides:

- operator address via `/~meta@1.0/info/address`,
- deposit address via `/~meta@1.0/info/ao-payment-deposit-address`,
- upload price via `arweave-byte-pricing@1.0`,
- balances via the local `ledger~node-process@1.0`,
- deposit import via `ao-payment@1.0`.

The library should not hardcode:

- a specific deployment URL,
- a specific ledger process ID,
- deposit address equals operator address,
- upload byte price.

The library does assume AO for HyperBEAM bundler payments.
