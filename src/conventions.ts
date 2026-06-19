import { normalizeNodeUrl } from "./discovery.js"
import type { FetchLike, HyperbalanceProfile } from "./types.js"

export const DEFAULT_AO_TOKEN_ID = "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc"
export const HYPERBEAM_AO_BUNDLER_QUOTE_ACTION = "hyperbeam-upload"
export const HYPERBEAM_BUNDLER_FREE_TIER_POLICY_ID = "bundler-free-tier"
export const HYPERBEAM_DEFAULT_LEDGER_ID = "default"
export const HYPERBEAM_DEFAULT_LEDGER_ROUTE = "/ledger~node-process@1.0"

export interface HyperbeamAoBundlerProfileOptions {
  fetch?: FetchLike
  ledgerId?: string
  ledgerRoute?: string
  nodeUrl: string
  tokenId?: string
}

export async function discoverHyperbeamAoBundlerProfile(
  options: HyperbeamAoBundlerProfileOptions,
): Promise<HyperbalanceProfile> {
  const fetcher = options.fetch ?? globalThis.fetch
  const nodeUrl = normalizeNodeUrl(options.nodeUrl)
  const tokenId = options.tokenId ?? DEFAULT_AO_TOKEN_ID
  const operator = await fetchRequiredHyperbeamText(
    fetcher,
    nodeUrl,
    "/~meta@1.0/info/address",
    "operator address",
  )
  const depositAddress =
    (await fetchOptionalHyperbeamText(
      fetcher,
      nodeUrl,
      "/~meta@1.0/info/ao-payment-deposit-address",
    )) ?? operator
  const advertisedLedgerId = await fetchOptionalHyperbeamText(
    fetcher,
    nodeUrl,
    "/~meta@1.0/info/ao-payment-ledger",
  )
  const ledgerId = options.ledgerId ?? advertisedLedgerId ?? HYPERBEAM_DEFAULT_LEDGER_ID
  const ledgerRoute = options.ledgerRoute ?? HYPERBEAM_DEFAULT_LEDGER_ROUTE
  const balancePath =
    options.ledgerRoute === undefined && advertisedLedgerId
      ? "/~p4@1.0/balance?target={address}"
      : `${ledgerRoute}/now/balance/{address}`

  return {
    ledgers: [
      {
        balancePath,
        id: ledgerId,
        route: ledgerRoute,
        type: "process-ledger@1.0",
        unit: "AO",
      },
    ],
    node: {
      operator,
      url: nodeUrl,
    },
    pricing: [
      {
        action: HYPERBEAM_AO_BUNDLER_QUOTE_ACTION,
        query: {
          amount: "{bytes}",
          resource: "arweave-bytes",
        },
        quotePath: "/~arweave-byte-pricing@1.0/quote",
        preflightPath: "/~arweave-byte-pricing@1.0/preflight",
        quoteSemantics: {
          authority: "advisory",
          notes: [
            "Amount-only quotes are a guaranteed paid fallback when free-tier quota is conditional.",
            "Use the preflight path with the exact signed bundler request to reserve and display free-tier eligibility before upload.",
          ],
        },
        settlement: {
          device: "p4@1.0",
          insufficientBalance: "http-402",
          kind: "p4-ledger",
          pricedPaths: ["/~bundler@1.0/item", "/~bundler@1.0/tx"],
        },
        subject: {
          kind: "byte-count",
          param: "bytes",
          resource: "arweave-bytes",
        },
        zeroQuote: {
          exhaustedBehavior: "charged",
          kind: "conditional-free-tier",
          limitParam: "bytes",
          quota: {
            device: "trundler@1.0",
            identity: "signer-or-ip",
            kind: "rate-limit",
            policyId: HYPERBEAM_BUNDLER_FREE_TIER_POLICY_ID,
          },
          quoteConsumesQuota: false,
          preflightConsumesQuota: true,
          resource: "arweave-bytes",
        },
      },
    ],
    tokens: [
      {
        decimals: 12,
        depositAddress,
        id: tokenId,
        import: {
          method: "POST",
          path: "/~ao-payment@1.0/ingest",
          query: {
            ledger: "{ledgerId}",
            "message-id": "{messageId}",
            quantity: "{quantity}",
            recipient: "{recipient}",
            sender: "{sender}",
            slot: "{slot}",
            token: "{tokenId}",
          },
        },
        ledgerId,
        network: "ao",
        ticker: "AO",
        transfer: {
          kind: "ao",
          processId: tokenId,
          tags: {
            Action: "Transfer",
            Quantity: "{quantity}",
            Recipient: "{depositAddress}",
            "X-HB-Recipient": "{recipient}",
          },
        },
      },
    ],
    version: "hyperbalance@0.1",
  }
}

async function fetchRequiredHyperbeamText(
  fetcher: FetchLike,
  nodeUrl: string,
  path: string,
  label: string,
): Promise<string> {
  const response = await fetcher(`${nodeUrl}${path}`, {
    headers: { accept: "text/plain" },
  })

  if (!response.ok) {
    throw new Error(`HyperBEAM ${label} request failed: ${response.status} ${response.statusText}`)
  }

  const value = (await response.text()).trim()
  if (!value) {
    throw new Error(`HyperBEAM ${label} response was empty`)
  }

  return value
}

async function fetchOptionalHyperbeamText(
  fetcher: FetchLike,
  nodeUrl: string,
  path: string,
): Promise<string | undefined> {
  const response = await fetcher(`${nodeUrl}${path}`, {
    headers: { accept: "text/plain" },
  })

  if (!response.ok) {
    return undefined
  }

  return (await response.text()).trim() || undefined
}
