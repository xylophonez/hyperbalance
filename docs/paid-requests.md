# Signed Paid HyperBEAM Requests

The existing protocol pieces are enough for paid HyperBEAM services:

1. A caller sends a signed HyperBEAM request, normally `httpsig@1.0`.
2. The node-side P4/service overlay reads the signer from the committed request.
3. Pricing/metering devices estimate or price the work.
4. The configured ledger checks and charges the signer.
5. Funding is handled by AO transfer plus the node's deposit import route.

That means clients do not need a second paid-request standard. They need an SDK
that composes these pieces:

- discover node payment metadata;
- derive the signer address;
- check local ledger balance;
- optionally fund via AO and import the deposit;
- send the signed HyperBEAM request through AO Core or an equivalent signer;
- read the post-call balance when useful.

`hyperbalance` now exposes that composition as `HyperbalanceClient.paidRequest`.
The signed transport is deliberately injected as `send(fields)`. A production
client should use a HyperBEAM-compatible `httpsig@1.0` request encoder. The rb
examples use `@permaweb/aoconnect` for both AO token transfers and signed
HyperBEAM requests, so they do not require a local HyperBEAM application repo
checkout.

For fixed-price or quotable routes, call `paidRequest` with `quote`. For dynamic
media devices such as Whisper and FFmpeg, call it with `minimumBalance` based on
the same work unit the node meters, currently input byte length.
