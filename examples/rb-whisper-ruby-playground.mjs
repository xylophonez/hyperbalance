#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Edit these defaults and rerun. CLI/env overrides are at the bottom.
const CONFIG = {
  nodeUrl: "https://rb.mystical.computer",
  walletPath: "~/.aos.json",
  stateUrl: "https://state.forward.computer",
  pollMs: 5000,
  timeoutMs: 360000,
  fundingMargin: 0n,
  sample: "small",
  samples: {
    hello: {
      tx: "9OaHLWDaAjSSBeGhYOyBm2BRG-SG5ppEt2rWi_z2AIs",
      gateway: "https://rb.mystical.computer",
      language: "en",
    },
    small: {
      tx: "4ozZ6AVifuOCR2wwtSZejKUagx9KGCeICrBr5-reOwU",
      gateway: "https://arweave.net",
      language: "auto",
    },
  },
  rubyCode:
    'module AOProcess; def self.first5(process,message,opts); text = process["transcript"] || message["transcript"] || ""; {"body" => text.split[0,5].join(" "), "content-type" => "text/plain"}; end; end',
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = parseArgs(process.argv.slice(2))

if (args.help) {
  printHelp()
  process.exit(0)
}

const hyperbalance = await import(path.join(__dirname, "../dist/index.js")).catch((error) => {
  throw new Error(`Build hyperbalance first with \`npm run build\`: ${error.message}`)
})

const {
  AoTokenTransferAdapter,
  DEFAULT_AO_TOKEN_ID,
  HyperbalanceClient,
  arweaveAddressFromJwk,
  discoverHyperbeamAoBundlerProfile,
  waitForAoAssignmentSlot,
} = hyperbalance

const {
  connect,
  createDataItemSigner,
  createSigner,
  message: aoMessage,
} = await import("@permaweb/aoconnect").catch((error) => {
  throw new Error(
    `Install dependencies with \`npm install\` before running this example.\n${error.message}`,
  )
})

const nodeUrl = trimTrailingSlash(args.node ?? process.env.HB_NODE ?? CONFIG.nodeUrl)
const sampleName = args.sample ?? process.env.WHISPER_SAMPLE ?? CONFIG.sample
const sample = CONFIG.samples[sampleName] ?? CONFIG.samples[CONFIG.sample]
if (!sample) throw new Error(`Unknown sample: ${sampleName}`)

const tx = args.tx ?? process.env.WHISPER_TX ?? sample.tx
const gateway = trimTrailingSlash(args.gateway ?? process.env.WHISPER_GATEWAY ?? sample.gateway)
const language = args.language ?? process.env.WHISPER_LANGUAGE ?? sample.language
const walletPath = expandHome(
  args.wallet ?? process.env.ARWEAVE_WALLET ?? process.env.PATH_TO_WALLET ?? CONFIG.walletPath,
)
const stateUrl = trimTrailingSlash(args.stateUrl ?? process.env.AO_STATE_URL ?? CONFIG.stateUrl)
const pollMs = Number(args.pollMs ?? process.env.AO_POLL_MS ?? CONFIG.pollMs)
const timeoutMs = Number(args.timeoutMs ?? process.env.AO_TIMEOUT_MS ?? CONFIG.timeoutMs)
const fundingMargin = BigInt(args.fundingMargin ?? process.env.FUNDING_MARGIN ?? CONFIG.fundingMargin)
const tokenId = args.tokenId ?? process.env.AO_TOKEN_ID ?? DEFAULT_AO_TOKEN_ID
const skipRuby = args.skipRuby === true || args.skipRuby === "true" || process.env.SKIP_RUBY === "1"
const fundOnly = args.fundOnly === true || args.fundOnly === "true" || process.env.FUND_ONLY === "1"
const verbose = args.verbose === true || args.verbose === "true" || process.env.VERBOSE === "1"

const wallet = JSON.parse(await readFile(walletPath, "utf8"))
const signerAddress = await arweaveAddressFromJwk(wallet)
const audioUrl = `${gateway}/${encodeURIComponent(tx)}`
const inputBytes = await fetchContentLength(audioUrl)
const minimumBalance =
  args.minimumBalance === undefined
    ? BigInt(inputBytes) + fundingMargin
    : BigInt(args.minimumBalance)

const profile = await discoverHyperbeamAoBundlerProfile({ nodeUrl, tokenId })
const client = new HyperbalanceClient({ nodeUrl })
const transferAdapter = buildAoTransferAdapter({
  pollMs,
  signerAddress,
  stateUrl,
  timeoutMs,
  verbose,
  wallet,
})
const sendWhisperRequest = buildHyperbeamRequestSender({ nodeUrl, wallet })

if (fundOnly) {
  const funding = await client.ensureCreditAuto({
    minimumBalance,
    profile,
    recipient: signerAddress,
    tokenId,
    transferAdapter,
  })

  printJson({
    audioUrl,
    funding: summarizeFunding(funding),
    inputBytes,
    minimumBalance: minimumBalance.toString(),
    nodeUrl,
    signerAddress,
    status: "funded",
    tx,
  })
  process.exit(0)
}

const { balance, funding, whisper } = await runWhisperRequest({
  client,
  gateway,
  language,
  minimumBalance,
  profile,
  send: sendWhisperRequest,
  signerAddress,
  tokenId,
  transferAdapter,
  tx,
})
const transcript = whisper.response?.transcript ?? ""
const ruby = skipRuby
  ? undefined
  : await transformTranscriptWithRuby({
      nodeUrl,
      rubyCode: CONFIG.rubyCode,
      transcript,
    })

printJson({
  audioUrl,
  balance,
  funding: summarizeFunding(funding),
  inputBytes,
  minimumBalance: minimumBalance.toString(),
  nodeUrl,
  ruby,
  signerAddress,
  tx,
  whisper,
})

function buildAoTransferAdapter({ pollMs, signerAddress, stateUrl, timeoutMs, verbose, wallet }) {
  const dataItemSigner = createDataItemSigner(wallet)
  return new AoTokenTransferAdapter({
    async inferSender() {
      return signerAddress
    },
    async message(input) {
      if (verbose) console.error("Sending AO transfer", input.tags)
      const messageId = await aoMessage({
        data: input.data ?? "",
        process: input.process,
        signer: dataItemSigner,
        tags: input.tags,
      })
      if (verbose) console.error(`AO transfer message id: ${messageId}`)
      return messageId
    },
    async waitForAssignmentSlot(messageId, context) {
      if (verbose) console.error(`Waiting for AO assignment slot for ${messageId}`)
      const slot = await waitForAoAssignmentSlot({
        messageId,
        pollMs,
        processId: context.processId,
        stateUrl,
        timeoutMs,
      })
      if (verbose) console.error(`AO assignment slot: ${slot}`)
      return slot
    },
  })
}

function buildHyperbeamRequestSender({ nodeUrl, wallet }) {
  const { request } = connect({
    MODE: "mainnet",
    URL: nodeUrl,
    signer: createSigner(wallet),
  })

  return async (fields) => normalizeResponse(await request(fields))
}

async function fetchContentLength(url) {
  const head = await fetch(url, { method: "HEAD" }).catch(() => undefined)
  const length = head?.headers.get("content-length")
  if (head?.ok && length && /^\d+$/.test(length)) return Number(length)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Could not fetch audio for sizing: ${response.status} ${response.statusText}`)
  }
  return (await response.arrayBuffer()).byteLength
}

async function runWhisperRequest({
  client,
  gateway,
  language,
  minimumBalance,
  profile,
  send,
  signerAddress,
  tokenId,
  transferAdapter,
  tx,
}) {
  const result = await client.paidRequest({
    fields: {
      accept: "application/json, text/plain",
      gateway,
      language,
      method: "GET",
      path: "/~whisper@1.0/transcribe",
      tx,
    },
    minimumBalance,
    profile,
    send,
    signerAddress,
    tokenId,
    transferAdapter,
  })

  const whisper = await parseWhisperResponse(result.response)
  if (!result.response.ok) {
    throw new Error(
      `Whisper request failed: ${result.response.status} ${result.response.statusText}\n${whisper.body}`,
    )
  }

  return {
    balance: summarizePaidBalance(result),
    funding: result.funding,
    whisper,
  }
}

async function parseWhisperResponse(response) {
  const body = await response.text()
  return {
    body,
    contentType: response.headers.get("content-type") ?? undefined,
    response: parseJson(body) ?? body,
    status: response.status,
    statusText: response.statusText,
  }
}

async function transformTranscriptWithRuby({ nodeUrl, rubyCode, transcript }) {
  const moduleMap = [
    `body=:${Buffer.from(rubyCode).toString("base64")}:`,
    `content-type=:${Buffer.from("application/ruby").toString("base64")}:`,
  ].join(",")
  const url = new URL("/~ruby@mruby-3.3a/first5", nodeUrl)
  url.searchParams.set("module+map", moduleMap)
  url.searchParams.set("transcript", transcript)

  const response = await fetch(url, { headers: { accept: "text/plain" } })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`Ruby transform failed: ${response.status} ${response.statusText}\n${body}`)
  }

  return {
    body,
    status: response.status,
    url: url.toString(),
  }
}

function summarizeFunding(funding) {
  if (!funding) return undefined

  return {
    after: funding.after.value.toString(),
    before: funding.before.value.toString(),
    imported: funding.transfer ? true : undefined,
    shortfall: funding.shortfall.toString(),
    transfer: funding.transfer
      ? {
          messageId: funding.transfer.messageId,
          sender: funding.transfer.sender,
          slot: funding.transfer.slot,
        }
      : undefined,
  }
}

function summarizePaidBalance(result) {
  return {
    after: result.after?.value.toString(),
    before: result.before.value.toString(),
  }
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

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === "--help" || value === "-h") {
      parsed.help = true
      continue
    }
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`)
    const raw = value.slice(2)
    const equals = raw.indexOf("=")
    if (equals === -1) {
      if (values[index + 1] === undefined || values[index + 1].startsWith("--")) {
        parsed[raw] = true
      } else {
        parsed[raw] = values[index + 1]
        index += 1
      }
    } else {
      parsed[raw.slice(0, equals)] = raw.slice(equals + 1)
    }
  }
  return parsed
}

