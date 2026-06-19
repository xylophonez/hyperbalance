# hyperbalance

`hyperbalance` is a small TypeScript library for clients that need to pay into
AO-backed HyperBEAM local ledgers before making a request.

For the standard AO-paid HyperBEAM bundler flow, no new payment metadata device
is required. The library uses the routes HyperBEAM already exposes:

```text
/~meta@1.0/info/address
/~meta@1.0/info/ao-payment-deposit-address
/~meta@1.0/info/ao-payment-ledger
/~arweave-byte-pricing@1.0/quote?resource=arweave-bytes&amount={bytes}
/ledger~node-process@1.0/now/balance/{address}
/~p4@1.0/balance?target={address}
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
npm install @permaweb/hyperbalance
```

## Basic Usage

```ts
import {
  DEFAULT_AO_TOKEN_ID,
  HYPERBEAM_AO_BUNDLER_QUOTE_ACTION,
  HYPERBEAM_DEFAULT_LEDGER_ID,
  HyperbalanceClient,
  discoverHyperbeamAoBundlerProfile,
} from "@permaweb/hyperbalance"

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
console.log(quote.advisories)
```

## Bundler Free Tier And Trundler

LapEE-style HyperBEAM bundlers can expose a free byte tier and use
`trundler@1.0` to limit how often a signer or IP receives that free tier.
`discoverHyperbeamAoBundlerProfile` keeps the amount-only quote route on
`/~arweave-byte-pricing@1.0/quote`, adds exact-request preflight at
`/~arweave-byte-pricing@1.0/preflight`, and annotates the pricing descriptor with:

- `subject`: the quoted input is an `arweave-bytes` byte count supplied as
  `{bytes}`;
- `settlement`: the real upload is settled by P4 on `/~bundler@1.0/item` and
  `/~bundler@1.0/tx`, with insufficient balance surfaced as HTTP 402;
- `zeroQuote`: a zero quote can be a conditional free-tier result backed by
  `trundler@1.0`; amount-only quote calls do not consume quota, while preflight
  consumes/reserves quota for the exact signed request.

Amount-only quotes are conservative on trundler-aware nodes. If the node cannot
prove that the exact request owns the next free slot, it returns the paid fallback
amount so clients can fund the upload safely.

For deterministic UX, call `client.preflight` after constructing the signed
bundler upload request and before submitting it:

```ts
const preflight = await client.preflight({
  action: HYPERBEAM_AO_BUNDLER_QUOTE_ACTION,
  profile,
  params: { bytes: file.size },
  request: signedUploadRequest,
})

if (preflight.decision === "free") {
  // The node reserved free-tier eligibility for this exact signed request.
}

if (preflight.paymentRequired) {
  // Fund at least preflight.amount before uploading.
}
```

The bundler behavior is paid fallback, not hard block: when trundler quota is
exhausted, preflight returns `decision: "paid"` with the amount required for AO
settlement.

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

## Signed Paid Requests

`hyperbalance` does not define a new paid-service wire standard. The reusable
pattern is:

- sign the service call as a normal HyperBEAM HTTP message, usually with
  `httpsig@1.0`;
- let the node's P4/service overlay identify the signer and charge its local
  ledger;
- use `hyperbalance` to discover the payment profile, check or fund the signer
  balance, send the signed request, and optionally read the post-call balance.

The current Permaweb request primitive for signed HyperBEAM calls is
`@permaweb/ao-core-libs`:

```ts
import AOCore from "@permaweb/ao-core-libs"
import { readFile } from "node:fs/promises"
import {
  HyperbalanceClient,
  arweaveAddressFromJwk,
  createAoCoreRequestSender,
} from "@permaweb/hyperbalance"

const nodeUrl = "https://hyperbeam.example.com"
const wallet = JSON.parse(process.env.ARWEAVE_WALLET_JSON!)
const signerAddress = await arweaveAddressFromJwk(wallet)
const aoCore = AOCore.init({
  jwk: wallet,
  url: nodeUrl,
})

const client = new HyperbalanceClient({ nodeUrl })
const audio = await readFile("/tmp/audio.wav")

const result = await client.paidRequest({
  fields: {
    path: "/~whisper@1.0/transcribe",
    method: "POST",
    data: audio,
  },
  minimumBalance: BigInt(audio.byteLength),
  send: createAoCoreRequestSender(aoCore),
  signerAddress,
})

console.log(result.response.status)
console.log(result.before.value, result.after?.value)
```

For quoted routes, pass `quote` instead of, or in addition to, an explicit
`minimumBalance`. For post-priced metered routes such as media ingest, use the
same work-unit estimate the node will meter, for example input byte length.

See [`examples/pay-rb-whisper.mjs`](examples/pay-rb-whisper.mjs) for a live rb
script that funds AO into `rb.mystical.computer` when needed. It runs in
fund/import mode by default; pass `--execute` only when explicitly testing the
JS signed-request transport against P4.

For a prefilled edit-and-run playground that does the full rb flow from one
Node entrypoint, including the Ruby "first five words" transform, use a local
`mystical.computer` checkout for the native HyperBEAM smoke signer:

```sh
npm run build
ARWEAVE_WALLET=/path/to/wallet.json node examples/rb-whisper-ruby-playground.mjs --verbose
```

All rb examples can be pointed at a local node without editing source:

```sh
HYPERBALANCE_NODE_URL=http://127.0.0.1:8734 \
HYPERBALANCE_GATEWAY_URL=http://127.0.0.1:9000 \
HYPERBALANCE_STATE_URL=http://127.0.0.1:9000 \
HYPERBALANCE_TRANSFER_MODE=mock \
node examples/rb-whisper-ruby-playground.mjs
```

`HYPERBALANCE_TRANSFER_MODE=mock` is for local compliance tests only. It still
exercises the node's AO payment import route, but expects the configured state
endpoint to serve matching mock AO schedule/result data.

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
- balances via the local `ledger~node-process@1.0`, or `~p4@1.0` when the
  node advertises a service-overlay AO payment ledger,
- deposit import via `ao-payment@1.0`.

The library should not hardcode:

- a specific deployment URL,
- a specific ledger process ID,
- deposit address equals operator address,
- upload byte price.

The library does assume AO for HyperBEAM bundler payments.
