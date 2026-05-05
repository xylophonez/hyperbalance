import { applyTemplateMap } from "../templates.js"
import type {
  PaymentTransferDescriptor,
  TokenDescriptor,
  TokenTransferAdapter,
  TokenTransferRequest,
  TokenTransferResult,
} from "../types.js"

export interface AoMessageInput {
  data?: string
  process: string
  tags: Array<{ name: string; value: string }>
}

export interface AoAdapterOptions {
  inferSender?: () => Promise<string>
  message: (input: AoMessageInput) => Promise<string>
  waitForAssignmentSlot?: (
    messageId: string,
    context: { processId: string },
  ) => Promise<string | number>
}

export interface AoAssignmentSlotOptions {
  fetch?: typeof globalThis.fetch
  messageId: string
  pollMs?: number
  processId: string
  stateUrl?: string
  timeoutMs?: number
}

export class AoTokenTransferAdapter implements TokenTransferAdapter {
  readonly kind = "ao"
  readonly inferSender?: () => Promise<string>

  constructor(private readonly options: AoAdapterOptions) {
    if (options.inferSender) {
      this.inferSender = options.inferSender
    }
  }

  async transfer(request: TokenTransferRequest): Promise<TokenTransferResult> {
    const transfer = request.token.transfer
    assertAoTransferDescriptor(request.token, transfer)

    const tags = buildAoTransferTags(request, transfer)
    const messageId = await this.options.message({
      data: "",
      process: transfer.processId,
      tags,
    })
    const slot = await this.options.waitForAssignmentSlot?.(messageId, {
      processId: transfer.processId,
    })

    const result: TokenTransferResult = { messageId }
    if (request.sender !== undefined) result.sender = request.sender
    if (slot !== undefined) result.slot = slot
    return result
  }
}

export async function waitForAoAssignmentSlot(
  options: AoAssignmentSlotOptions,
): Promise<string | number> {
  const fetcher = options.fetch ?? globalThis.fetch
  const stateUrl = (options.stateUrl ?? "https://state.forward.computer").replace(/\/+$/, "")
  const pollMs = options.pollMs ?? 5000
  const timeoutMs = options.timeoutMs ?? 360000
  const fromSlot = Math.max(0, (await currentSlot(fetcher, stateUrl, options.processId)) - 5)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const toSlot = (await currentSlot(fetcher, stateUrl, options.processId)) + 20
    const url =
      `${stateUrl}/${options.processId}~process@1.0/schedule` +
      `?from=${fromSlot}&to=${toSlot}&accept=application/aos-2`
    const response = await fetcher(url)
    if (!response.ok) {
      throw new Error(`AO schedule request failed: ${response.status} ${response.statusText}`)
    }

    const schedule = (await response.json()) as {
      edges?: Array<{
        node?: {
          assignment?: { Tags?: Array<{ name: string; value: string }> }
          message?: { Id?: string }
        }
      }>
    }

    for (const edge of schedule.edges ?? []) {
      if (edge.node?.message?.Id === options.messageId) {
        const slot = edge.node.assignment?.Tags?.find((tag) => tag.name === "Nonce")?.value
        if (!slot) {
          throw new Error(`AO assignment is missing Nonce for message ${options.messageId}`)
        }

        return slot
      }
    }

    await sleep(pollMs)
  }

  throw new Error(`AO message did not appear in schedule: ${options.messageId}`)
}

async function currentSlot(
  fetcher: typeof globalThis.fetch,
  stateUrl: string,
  processId: string,
): Promise<number> {
  const response = await fetcher(`${stateUrl}/${processId}~process@1.0/slot/current`)
  if (!response.ok) {
    throw new Error(`AO current slot request failed: ${response.status} ${response.statusText}`)
  }

  const text = await response.text()
  const match = text.match(/\d+/)
  if (!match) {
    throw new Error(`Could not parse AO current slot: ${text}`)
  }

  return Number(match[0])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function buildAoTransferTags(
  request: TokenTransferRequest,
  transfer: PaymentTransferDescriptor,
): Array<{ name: string; value: string }> {
  const tags = applyTemplateMap(transfer.tags, {
    depositAddress: request.depositAddress,
    quantity: request.amount,
    recipient: request.recipient,
    sender: request.sender,
    tokenId: request.token.id,
  })

  return Object.entries(tags).map(([name, value]) => ({ name, value }))
}

function assertAoTransferDescriptor(
  token: TokenDescriptor,
  transfer: PaymentTransferDescriptor | undefined,
): asserts transfer is PaymentTransferDescriptor & { processId: string } {
  if (!transfer) {
    throw new Error(`AO token does not advertise a transfer flow: ${token.id}`)
  }

  if (transfer.kind !== "ao") {
    throw new Error(`Token transfer kind is not AO: ${transfer.kind}`)
  }

  if (!transfer.processId) {
    throw new Error(`AO token is missing transfer.processId: ${token.id}`)
  }
}
