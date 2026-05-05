import type { HyperbalanceProfile, LedgerDescriptor, TokenDescriptor } from "./types.js"

export function getLedger(profile: HyperbalanceProfile, ledgerId: string): LedgerDescriptor {
  const ledger = profile.ledgers.find((candidate) => candidate.id === ledgerId)
  if (!ledger) {
    throw new Error(`Ledger not found in payment profile: ${ledgerId}`)
  }

  return ledger
}

export function getToken(profile: HyperbalanceProfile, tokenId: string): TokenDescriptor {
  const token = profile.tokens.find((candidate) => candidate.id === tokenId)
  if (!token) {
    throw new Error(`Token not found in payment profile: ${tokenId}`)
  }

  return token
}

