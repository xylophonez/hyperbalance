export async function parseBalanceResponse(response: Response): Promise<bigint> {
  const contentType = response.headers.get("content-type") ?? ""
  const raw = await response.text()

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw) as unknown
    return parseBalanceValue(parsed)
  }

  return BigInt(raw.trim())
}

export async function parseQuoteResponse(
  response: Response,
): Promise<{ amount: bigint; ledgerId?: string; raw?: unknown; tokenId?: string }> {
  const contentType = response.headers.get("content-type") ?? ""
  const raw = await response.text()

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw) as unknown
    const quote = parseQuoteValue(parsed)
    return { ...quote, raw: parsed }
  }

  return { amount: BigInt(raw.trim()), raw }
}

function parseBalanceValue(value: unknown): bigint {
  if (typeof value === "bigint") return value
  if (typeof value === "number") return BigInt(value)
  if (typeof value === "string") return BigInt(value)

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["balance", "value", "amount", "ok"]) {
      if (key in record) return parseBalanceValue(record[key])
    }
  }

  throw new Error("Could not parse ledger balance response")
}

function parseQuoteValue(value: unknown): { amount: bigint; ledgerId?: string; tokenId?: string } {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return { amount: BigInt(value) }
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const amountKey = ["amount", "price", "quote", "value", "ok"].find((key) => key in record)
    if (!amountKey) {
      throw new Error("Could not parse quote amount response")
    }

    const quote = parseQuoteValue(record[amountKey])
    const ledgerId = typeof record.ledgerId === "string" ? record.ledgerId : undefined
    const tokenId = typeof record.tokenId === "string" ? record.tokenId : undefined
    return {
      amount: quote.amount,
      ...(ledgerId !== undefined && { ledgerId }),
      ...(tokenId !== undefined && { tokenId }),
    }
  }

  throw new Error("Could not parse quote amount response")
}
