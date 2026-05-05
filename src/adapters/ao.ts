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
  waitForAssignmentSlot?: (messageId: string) => Promise<string | number>
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
    const slot = await this.options.waitForAssignmentSlot?.(messageId)

    const result: TokenTransferResult = { messageId }
    if (request.sender !== undefined) result.sender = request.sender
    if (slot !== undefined) result.slot = slot
    return result
  }
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
