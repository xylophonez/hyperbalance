#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
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
import { createDataItemSigner, message as aoMessage } from "@permaweb/aoconnect"

const WALLET = expandHome(
  envFirst("HYPERBALANCE_WALLET", "ARWEAVE_WALLET", "PATH_TO_WALLET", "WALLET") ??
    "~/.aos.json",
)
const TX = process.env.WHISPER_TX ?? process.env.TX ?? "4ozZ6AVifuOCR2wwtSZejKUagx9KGCeICrBr5-reOwU"
const NODE = trimTrailingSlash(
  envFirst("HYPERBALANCE_NODE_URL", "HB_NODE") ?? "https://rb.mystical.computer",
)
const GATEWAY = trimTrailingSlash(
  envFirst("HYPERBALANCE_GATEWAY_URL", "WHISPER_GATEWAY") ?? "https://arweave.net",
)
const LANGUAGE = process.env.WHISPER_LANGUAGE ?? "auto"
const MYSTICAL = expandHome(
  envFirst("HYPERBALANCE_MYSTICAL_REPO", "MYSTICAL_REPO") ?? "/home/fn/Dev/mystical.computer",
)
const STATE_URL = trimTrailingSlash(
  envFirst("HYPERBALANCE_STATE_URL", "AO_STATE_URL") ?? "https://state.forward.computer",
)
const TOKEN_ID = envFirst("AO_TOKEN_ID") ?? DEFAULT_AO_TOKEN_ID
const TRANSFER_MODE = String(
  envFirst("HYPERBALANCE_TRANSFER_MODE", "TRANSFER_MODE") ?? "ao",
).toLowerCase()
const MOCK_MESSAGE_ID =
  envFirst("HYPERBALANCE_MOCK_MESSAGE_ID", "MOCK_MESSAGE_ID") ?? "local-hyperbalance-payment"
const MOCK_SLOT = envFirst("HYPERBALANCE_MOCK_SLOT", "MOCK_SLOT") ?? "1"

const wallet = JSON.parse(await readFile(WALLET, "utf8"))
const address = await arweaveAddressFromJwk(wallet)
const profile = await discoverHyperbeamAoBundlerProfile({
  nodeUrl: NODE,
  tokenId: TOKEN_ID,
})
const client = new HyperbalanceClient({ nodeUrl: NODE })
const signer = createDataItemSigner(wallet)
const audioUrl = `${GATEWAY}/${TX}`
const size = await contentLength(audioUrl)
const minimumBalance = BigInt(envFirst("HYPERBALANCE_MINIMUM_BALANCE", "MINIMUM_BALANCE") ?? size)

await client.ensureCreditAuto({
  minimumBalance,
  profile,
  recipient: address,
  tokenId: TOKEN_ID,
  transferAdapter: buildTransferAdapter({ address, signer }),
})

const whisper = runWhisper()
const transform = await countWordsWithRuby(whisper.response)

console.log(
  JSON.stringify(
    {
      tx: TX,
      wordCount: transform.wordCount,
      ruby: {
        body: transform.body,
        status: transform.status,
      },
      whisper: {
        language: whisper.response.language,
        status: whisper.status,
        transcript: whisper.response.transcript,
      },
    },
    undefined,
    2,
  ),
)

function runWhisper() {
  const out = spawnSync(`${MYSTICAL}/scripts/rb-whisper-smoke.sh`, {
    cwd: MYSTICAL,
    encoding: "utf8",
    env: {
      ...process.env,
      WALLET_FILE: WALLET,
      TX_ID: TX,
      HB_NODE: NODE,
      WHISPER_GATEWAY: GATEWAY,
      WHISPER_LANGUAGE: LANGUAGE,
    },
  })

  if (out.status !== 0) throw new Error(out.error?.message || out.stderr || out.stdout)

  const status = Number(out.stdout.match(/^status=(\d+)$/m)?.[1])
  const body = out.stdout.match(/^body=(.*)$/m)?.[1]
  if (!body) throw new Error(`Whisper smoke output did not include a body:\n${out.stdout}`)
  if (status !== 200) throw new Error(`Whisper request failed: ${status}\n${body}`)

  const response = parseJson(body)
  if (!response?.transcript) throw new Error(`Whisper response did not include a transcript:\n${body}`)

  return { body, response, status }
}

async function countWordsWithRuby(whisperResponse) {
  const rubyCode =
    'module AOProcess; def self.count_words(process,message,opts); t = process["transcript"] || message["transcript"] || ""; c = t.to_s.split.length; {"body" => c.to_s, "content-type" => "text/plain", "word-count" => c}; end; end'
  const moduleMap = [
    `body=:${Buffer.from(rubyCode).toString("base64")}:`,
    `content-type=:${Buffer.from("application/ruby").toString("base64")}:`,
  ].join(",")
  const url = new URL("/~ruby@mruby-3.3a/count_words", NODE)
  url.searchParams.set("module+map", moduleMap)
  url.searchParams.set("transcript", whisperResponse.transcript)
  if (whisperResponse.language) url.searchParams.set("language", whisperResponse.language)

  const response = await freshTextGet(url, { accept: "text/plain", connection: "close" })
  const body = response.body.trim()
  if (!response.ok) {
    throw new Error(`Ruby word-count transform failed: ${response.status} ${response.statusText}\n${body}`)
  }

  const wordCount = Number(body)
  if (!Number.isInteger(wordCount)) {
    throw new Error(`Ruby word-count transform returned a non-integer body:\n${body}`)
  }

  return {
    body,
    status: response.status,
    wordCount,
  }
}

function freshTextGet(url, headers) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest
    const req = transport(url, { agent: false, headers, method: "GET" }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const status = res.statusCode ?? 0
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? "",
        })
      })
    })
    req.on("error", reject)
    req.end()
  })
}

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

function buildTransferAdapter({ address, signer }) {
  if (["local", "local-mock", "mock"].includes(TRANSFER_MODE)) {
    return {
      kind: "ao",
      inferSender: async () => address,
      transfer: async (request) => ({
        messageId: MOCK_MESSAGE_ID,
        raw: {
          amount: request.amount.toString(),
          depositAddress: request.depositAddress,
          mode: TRANSFER_MODE,
          recipient: request.recipient,
        },
        sender: request.sender ?? address,
        slot: MOCK_SLOT,
      }),
    }
  }

  if (TRANSFER_MODE !== "ao") {
    throw new Error(`Unsupported transfer mode: ${TRANSFER_MODE}`)
  }

  return new AoTokenTransferAdapter({
    inferSender: async () => address,
    message: (input) => aoMessage({ data: "", process: input.process, signer, tags: input.tags }),
    waitForAssignmentSlot: (messageId, ctx) =>
      waitForAoAssignmentSlot({ messageId, pollMs: 5000, processId: ctx.processId, stateUrl: STATE_URL }),
  })
}

function envFirst(...names) {
  for (const name of names) {
    if (process.env[name] !== undefined && process.env[name] !== "") return process.env[name]
  }
  return undefined
}
