#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Edit these defaults and rerun. CLI/env overrides are at the bottom.
const CONFIG = {
  nodeUrl: "https://rb.mystical.computer",
  walletPath: "~/.aos.json",
  mysticalRepo: "/home/fn/Dev/mystical.computer",
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

const { createDataItemSigner, message: aoMessage } = await import("@permaweb/aoconnect").catch((error) => {
  throw new Error(
    `Install dependencies with \`npm install\` before running this example.\n${error.message}`,
  )
})

const nodeUrl = trimTrailingSlash(
  args.node ?? envFirst("HYPERBALANCE_NODE_URL", "HB_NODE") ?? CONFIG.nodeUrl,
)
const sampleName = args.sample ?? process.env.WHISPER_SAMPLE ?? CONFIG.sample
const sample = CONFIG.samples[sampleName] ?? CONFIG.samples[CONFIG.sample]
if (!sample) throw new Error(`Unknown sample: ${sampleName}`)

const tx = args.tx ?? process.env.WHISPER_TX ?? process.env.TX ?? sample.tx
const gateway = trimTrailingSlash(
  args.gateway ?? envFirst("HYPERBALANCE_GATEWAY_URL", "WHISPER_GATEWAY") ?? sample.gateway,
)
const language = args.language ?? process.env.WHISPER_LANGUAGE ?? sample.language
const walletPath = expandHome(
  args.wallet ??
    process.env.HYPERBALANCE_WALLET ??
    process.env.ARWEAVE_WALLET ??
    process.env.PATH_TO_WALLET ??
    process.env.WALLET ??
    CONFIG.walletPath,
)
const mysticalRepo = expandHome(
  args.mysticalRepo ??
    envFirst("HYPERBALANCE_MYSTICAL_REPO", "MYSTICAL_REPO") ??
    CONFIG.mysticalRepo,
)
const stateUrl = trimTrailingSlash(
  args.stateUrl ?? envFirst("HYPERBALANCE_STATE_URL", "AO_STATE_URL") ?? CONFIG.stateUrl,
)
const pollMs = Number(args.pollMs ?? process.env.AO_POLL_MS ?? CONFIG.pollMs)
const timeoutMs = Number(args.timeoutMs ?? process.env.AO_TIMEOUT_MS ?? CONFIG.timeoutMs)
const fundingMargin = BigInt(
  args.fundingMargin ??
    envFirst("HYPERBALANCE_FUNDING_MARGIN", "FUNDING_MARGIN") ??
    CONFIG.fundingMargin,
)
const tokenId = args.tokenId ?? process.env.AO_TOKEN_ID ?? DEFAULT_AO_TOKEN_ID
const skipRuby = args.skipRuby === true || args.skipRuby === "true" || process.env.SKIP_RUBY === "1"
const fundOnly = args.fundOnly === true || args.fundOnly === "true" || process.env.FUND_ONLY === "1"
const verbose = args.verbose === true || args.verbose === "true" || process.env.VERBOSE === "1"
const transferMode = String(
  args.transferMode ?? envFirst("HYPERBALANCE_TRANSFER_MODE", "TRANSFER_MODE") ?? "ao",
).toLowerCase()
const mockMessageId =
  args.mockMessageId ??
  envFirst("HYPERBALANCE_MOCK_MESSAGE_ID", "MOCK_MESSAGE_ID") ??
  "local-hyperbalance-payment"
const mockSlot = args.mockSlot ?? envFirst("HYPERBALANCE_MOCK_SLOT", "MOCK_SLOT") ?? "1"

const wallet = JSON.parse(await readFile(walletPath, "utf8"))
const signerAddress = await arweaveAddressFromJwk(wallet)
const audioUrl = `${gateway}/${encodeURIComponent(tx)}`
const inputBytes = await fetchContentLength(audioUrl)
const minimumBalance =
  args.minimumBalance === undefined
    ? BigInt(envFirst("HYPERBALANCE_MINIMUM_BALANCE", "MINIMUM_BALANCE") ?? inputBytes) +
      fundingMargin
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
  mysticalRepo,
  nodeUrl,
  profile,
  signerAddress,
  tokenId,
  transferAdapter,
  tx,
  walletPath,
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
  if (["local", "local-mock", "mock"].includes(transferMode)) {
    return {
      kind: "ao",
      inferSender: async () => signerAddress,
      transfer: async (request) => ({
        messageId: mockMessageId,
        raw: {
          amount: request.amount.toString(),
          depositAddress: request.depositAddress,
          mode: transferMode,
          recipient: request.recipient,
        },
        sender: request.sender ?? signerAddress,
        slot: mockSlot,
      }),
    }
  }

  if (transferMode !== "ao") {
    throw new Error(`Unsupported transfer mode: ${transferMode}`)
  }

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
  mysticalRepo,
  nodeUrl,
  profile,
  signerAddress,
  tokenId,
  transferAdapter,
  tx,
  walletPath,
}) {
  const funding = await client.ensureCreditAuto({
    minimumBalance,
    profile,
    recipient: signerAddress,
    tokenId,
    transferAdapter,
  })

  const out = spawnSync(`${mysticalRepo}/scripts/rb-whisper-smoke.sh`, {
    cwd: mysticalRepo,
    encoding: "utf8",
    env: {
      ...process.env,
      WALLET_FILE: walletPath,
      TX_ID: tx,
      HB_NODE: nodeUrl,
      WHISPER_GATEWAY: gateway,
      WHISPER_LANGUAGE: language,
    },
  })
  if (out.status !== 0) throw new Error(out.error?.message || out.stderr || out.stdout)

  return {
    balance: parseNativeBalance(out.stdout),
    funding,
    whisper: parseNativeWhisper(out.stdout),
  }
}

