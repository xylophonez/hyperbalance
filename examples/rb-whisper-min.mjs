#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import {
  AoTokenTransferAdapter,
  DEFAULT_AO_TOKEN_ID,
  HyperbalanceClient,
  arweaveAddressFromJwk,
  discoverHyperbeamAoBundlerProfile,
  waitForAoAssignmentSlot,
} from "../dist/index.js"
import {
  connect,
  createDataItemSigner,
  createSigner,
  message as aoMessage,
} from "@permaweb/aoconnect"

const WALLET = expandHome(
  process.env.ARWEAVE_WALLET ?? process.env.PATH_TO_WALLET ?? "~/.aos.json",
)
const TX = process.env.WHISPER_TX ?? "4ozZ6AVifuOCR2wwtSZejKUagx9KGCeICrBr5-reOwU"
const NODE = trimTrailingSlash(process.env.HB_NODE ?? "https://rb.mystical.computer")
const GATEWAY = trimTrailingSlash(process.env.WHISPER_GATEWAY ?? "https://arweave.net")
const LANGUAGE = process.env.WHISPER_LANGUAGE ?? "auto"

const wallet = JSON.parse(await readFile(WALLET, "utf8"))
const address = await arweaveAddressFromJwk(wallet)
const profile = await discoverHyperbeamAoBundlerProfile({
  nodeUrl: NODE,
  tokenId: DEFAULT_AO_TOKEN_ID,
})
const client = new HyperbalanceClient({ nodeUrl: NODE })
const signer = createDataItemSigner(wallet)
const audioUrl = `${GATEWAY}/${TX}`
const size = await contentLength(audioUrl)
const { request } = connect({
  MODE: "mainnet",
  URL: NODE,
  signer: createSigner(wallet),
})

const result = await client.paidRequest({
  fields: {
    accept: "application/json, text/plain",
    gateway: GATEWAY,
    language: LANGUAGE,
    method: "GET",
    path: "/~whisper@1.0/transcribe",
    tx: TX,
  },
  minimumBalance: BigInt(size),
  profile,
  send: async (fields) => normalizeResponse(await request(fields)),
  signerAddress: address,
  tokenId: DEFAULT_AO_TOKEN_ID,
  transferAdapter: new AoTokenTransferAdapter({
    inferSender: async () => address,
    message: (input) =>
      aoMessage({ data: "", process: input.process, signer, tags: input.tags }),
    waitForAssignmentSlot: (messageId, ctx) =>
      waitForAoAssignmentSlot({ messageId, processId: ctx.processId }),
  }),
})

const body = await result.response.text()
if (!result.response.ok) {
  throw new Error(
    `Whisper request failed: ${result.response.status} ${result.response.statusText}\n${body}`,
  )
}

const parsed = parseJson(body)
console.log(String(parsed?.transcript ?? body).trim())

async function contentLength(url) {
  const head = await fetch(url, { method: "HEAD" }).catch(() => undefined)
  const length = head?.headers.get("content-length")
  if (head?.ok && length) return Number(length)
  return (await (await fetch(url)).arrayBuffer()).byteLength
}

function expandHome(value) {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2))
  return value
}

function normalizeResponse(value) {
  if (value instanceof Response) return value
  if (value?.headers && "body" in value) {
    return new Response(value.body ?? "", {
      headers: value.headers,
      status: value.status ?? 200,
      statusText: value.statusText,
    })
  }
  return new Response(JSON.stringify(value ?? null), {
    headers: { "content-type": "application/json" },
    status: 200,
  })
}

function parseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "")
}
