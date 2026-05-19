export interface ArweaveJwkLike {
  n: string
}

export async function arweaveAddressFromJwk(jwk: ArweaveJwkLike): Promise<string> {
  return arweaveAddressFromPublicKey(jwk.n)
}

export async function arweaveAddressFromPublicKey(
  publicKey: string | Uint8Array,
): Promise<string> {
  const bytes = typeof publicKey === "string" ? base64UrlToBytes(publicKey) : publicKey
  const digestInput = new Uint8Array(bytes).buffer as ArrayBuffer
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput)
  return bytesToBase64Url(new Uint8Array(digest))
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  )
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
