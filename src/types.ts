export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface HyperbalanceClientOptions {
  fetch?: FetchLike
  nodeUrl: string
}

export type HyperbeamSigningFormat = "httpsig" | "ans104"

export type HyperbeamRequestValue =
  | ArrayBuffer
  | Blob
  | Uint8Array
  | bigint
  | boolean
  | number
  | string
  | undefined
  | readonly HyperbeamRequestValue[]
  | { readonly [key: string]: HyperbeamRequestValue }

export interface HyperbeamSignedRequestFields {
  path: string
  method?: string
  "signing-format"?: HyperbeamSigningFormat
  [field: string]: HyperbeamRequestValue
}

export type SignedHyperbeamRequestSender = (
  fields: HyperbeamSignedRequestFields,
) => Promise<Response>

export interface DiscoveryOptions {
  paths?: readonly string[]
}

export interface HyperbalanceProfile {
  version: string
  node?: PaymentNodeDescriptor
  ledgers: LedgerDescriptor[]
  tokens: TokenDescriptor[]
  pricing?: PricingDescriptor[]
}

export interface PaymentNodeDescriptor {
  operator?: string
  url?: string
}

export interface LedgerDescriptor {
  balancePath: string
  id: string
  route?: string
  /**
   * Balance path of the ledger that settlement actually charges and that deposit
   * imports credit. Set this when `balancePath` reports an aggregated display
   * balance (e.g. a p4 waterfall reporting `max(recharge-ledger, ao-payment)`):
   * top-ups are sized against this ledger so the non-additive fallback can cover
   * the full request. When absent, `balancePath` is used to size top-ups.
   */
  settlementBalancePath?: string
  type: string
  unit?: string
}

export interface TokenDescriptor {
  decimals?: number
  depositAddress?: string
  id: string
  import?: PaymentImportDescriptor
  ledgerId?: string
  network?: string
  ticker?: string
  transfer?: PaymentTransferDescriptor
}

export interface PaymentTransferDescriptor {
  kind: string
  processId?: string
  tags?: Record<string, string>
}

export interface PaymentImportDescriptor {
  body?: Record<string, string>
  method?: "GET" | "POST"
  path: string
  query?: Record<string, string>
}

export interface PricingDescriptor {
  action: string
  method?: "GET" | "POST"
  body?: Record<string, string>
  preflightPath?: string
  query?: Record<string, string>
  quotePath?: string
  quoteSemantics?: PricingQuoteSemantics
  settlement?: PricingSettlementDescriptor
  subject?: PricingSubjectDescriptor
  zeroQuote?: PricingZeroQuoteDescriptor
}

export interface PricingQuoteSemantics {
  authority: "authoritative" | "advisory"
  notes?: readonly string[]
}

export interface PricingSubjectDescriptor {
  kind: "byte-count"
  param: string
  resource?: string
}

export interface PricingSettlementDescriptor {
  device?: string
  insufficientBalance?: "http-402"
  kind: "p4-ledger"
  pricedPaths?: readonly string[]
}

export interface PricingZeroQuoteDescriptor {
  exhaustedBehavior: "charged" | "blocked"
  kind: "conditional-free-tier" | "unconditional-free"
  limitParam?: string
  preflightConsumesQuota?: boolean
  quota?: PricingQuotaDescriptor
  quoteConsumesQuota?: boolean
  resource?: string
}

export interface PricingQuotaDescriptor {
  device: string
  identity?: "ip" | "signer" | "signer-or-ip"
  kind: "rate-limit"
  policyId?: string
}

export interface PricedAction {
  name: string
  params?: Record<string, string | number | bigint | boolean>
}

export interface Quote {
  advisories?: QuoteAdvisory[]
  amount: bigint
  ledgerId?: string
  raw?: unknown
  tokenId?: string
}

export type PreflightDecision = "free" | "paid" | "blocked" | "unknown"

export interface PreflightQuote extends Quote {
  bytes?: bigint
  decision: PreflightDecision
  exhaustedBehavior?: "charged" | "blocked"
  paymentRequired: boolean
}

export interface QuoteAdvisory {
  code: "conditional-free-tier"
  message: string
  severity: "info" | "warning"
}

export interface QuoteRequest {
  action: string
  params?: Record<string, string | number | bigint | boolean>
  profile: HyperbalanceProfile
}

export interface PreflightRequest {
  action: string
  params?: Record<string, string | number | bigint | boolean>
  profile: HyperbalanceProfile
  request: HyperbeamSignedRequestFields
}

export interface QuoteAutoRequest {
  action: string
  params?: Record<string, string | number | bigint | boolean>
  profile?: HyperbalanceProfile
}

export interface PreflightAutoRequest {
  action: string
  params?: Record<string, string | number | bigint | boolean>
  profile?: HyperbalanceProfile
  request: HyperbeamSignedRequestFields
}

export interface PaidRequestQuote {
  action: string
  params?: Record<string, string | number | bigint | boolean>
}

export interface BalanceRequest {
  address: string
  ledgerId: string
  profile: HyperbalanceProfile
}

export interface Balance {
  address: string
  ledger: LedgerDescriptor
  value: bigint
}

export interface TokenTransferRequest {
  amount: bigint
  depositAddress: string
  recipient: string
  sender?: string
  token: TokenDescriptor
}

export interface TokenTransferResult {
  messageId: string
  raw?: unknown
  sender?: string
  slot?: string | number
}

export interface TokenTransferAdapter {
  inferSender?: () => Promise<string>
  kind: string
  transfer: (request: TokenTransferRequest) => Promise<TokenTransferResult>
}

export interface EnsureCreditRequest {
  ledgerId: string
  minimumBalance: bigint
  profile: HyperbalanceProfile
  recipient: string
  tokenId: string
  transferAdapter: TokenTransferAdapter
}

export interface EnsureCreditAutoRequest {
  ledgerId?: string
  minimumBalance: bigint
  profile?: HyperbalanceProfile
  recipient: string
  tokenId?: string
  transferAdapter: TokenTransferAdapter
}

export interface FundingTarget {
  ledger: LedgerDescriptor
  token: TokenDescriptor
}

export interface FundingResult {
  after: Balance
  before: Balance
  imported?: unknown
  shortfall: bigint
  transfer?: TokenTransferResult
}

export interface ImportDepositRequest {
  amount: bigint
  ledger: LedgerDescriptor
  profile: HyperbalanceProfile
  recipient: string
  sender?: string
  token: TokenDescriptor
  transfer: TokenTransferResult
}

export interface PaidRequest {
  fields: HyperbeamSignedRequestFields
  ledgerId?: string
  minimumBalance?: bigint
  profile?: HyperbalanceProfile
  quote?: PaidRequestQuote
  readBalanceAfter?: boolean
  send: SignedHyperbeamRequestSender
  signerAddress: string
  tokenId?: string
  transferAdapter?: TokenTransferAdapter
}

export interface PaidRequestResult {
  after?: Balance
  before: Balance
  funding?: FundingResult
  minimumBalance: bigint
  quote?: Quote
  response: Response
  signerAddress: string
}
