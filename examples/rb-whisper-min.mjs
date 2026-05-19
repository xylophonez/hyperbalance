#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import {
  AoTokenTransferAdapter,
  DEFAULT_AO_TOKEN_ID,
  HyperbalanceClient,
  arweaveAddressFromJwk,
  discoverHyperbeamAoBundlerProfile,
  waitForAoAssignmentSlot,
} from "../dist/index.js"
import { createDataItemSigner, message } from "@permaweb/aoconnect"

const WALLET = "/home/fn/Downloads/arweave-key-kaYP9bJtpqON8Kyy3RbqnqdtDBDUsPTQTNUCvZtKiFI.json"
const TX = "4ozZ6AVifuOCR2wwtSZejKUagx9KGCeICrBr5-reOwU"
const NODE = "https://rb.mystical.computer"
const GATEWAY = "https://arweave.net"
const MYSTICAL = "/home/fn/Dev/mystical.computer"

const wallet = JSON.parse(await readFile(WALLET, "utf8"))
const address = await arweaveAddressFromJwk(wallet)
const profile = await discoverHyperbeamAoBundlerProfile({ nodeUrl: NODE, tokenId: DEFAULT_AO_TOKEN_ID })
const client = new HyperbalanceClient({ nodeUrl: NODE })
const signer = createDataItemSigner(wallet)
const audioUrl = `${GATEWAY}/${TX}`
const size = await contentLength(audioUrl)

await client.ensureCreditAuto({
  minimumBalance: BigInt(size),
  profile,
  recipient: address,
  tokenId: DEFAULT_AO_TOKEN_ID,
  transferAdapter: new AoTokenTransferAdapter({
    inferSender: async () => address,
    message: (input) => message({ data: "", process: input.process, signer, tags: input.tags }),
    waitForAssignmentSlot: (messageId, ctx) =>
      waitForAoAssignmentSlot({ messageId, processId: ctx.processId }),
  }),
})

const out = spawnSync(`${MYSTICAL}/scripts/rb-whisper-smoke.sh`, {
  cwd: MYSTICAL,
  encoding: "utf8",
  env: {
    ...process.env,
    WALLET_FILE: WALLET,
    TX_ID: TX,
    HB_NODE: NODE,
    WHISPER_GATEWAY: GATEWAY,
    WHISPER_LANGUAGE: "auto",
  },
})

if (out.status !== 0) throw new Error(out.stderr || out.stdout)
console.log(JSON.parse(out.stdout.match(/^body=(.*)$/m)[1]).transcript.trim())

async function contentLength(url) {
  const head = await fetch(url, { method: "HEAD" }).catch(() => undefined)
  const length = head?.headers.get("content-length")
  if (head?.ok && length) return Number(length)
  return (await (await fetch(url)).arrayBuffer()).byteLength
}
