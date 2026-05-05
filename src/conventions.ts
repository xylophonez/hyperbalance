import { normalizeNodeUrl } from "./discovery.js"
import type { FetchLike, HyperbalanceProfile } from "./types.js"

export const DEFAULT_AO_TOKEN_ID = "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc"
export const HYPERBEAM_AO_BUNDLER_QUOTE_ACTION = "hyperbeam-upload"
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
  const ledgerId = options.ledgerId ?? HYPERBEAM_DEFAULT_LEDGER_ID
  const ledgerRoute = options.ledgerRoute ?? HYPERBEAM_DEFAULT_LEDGER_ROUTE
  const tokenId = options.tokenId ?? DEFAULT_AO_TOKEN_ID
  const depositAddress = await fetchHyperbeamOperatorAddress(fetcher, nodeUrl)

  return {
    ledgers: [
      {
        balancePath: `${ledgerRoute}/now/balance/{address}`,
        id: ledgerId,
        route: ledgerRoute,
        type: "process-ledger@1.0",
        unit: "AO",
      },
    ],
    node: {
      operator: depositAddress,
      url: nodeUrl,
    },
    pricing: [
      {
        action: HYPERBEAM_AO_BUNDLER_QUOTE_ACTION,
        query: {
          amount: "{bytes}",
          resource: "arweave-bytes",
        },
        quotePath: "/~metering@1.0/quote",
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
          },
        },
      },
    ],
    version: "hyperbalance@0.1",
  }
}

async function fetchHyperbeamOperatorAddress(fetcher: FetchLike, nodeUrl: string): Promise<string> {
  const response = await fetcher(`${nodeUrl}/~meta@1.0/info/address`, {
    headers: { accept: "text/plain" },
  })

  if (!response.ok) {
    throw new Error(`HyperBEAM operator address request failed: ${response.status} ${response.statusText}`)
  }

  const address = (await response.text()).trim()
  if (!address) {
    throw new Error("HyperBEAM operator address response was empty")
  }

  return address
}
