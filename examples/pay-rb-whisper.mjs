#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_NODE = "https://rb.mystical.computer"
const DEFAULT_TX = "9OaHLWDaAjSSBeGhYOyBm2BRG-SG5ppEt2rWi_z2AIs"
const DEFAULT_GATEWAY = "https://rb.mystical.computer"
const DEFAULT_LANGUAGE = "en"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
    `Install @permaweb/aoconnect to run this example: npm install @permaweb/aoconnect\n${error.message}`,
  )
})

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const nodeUrl = trimTrailingSlash(args.node ?? process.env.HB_NODE ?? DEFAULT_NODE)
const tx = args.tx ?? process.env.WHISPER_TX ?? DEFAULT_TX
const gateway = trimTrailingSlash(args.gateway ?? process.env.WHISPER_GATEWAY ?? DEFAULT_GATEWAY)
const language = args.language ?? process.env.WHISPER_LANGUAGE ?? DEFAULT_LANGUAGE
const walletPath = expandHome(
  args.wallet ??
    process.env.ARWEAVE_WALLET ??
    process.env.PATH_TO_WALLET ??
    path.join(homedir(), ".aos.json"),
)
const stateUrl = trimTrailingSlash(args.stateUrl ?? process.env.AO_STATE_URL ?? "https://state.forward.computer")
const pollMs = Number(args.pollMs ?? process.env.AO_POLL_MS ?? 5000)
const timeoutMs = Number(args.timeoutMs ?? process.env.AO_TIMEOUT_MS ?? 360000)
const fundingMargin = BigInt(args.fundingMargin ?? process.env.FUNDING_MARGIN ?? 0)
const verbose = args.verbose === "true" || args.verbose === true || process.env.VERBOSE === "1"

const wallet = JSON.parse(await readFile(walletPath, "utf8"))
const signerAddress = await arweaveAddressFromJwk(wallet)
const audioUrl = args.audioUrl ?? `${gateway}/${encodeURIComponent(tx)}`
const inputBytes = await fetchContentLength(audioUrl)
const minimumBalance =
  args.minimumBalance === undefined
    ? BigInt(inputBytes) + fundingMargin
    : BigInt(args.minimumBalance)

const profile = await discoverHyperbeamAoBundlerProfile({
  nodeUrl,
  tokenId: args.tokenId ?? process.env.AO_TOKEN_ID ?? DEFAULT_AO_TOKEN_ID,
})
if (verbose) {
  console.error(
    JSON.stringify(
      {
        audioUrl,
        balancePath: profile.ledgers[0]?.balancePath,
        inputBytes,
        ledgerId: profile.ledgers[0]?.id,
        minimumBalance: minimumBalance.toString(),
        nodeUrl,
        signerAddress,
      },
      undefined,
      2,
    ),
  )
}
const client = new HyperbalanceClient({ nodeUrl })

const dataItemSigner = createDataItemSigner(wallet)
const transferAdapter = new AoTokenTransferAdapter({
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

const { request } = connect({
  MODE: "mainnet",
  URL: nodeUrl,
  signer: createSigner(wallet),
})

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
  send: async (fields) => normalizeResponse(await request(fields)),
  signerAddress,
  tokenId: args.tokenId ?? process.env.AO_TOKEN_ID ?? DEFAULT_AO_TOKEN_ID,
  transferAdapter,
})

const text = await result.response.text()
let parsed
try {
  parsed = JSON.parse(text)
} catch {
  parsed = undefined
}

console.log(
  JSON.stringify(
    {
      afterBalance: result.after?.value.toString(),
      beforeBalance: result.before.value.toString(),
      funded: result.funding
        ? {
            after: result.funding.after.value.toString(),
            before: result.funding.before.value.toString(),
            messageId: result.funding.transfer?.messageId,
            shortfall: result.funding.shortfall.toString(),
            slot: result.funding.transfer?.slot,
          }
        : undefined,
      inputBytes,
      minimumBalance: result.minimumBalance.toString(),
      nodeUrl,
      response: parsed ?? text,
      signerAddress,
      status: result.response.status,
      tx,
    },
    undefined,
    2,
  ),
)

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

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "")
}

function printHelp() {
  console.log(`Usage: node examples/pay-rb-whisper.mjs [options]

Pays AO into rb.mystical.computer's local ledger when needed, then sends a
signed HyperBEAM httpsig request to whisper@1.0.

Options:
  --wallet <path>            Arweave JWK path (default: ~/.aos.json)
  --node <url>               HyperBEAM node (default: ${DEFAULT_NODE})
  --tx <id>                  Audio transaction/data-item id (default: ${DEFAULT_TX})
  --gateway <url>            Gateway used by whisper to fetch tx (default: ${DEFAULT_GATEWAY})
  --language <code>          Whisper language (default: ${DEFAULT_LANGUAGE})
  --minimumBalance <amount>  AO base units to require before call
  --fundingMargin <amount>   Extra AO base units to fund above input bytes
  --tokenId <id>             AO token process id
  --stateUrl <url>           AO state endpoint (default: https://state.forward.computer)
  --pollMs <ms>              AO schedule polling interval (default: 5000)
  --timeoutMs <ms>           AO schedule wait timeout (default: 360000)
  --verbose                  Print funding progress to stderr

Environment equivalents: HB_NODE, WHISPER_TX, WHISPER_GATEWAY,
WHISPER_LANGUAGE, ARWEAVE_WALLET, PATH_TO_WALLET, AO_TOKEN_ID, AO_STATE_URL,
AO_POLL_MS, AO_TIMEOUT_MS, FUNDING_MARGIN, VERBOSE=1.
`)
}
