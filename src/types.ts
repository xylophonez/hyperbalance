export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface HyperbalanceClientOptions {
  fetch?: FetchLike
  nodeUrl: string
}

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
  query?: Record<string, string>
  quotePath?: string
}

export interface PricedAction {
  name: string
  params?: Record<string, string | number | bigint | boolean>
}

export interface Quote {
  amount: bigint
  ledgerId?: string
  raw?: unknown
  tokenId?: string
}

export interface QuoteRequest {
  action: string
  params?: Record<string, string | number | bigint | boolean>
  profile: HyperbalanceProfile
}

export interface QuoteAutoRequest {
  action: string
  params?: Record<string, string | number | bigint | boolean>
  profile?: HyperbalanceProfile
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
