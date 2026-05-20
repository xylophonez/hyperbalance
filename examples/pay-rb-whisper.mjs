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

const nodeUrl = trimTrailingSlash(
  args.node ?? envFirst("HYPERBALANCE_NODE_URL", "HB_NODE") ?? DEFAULT_NODE,
)
const tx = args.tx ?? process.env.WHISPER_TX ?? process.env.TX ?? DEFAULT_TX
const gateway = trimTrailingSlash(
  args.gateway ?? envFirst("HYPERBALANCE_GATEWAY_URL", "WHISPER_GATEWAY") ?? DEFAULT_GATEWAY,
)
const language = args.language ?? process.env.WHISPER_LANGUAGE ?? DEFAULT_LANGUAGE
const walletPath = expandHome(
  args.wallet ??
    process.env.HYPERBALANCE_WALLET ??
    process.env.ARWEAVE_WALLET ??
    process.env.PATH_TO_WALLET ??
    process.env.WALLET ??
    path.join(homedir(), ".aos.json"),
)
const stateUrl = trimTrailingSlash(
  args.stateUrl ??
    envFirst("HYPERBALANCE_STATE_URL", "AO_STATE_URL") ??
    "https://state.forward.computer",
)
const pollMs = Number(args.pollMs ?? process.env.AO_POLL_MS ?? 5000)
const timeoutMs = Number(args.timeoutMs ?? process.env.AO_TIMEOUT_MS ?? 360000)
const fundingMargin = BigInt(
  args.fundingMargin ?? envFirst("HYPERBALANCE_FUNDING_MARGIN", "FUNDING_MARGIN") ?? 0,
)
const execute =
  args.execute === "true" ||
  args.execute === true ||
  envFirst("HYPERBALANCE_EXECUTE", "EXECUTE_WHISPER_REQUEST") === "1"
const verbose = args.verbose === "true" || args.verbose === true || process.env.VERBOSE === "1"
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
const audioUrl = args.audioUrl ?? `${gateway}/${encodeURIComponent(tx)}`
const inputBytes = await fetchContentLength(audioUrl)
const minimumBalance =
  args.minimumBalance === undefined
    ? BigInt(envFirst("HYPERBALANCE_MINIMUM_BALANCE", "MINIMUM_BALANCE") ?? inputBytes) +
      fundingMargin
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

const transferAdapter = buildTransferAdapter()

if (!execute) {
  const funding = await client.ensureCreditAuto({
    minimumBalance,
    profile,
    recipient: signerAddress,
    tokenId: args.tokenId ?? process.env.AO_TOKEN_ID ?? DEFAULT_AO_TOKEN_ID,
    transferAdapter,
  })

  console.log(
    JSON.stringify(
      {
        afterBalance: funding.after.value.toString(),
        beforeBalance: funding.before.value.toString(),
        funded: funding.transfer
          ? {
              after: funding.after.value.toString(),
              before: funding.before.value.toString(),
              messageId: funding.transfer.messageId,
              shortfall: funding.shortfall.toString(),
              slot: funding.transfer.slot,
            }
          : undefined,
        inputBytes,
        minimumBalance: minimumBalance.toString(),
        nodeUrl,
        signerAddress,
        status: "funded",
        tx,
      },
      undefined,
      2,
    ),
  )
  process.exit(0)
}

const { request } = connect({
  MODE: "mainnet",
  URL: nodeUrl,
  signer: createSigner(wallet),
})

const requestPath =
  `/~whisper@1.0/transcribe?tx=${encodeURIComponent(tx)}` +
  `&gateway=${encodeURIComponent(gateway)}` +
  `&language=${encodeURIComponent(language)}`

const result = await client.paidRequest({
  fields: {
    accept: "application/json, text/plain",
    method: "GET",
    path: requestPath,
  },
  minimumBalance,
  profile,
  send: async (fields) => normalizeResponse(await request(fields)),
  signerAddress,
  tokenId: args.tokenId ?? process.env.AO_TOKEN_ID ?? DEFAULT_AO_TOKEN_ID,
  transferAdapter,
})

const text = await result.response.text()
if (!result.response.ok) {
  throw new Error(`Paid request failed: ${result.response.status} ${result.response.statusText}\n${text}`)
}

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

function buildTransferAdapter() {
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

function envFirst(...names) {
  for (const name of names) {
    if (process.env[name] !== undefined && process.env[name] !== "") return process.env[name]
  }
  return undefined
}

function printHelp() {
  console.log(`Usage: node examples/pay-rb-whisper.mjs [options]

Pays AO into rb.mystical.computer's local ledger when needed, then sends a
signed HyperBEAM httpsig request to whisper@1.0 when --execute is supplied.
Without --execute it only funds/imports the caller's AO credit.

Options:
  --wallet <path>            Arweave JWK path (default: ~/.aos.json)
  --node <url>               HyperBEAM node (default: ${DEFAULT_NODE})
  --tx <id>                  Audio transaction/data-item id (default: ${DEFAULT_TX})
  --gateway <url>            Gateway used by whisper to fetch tx (default: ${DEFAULT_GATEWAY})
  --language <code>          Whisper language (default: ${DEFAULT_LANGUAGE})
  --minimumBalance <amount>  AO base units to require before call
  --fundingMargin <amount>   Extra AO base units to fund above input bytes
  --execute                  Also send the experimental JS-signed Whisper request
  --tokenId <id>             AO token process id
  --transferMode <ao|mock>   Use real AO transfer or local mock transfer (default: ao)
  --stateUrl <url>           AO state endpoint (default: https://state.forward.computer)
  --pollMs <ms>              AO schedule polling interval (default: 5000)
  --timeoutMs <ms>           AO schedule wait timeout (default: 360000)
  --verbose                  Print funding progress to stderr

Environment equivalents: HYPERBALANCE_NODE_URL, HB_NODE, WHISPER_TX, TX,
HYPERBALANCE_GATEWAY_URL, WHISPER_GATEWAY, WHISPER_LANGUAGE,
HYPERBALANCE_WALLET, ARWEAVE_WALLET, PATH_TO_WALLET, WALLET, AO_TOKEN_ID,
HYPERBALANCE_STATE_URL, AO_STATE_URL, AO_POLL_MS, AO_TIMEOUT_MS,
HYPERBALANCE_MINIMUM_BALANCE, MINIMUM_BALANCE, HYPERBALANCE_FUNDING_MARGIN,
FUNDING_MARGIN, HYPERBALANCE_TRANSFER_MODE, TRANSFER_MODE,
HYPERBALANCE_MOCK_MESSAGE_ID, MOCK_MESSAGE_ID, HYPERBALANCE_MOCK_SLOT,
MOCK_SLOT, HYPERBALANCE_EXECUTE=1, EXECUTE_WHISPER_REQUEST=1, VERBOSE=1.
`)
}
