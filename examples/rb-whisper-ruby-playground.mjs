#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Edit these defaults and rerun. CLI/env overrides are at the bottom.
const CONFIG = {
  nodeUrl: "https://rb.mystical.computer",
  walletPath: "/home/fn/Downloads/arweave-key-kaYP9bJtpqON8Kyy3RbqnqdtDBDUsPTQTNUCvZtKiFI.json",
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

const { createDataItemSigner, message: aoMessage } = await import("@permaweb/aoconnect").catch(
  (error) => {
    throw new Error(
      `Install @permaweb/aoconnect to run this example: npm install @permaweb/aoconnect\n${error.message}`,
    )
  },
)

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
const mysticalRepo = expandHome(args.mysticalRepo ?? process.env.MYSTICAL_REPO ?? CONFIG.mysticalRepo)
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

const funding = await client.ensureCreditAuto({
  minimumBalance,
  profile,
  recipient: signerAddress,
  tokenId,
  transferAdapter,
})

if (fundOnly) {
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

const whisper = runNativeWhisper({
  gateway,
  language,
  mysticalRepo,
  nodeUrl,
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

function runNativeWhisper({ gateway, language, mysticalRepo, nodeUrl, tx, walletPath }) {
  const script = path.join(mysticalRepo, "scripts/rb-whisper-smoke.sh")
  const result = spawnSync(script, {
    cwd: mysticalRepo,
    encoding: "utf8",
    env: {
      ...process.env,
      HB_NODE: nodeUrl,
      TX_ID: tx,
      WALLET_FILE: walletPath,
      WHISPER_GATEWAY: gateway,
      WHISPER_LANGUAGE: language,
    },
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Native Whisper smoke failed with exit ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    )
  }

  return parseWhisperSmokeOutput(result.stdout)
}

function parseWhisperSmokeOutput(output) {
  const parsed = {
    raw: output.trim(),
  }
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const equals = line.indexOf("=")
    if (equals === -1) continue
    const key = line.slice(0, equals)
    const value = line.slice(equals + 1)
    parsed[key] = value
  }

  if (parsed.status !== undefined) parsed.status = Number(parsed.status)
  if (parsed.balance_before !== undefined) parsed.balanceBefore = Number(parsed.balance_before)
  if (parsed.balance_after !== undefined) parsed.balanceAfter = Number(parsed.balance_after)
  if (parsed.delta !== undefined) parsed.delta = Number(parsed.delta)
  if (parsed.body) {
    try {
      parsed.response = JSON.parse(parsed.body)
    } catch {
      parsed.response = parsed.body
    }
  }
  delete parsed.balance_before
  delete parsed.balance_after
  return parsed
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
  3. runs the paid Whisper request through HyperBEAM's native signer;
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
  --mysticalRepo <path>        mystical.computer checkout path
  --fundOnly                   Only fund/import credit, do not call Whisper
  --skipRuby                   Do not call the Ruby transform step
  --verbose                    Print AO transfer progress to stderr

Environment equivalents: HB_NODE, WHISPER_SAMPLE, WHISPER_TX, WHISPER_GATEWAY,
WHISPER_LANGUAGE, ARWEAVE_WALLET, PATH_TO_WALLET, MYSTICAL_REPO, AO_TOKEN_ID,
AO_STATE_URL, AO_POLL_MS, AO_TIMEOUT_MS, FUNDING_MARGIN, FUND_ONLY=1,
SKIP_RUBY=1, VERBOSE=1.
`)
}