function parseNativeWhisper(stdout) {
  const status = Number(stdout.match(/^status=(\d+)$/m)?.[1])
  const body = stdout.match(/^body=(.*)$/m)?.[1]
  if (!body) throw new Error(`Whisper smoke output did not include a body:\n${stdout}`)
  if (status !== 200) throw new Error(`Whisper request failed: ${status}\n${body}`)

  return {
    body,
    response: parseJson(body) ?? body,
    status,
  }
}

function parseNativeBalance(stdout) {
  return {
    after: stdout.match(/^balance_after=(-?\d+)$/m)?.[1],
    before: stdout.match(/^balance_before=(-?\d+)$/m)?.[1],
    delta: stdout.match(/^delta=(-?\d+)$/m)?.[1],
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

  const response = await freshTextGet(url, { accept: "text/plain", connection: "close" })
  if (!response.ok) {
    throw new Error(`Ruby transform failed: ${response.status} ${response.statusText}\n${response.body}`)
  }

  return {
    body: response.body,
    status: response.status,
    url: url.toString(),
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

function envFirst(...names) {
  for (const name of names) {
    if (process.env[name] !== undefined && process.env[name] !== "") return process.env[name]
  }
  return undefined
}

function printHelp() {
  console.log(`Usage: node examples/rb-whisper-ruby-playground.mjs [options]

Prefilled live rb paid Whisper playground:
  1. imports local Hyperbalance;
  2. funds/imports AO credit for the selected tx size;
  3. sends a signed paid Whisper request with the native HyperBEAM smoke signer;
  4. sends the transcript through the rb Ruby transform device.

Options:
  --sample <hello|small>       Hardcoded sample to use (default: ${CONFIG.sample})
  --wallet <path>              Arweave JWK path
  --node <url>                 HyperBEAM node (default: ${CONFIG.nodeUrl})
  --tx <id>                    Override the sample tx id
  --gateway <url>              Override the sample gateway
  --language <code>            Override the sample language
  --mysticalRepo <path>         mystical.computer checkout with scripts/rb-whisper-smoke.sh
  --minimumBalance <amount>    AO base units to require before call
  --fundingMargin <amount>     Extra AO base units above input bytes
  --transferMode <ao|mock>     Use real AO transfer or local mock transfer
  --fundOnly                   Only fund/import credit, do not call Whisper
  --skipRuby                   Do not call the Ruby transform step
  --verbose                    Print AO transfer progress to stderr

Environment equivalents: HYPERBALANCE_NODE_URL, HB_NODE, WHISPER_SAMPLE,
WHISPER_TX, TX, HYPERBALANCE_GATEWAY_URL, WHISPER_GATEWAY, WHISPER_LANGUAGE,
HYPERBALANCE_WALLET, ARWEAVE_WALLET, PATH_TO_WALLET, WALLET,
HYPERBALANCE_MYSTICAL_REPO, MYSTICAL_REPO, AO_TOKEN_ID,
HYPERBALANCE_STATE_URL, AO_STATE_URL, AO_POLL_MS, AO_TIMEOUT_MS,
HYPERBALANCE_MINIMUM_BALANCE, MINIMUM_BALANCE, HYPERBALANCE_FUNDING_MARGIN,
FUNDING_MARGIN, HYPERBALANCE_TRANSFER_MODE, TRANSFER_MODE,
HYPERBALANCE_MOCK_MESSAGE_ID, MOCK_MESSAGE_ID, HYPERBALANCE_MOCK_SLOT,
MOCK_SLOT, FUND_ONLY=1, SKIP_RUBY=1, VERBOSE=1.
`)
}
