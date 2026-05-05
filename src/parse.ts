export async function parseBalanceResponse(response: Response): Promise<bigint> {
  const contentType = response.headers.get("content-type") ?? ""
  const raw = await response.text()

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw) as unknown
    return parseBalanceValue(parsed)
  }

  return BigInt(raw.trim())
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

