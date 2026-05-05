import { MissingDiscoveryError } from "./errors.js"
import type { DiscoveryOptions, FetchLike, HyperbalanceProfile } from "./types.js"

export const DEFAULT_DISCOVERY_PATHS = [
  "/.well-known/hyperbalance",
  "/~payments@1.0/info",
  "/~hyperbalance@1.0/info",
] as const

export function normalizeNodeUrl(nodeUrl: string): string {
  return nodeUrl.replace(/\/+$/, "")
}

export async function discoverPaymentProfile(
  nodeUrl: string,
  options: DiscoveryOptions & { fetch?: FetchLike } = {},
): Promise<HyperbalanceProfile> {
  const fetcher = options.fetch ?? globalThis.fetch
  const base = normalizeNodeUrl(nodeUrl)
  const paths = options.paths ?? DEFAULT_DISCOVERY_PATHS
  const attemptedUrls: string[] = []

  for (const path of paths) {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`
    attemptedUrls.push(url)

    const response = await fetcher(url, { headers: { accept: "application/json" } }).catch(
      () => undefined,
    )

    if (!response?.ok) continue

    const profile = (await response.json()) as HyperbalanceProfile
    validateProfile(profile)
    return profile
  }

  throw new MissingDiscoveryError(attemptedUrls)
}

function validateProfile(profile: HyperbalanceProfile): void {
  if (!profile || typeof profile !== "object") {
    throw new Error("Invalid hyperbalance profile: expected object")
  }

  if (!Array.isArray(profile.ledgers)) {
    throw new Error("Invalid hyperbalance profile: ledgers must be an array")
  }

  if (!Array.isArray(profile.tokens)) {
    throw new Error("Invalid hyperbalance profile: tokens must be an array")
  }
}

