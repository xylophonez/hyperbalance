import { discoverPaymentProfile, normalizeNodeUrl } from "./discovery.js"
import { PaymentRequiredError } from "./errors.js"
import { getLedger, getToken } from "./lookup.js"
import { parseBalanceResponse, parseQuoteResponse } from "./parse.js"
import { applyTemplate, applyTemplateMap } from "./templates.js"
import type {
  Balance,
  BalanceRequest,
  DiscoveryOptions,
  EnsureCreditAutoRequest,
  EnsureCreditRequest,
  FetchLike,
  FundingTarget,
  FundingResult,
  HyperbalanceClientOptions,
  HyperbalanceProfile,
  ImportDepositRequest,
  Quote,
  QuoteAutoRequest,
  QuoteRequest,
  TokenTransferRequest,
} from "./types.js"

export class HyperbalanceClient {
  readonly fetch: FetchLike
  readonly nodeUrl: string

  constructor(options: HyperbalanceClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.nodeUrl = normalizeNodeUrl(options.nodeUrl)
  }

  discover(options: DiscoveryOptions = {}): Promise<HyperbalanceProfile> {
    return discoverPaymentProfile(this.nodeUrl, { ...options, fetch: this.fetch })
  }

  async getBalance(request: BalanceRequest): Promise<Balance> {
    const ledger = getLedger(request.profile, request.ledgerId)
    const path = applyTemplate(ledger.balancePath, { address: request.address })
    const response = await this.fetch(this.absoluteUrl(path), {
      headers: { accept: "application/json, text/plain" },
    })

    if (response.status === 404) {
      return {
        address: request.address,
        ledger,
        value: 0n,
      }
    }

    if (!response.ok) {
      throw new Error(`Balance request failed: ${response.status} ${response.statusText}`)
    }

    return {
      address: request.address,
      ledger,
      value: await parseBalanceResponse(response),
    }
  }

  async ensureCredit(request: EnsureCreditRequest): Promise<FundingResult> {
    const token = getToken(request.profile, request.tokenId)
    const ledger = getLedger(request.profile, request.ledgerId)
    const before = await this.getBalance({
      address: request.recipient,
      ledgerId: ledger.id,
      profile: request.profile,
    })

    if (before.value >= request.minimumBalance) {
      return {
        after: before,
        before,
        shortfall: 0n,
      }
    }

    const shortfall = request.minimumBalance - before.value
    const depositAddress = token.depositAddress ?? request.profile.node?.operator
    if (!depositAddress) {
      throw new PaymentRequiredError(
        "Payment is required, but the node did not advertise a deposit address",
        request.minimumBalance,
        before.value,
      )
    }

    if (token.transfer?.kind && token.transfer.kind !== request.transferAdapter.kind) {
      throw new Error(
        `Transfer adapter kind mismatch: token expects ${token.transfer.kind}, got ${request.transferAdapter.kind}`,
      )
    }

    const sender = await request.transferAdapter.inferSender?.()
    const transferRequest: TokenTransferRequest = {
      amount: shortfall,
      depositAddress,
      recipient: request.recipient,
      token,
    }
    if (sender !== undefined) transferRequest.sender = sender
    const transfer = await request.transferAdapter.transfer(transferRequest)

    const importRequest: ImportDepositRequest = {
      amount: shortfall,
      ledger,
      profile: request.profile,
      recipient: request.recipient,
      token,
      transfer,
    }
    const importSender = transfer.sender ?? sender
    if (importSender !== undefined) importRequest.sender = importSender
    const imported = await this.importDeposit(importRequest)

    const after = await this.getBalance({
      address: request.recipient,
      ledgerId: ledger.id,
      profile: request.profile,
    })

    return {
      after,
      before,
      imported,
      shortfall,
      transfer,
    }
  }