function expandHome(value) {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2))
  return value
}

function printJson(value) {
  console.log(JSON.stringify(value, undefined, 2))
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "")
}

function printHelp() {
  console.log(`Usage: node examples/rb-whisper-ruby-playground.mjs [options]

Prefilled live rb paid Whisper playground:
  1. imports local Hyperbalance;
  2. funds/imports AO credit for the selected tx size;
  3. sends a signed paid Whisper request with @permaweb/aoconnect;
  4. sends the transcript through the rb Ruby transform device.

Options:
  --sample <hello|small>       Hardcoded sample to use (default: ${CONFIG.sample})
  --wallet <path>              Arweave JWK path
  --node <url>                 HyperBEAM node (default: ${CONFIG.nodeUrl})
  --tx <id>                    Override the sample tx id
  --gateway <url>              Override the sample gateway
  --language <code>            Override the sample language
  --minimumBalance <amount>    AO base units to require before call
  --fundingMargin <amount>     Extra AO base units above input bytes
  --fundOnly                   Only fund/import credit, do not call Whisper
  --skipRuby                   Do not call the Ruby transform step
  --verbose                    Print AO transfer progress to stderr

Environment equivalents: HB_NODE, WHISPER_SAMPLE, WHISPER_TX, WHISPER_GATEWAY,
WHISPER_LANGUAGE, ARWEAVE_WALLET, PATH_TO_WALLET, AO_TOKEN_ID, AO_STATE_URL,
AO_POLL_MS, AO_TIMEOUT_MS, FUNDING_MARGIN, FUND_ONLY=1, SKIP_RUBY=1,
VERBOSE=1.
`)
}
