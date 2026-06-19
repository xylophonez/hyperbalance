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
  PaidRequest,
  PaidRequestQuote,
  PaidRequestResult,
  PreflightAutoRequest,
  PreflightDecision,
  PreflightQuote,
  PreflightRequest,
  PricingDescriptor,
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

    return annotateQuote(await parseQuoteResponse(response), descriptor)
  }

  async quoteAuto(request: QuoteAutoRequest): Promise<Quote> {
    const quoteRequest: QuoteRequest = {
      action: request.action,
      profile: request.profile ?? (await this.discover()),
    }
    if (request.params !== undefined) quoteRequest.params = request.params
    return this.quote(quoteRequest)
  }

  async preflight(request: PreflightRequest): Promise<PreflightQuote> {
    const descriptor = request.profile.pricing?.find(
      (candidate) => candidate.action === request.action,
    )
    const preflightPath = descriptor?.preflightPath ?? preflightPathFromQuotePath(descriptor)
    if (!descriptor || !preflightPath) {
      throw new Error(`No preflight path advertised for action: ${request.action}`)
    }

    const values = request.params ?? {}
    const body = {
      ...applyTemplateMap(descriptor.query, values),
      request: request.request,
    }
    const response = await this.fetch(this.absoluteUrl(preflightPath), {
      body: JSON.stringify(body, hyperbeamJsonReplacer),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    })

    if (!response.ok) {
      throw new Error(`Preflight request failed: ${response.status} ${response.statusText}`)
    }

    return annotatePreflight(await parsePreflightQuoteResponse(response), descriptor)
  }

  async preflightAuto(request: PreflightAutoRequest): Promise<PreflightQuote> {
    const preflightRequest: PreflightRequest = {
      action: request.action,
      profile: request.profile ?? (await this.discover()),
      request: request.request,
    }
    if (request.params !== undefined) preflightRequest.params = request.params
    return this.preflight(preflightRequest)
  }

  async paidRequest(request: PaidRequest): Promise<PaidRequestResult> {
    const profile = request.profile ?? (await this.discover())
    const targetOptions: { ledgerId?: string; tokenId?: string; transferKind?: string } = {}
    if (request.ledgerId !== undefined) targetOptions.ledgerId = request.ledgerId
    if (request.tokenId !== undefined) targetOptions.tokenId = request.tokenId
    if (request.transferAdapter !== undefined) targetOptions.transferKind = request.transferAdapter.kind
    const { ledger, token } = selectFundingTarget(profile, targetOptions)

    const quoted = request.quote ? await this.quote(buildQuoteRequest(profile, request.quote)) : undefined
    const minimumBalance = maxBigint(request.minimumBalance ?? 0n, quoted?.amount ?? 0n)
    let before = await this.getBalance({
      address: request.signerAddress,
      ledgerId: ledger.id,
      profile,
    })

    let funding: FundingResult | undefined
    if (before.value < minimumBalance) {
      if (!request.transferAdapter) {
        throw new PaymentRequiredError(
          "Payment is required, but no transfer adapter was provided",
          minimumBalance,
          before.value,
        )
      }

      funding = await this.ensureCredit({
        ledgerId: ledger.id,
        minimumBalance,
        profile,
        recipient: request.signerAddress,
        tokenId: token.id,
        transferAdapter: request.transferAdapter,
      })
      before = funding.after
    }

    const fields = { ...request.fields }
    fields["signing-format"] ??= "httpsig"
    const response = await request.send(fields)
    const after =
      request.readBalanceAfter === false
        ? undefined
        : await this.getBalance({
            address: request.signerAddress,
            ledgerId: ledger.id,
            profile,
          })

    return {
      ...(after !== undefined && { after }),
      before,
      ...(funding !== undefined && { funding }),
      minimumBalance,
      ...(quoted !== undefined && { quote: quoted }),
      response,
      signerAddress: request.signerAddress,
    }
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
      const body = (await response.text().catch(() => "")).trim()
      const details = body ? `: ${body}` : ""
      throw new Error(`Deposit import failed: ${response.status} ${response.statusText}${details}`)
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

function buildQuoteRequest(profile: HyperbalanceProfile, quote: PaidRequestQuote): QuoteRequest {
  const request: QuoteRequest = {
    action: quote.action,
    profile,
  }
  if (quote.params !== undefined) request.params = quote.params
  return request
}

function annotateQuote(quote: Quote, descriptor: PricingDescriptor): Quote {
  if (quote.amount !== 0n || descriptor.zeroQuote?.kind !== "conditional-free-tier") {
    return quote
  }

  return {
    ...quote,
    advisories: [
      ...(quote.advisories ?? []),
      {
        code: "conditional-free-tier",
        message:
          "Zero quote is conditional on the node's free-tier quota; the upload can still require payment if quota is exhausted.",
        severity: "warning",
      },
    ],
  }
}

async function parsePreflightQuoteResponse(response: Response): Promise<PreflightQuote> {
  const contentType = response.headers.get("content-type") ?? ""
  const rawText = await response.text()
  const raw = parseMaybeJson(rawText, contentType)
  const amount = parseRequiredBigint(
    readField(raw, "amount") ?? response.headers.get("amount") ?? rawText.trim(),
  )
  const ledgerId = parseOptionalString(readField(raw, "ledgerId") ?? response.headers.get("ledgerId"))
  const tokenId = parseOptionalString(readField(raw, "tokenId") ?? response.headers.get("tokenId"))
  const decision = parseDecision(readField(raw, "decision") ?? response.headers.get("decision"))
  const paymentRequired =
    parseBoolean(readField(raw, "payment-required") ?? response.headers.get("payment-required")) ??
    amount > 0n
  const bytes = parseOptionalBigint(readField(raw, "bytes") ?? response.headers.get("bytes"))
  const exhaustedBehavior = parseExhaustedBehavior(
    readField(raw, "exhausted-behavior") ?? response.headers.get("exhausted-behavior"),
  )

  return {
    amount,
    ...(bytes !== undefined && { bytes }),
    decision: decision ?? (amount === 0n ? "free" : "paid"),
    ...(exhaustedBehavior !== undefined && { exhaustedBehavior }),
    ...(ledgerId !== undefined && { ledgerId }),
    paymentRequired,
    raw: raw ?? rawText,
    ...(tokenId !== undefined && { tokenId }),
  }
}

function annotatePreflight(
  quote: PreflightQuote,
  descriptor: PricingDescriptor,
): PreflightQuote {
  if (quote.decision !== "free" || descriptor.zeroQuote?.kind !== "conditional-free-tier") {
    return quote
  }

  return {
    ...quote,
    advisories: [
      ...(quote.advisories ?? []),
      {
        code: "conditional-free-tier",
        message:
          "Free-tier eligibility was reserved for this exact request; retry with the same signed request or preflight again.",
        severity: "info",
      },
    ],
  }
}

function preflightPathFromQuotePath(descriptor: PricingDescriptor | undefined): string | undefined {
  if (!descriptor?.quotePath?.endsWith("/quote")) return undefined
  return `${descriptor.quotePath.slice(0, -"/quote".length)}/preflight`
}

function hyperbeamJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return Array.from(value)
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
  return value
}

function readField(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== "object") return undefined
  return (raw as Record<string, unknown>)[key]
}

function parseDecision(value: unknown): PreflightDecision | undefined {
  if (typeof value !== "string") return undefined
  if (value === "free" || value === "paid" || value === "blocked" || value === "unknown") {
    return value
  }
  return undefined
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value === "true") return true
    if (value === "false") return false
  }
  return undefined
}

function parseOptionalBigint(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value
  if (typeof value === "number") return BigInt(value)
  if (typeof value === "string" && value.trim()) return BigInt(value)
  return undefined
}

function parseRequiredBigint(value: unknown): bigint {
  const parsed = parseOptionalBigint(value)
  if (parsed === undefined) throw new Error("Could not parse preflight amount response")
  return parsed
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseMaybeJson(raw: string, contentType: string): unknown {
  if (!contentType.includes("application/json")) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function parseExhaustedBehavior(value: unknown): "charged" | "blocked" | undefined {
  if (value === "charged" || value === "blocked") return value
  return undefined
}

function maxBigint(left: bigint, right: bigint): bigint {
  return left > right ? left : right
}