  async ensureCreditAuto(request: EnsureCreditAutoRequest): Promise<FundingResult> {
    const profile = request.profile ?? (await this.discover())
    const targetOptions: { ledgerId?: string; tokenId?: string; transferKind?: string } = {
      transferKind: request.transferAdapter.kind,
    }
    if (request.ledgerId !== undefined) targetOptions.ledgerId = request.ledgerId
    if (request.tokenId !== undefined) targetOptions.tokenId = request.tokenId
    const { ledger, token } = selectFundingTarget(profile, targetOptions)

    return this.ensureCredit({
      ledgerId: ledger.id,
      minimumBalance: request.minimumBalance,
      profile,
      recipient: request.recipient,
      tokenId: token.id,
      transferAdapter: request.transferAdapter,
    })
  }

  async quote(request: QuoteRequest): Promise<Quote> {
    const descriptor = request.profile.pricing?.find(
      (candidate) => candidate.action === request.action,
    )
    if (!descriptor?.quotePath) {
      throw new Error(`No quote path advertised for action: ${request.action}`)
    }

    const values = request.params ?? {}
    const url = new URL(this.absoluteUrl(applyTemplate(descriptor.quotePath, values)))
    for (const [key, value] of Object.entries(applyTemplateMap(descriptor.query, values))) {
      url.searchParams.set(key, value)
    }

    const bodyValues = applyTemplateMap(descriptor.body, values)
    const hasBody = Object.keys(bodyValues).length > 0
    const init: RequestInit = {
      headers: { accept: "application/json, text/plain" },
      method: descriptor.method ?? (hasBody ? "POST" : "GET"),
    }
    if (hasBody) {
      init.body = JSON.stringify(bodyValues)
      init.headers = { ...init.headers, "content-type": "application/json" }
    }

    const response = await this.fetch(url, init)
    if (!response.ok) {
      throw new Error(`Quote request failed: ${response.status} ${response.statusText}`)
    }

    return parseQuoteResponse(response)
  }

  async quoteAuto(request: QuoteAutoRequest): Promise<Quote> {
    const quoteRequest: QuoteRequest = {
      action: request.action,
      profile: request.profile ?? (await this.discover()),
    }
    if (request.params !== undefined) quoteRequest.params = request.params
    return this.quote(quoteRequest)
  }

  async importDeposit(request: ImportDepositRequest): Promise<unknown> {
    const descriptor = request.token.import
    if (!descriptor) {
      throw new Error(`Token does not advertise a deposit import flow: ${request.token.id}`)
    }

    const values = {
      ledgerId: request.ledger.id,
      messageId: request.transfer.messageId,
      quantity: request.amount,
      recipient: request.recipient,
      sender: request.sender,
      slot: request.transfer.slot,
      tokenId: request.token.id,
    }

    const url = new URL(this.absoluteUrl(descriptor.path))
    for (const [key, value] of Object.entries(applyTemplateMap(descriptor.query, values))) {
      url.searchParams.set(key, value)
    }

    const bodyValues = applyTemplateMap(descriptor.body, values)
    const hasBody = Object.keys(bodyValues).length > 0
    const init: RequestInit = {
      method: descriptor.method ?? "POST",
    }
    if (hasBody) {
      init.body = JSON.stringify(bodyValues)
      init.headers = { "content-type": "application/json" }
    }

    const response = await this.fetch(url, init)

    if (!response.ok) {
      throw new Error(`Deposit import failed: ${response.status} ${response.statusText}`)
    }

    const text = await response.text()
    if (!text.trim()) return undefined

    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  private absoluteUrl(pathOrUrl: string): string {
    if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl
    return `${this.nodeUrl}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`
  }
}

export function selectFundingTarget(
  profile: HyperbalanceProfile,
  options: { ledgerId?: string; tokenId?: string; transferKind?: string } = {},
): FundingTarget {
  const token = options.tokenId
    ? getToken(profile, options.tokenId)
    : profile.tokens.find(
        (candidate) =>
          (!options.transferKind || candidate.transfer?.kind === options.transferKind) &&
          (!options.ledgerId || candidate.ledgerId === options.ledgerId),
      )

  if (!token) {
    throw new Error("No matching funding token found in payment profile")
  }

  const ledgerId = options.ledgerId ?? token.ledgerId
  if (!ledgerId) {
    throw new Error(`Funding token does not specify a ledger: ${token.id}`)
  }

  return {
    ledger: getLedger(profile, ledgerId),
    token,
  }
}
