import { AoTokenTransferAdapter } from "@permaweb/hyperbalance/adapters/ao"
import {
  DEFAULT_AO_TOKEN_ID,
  HYPERBEAM_DEFAULT_LEDGER_ID,
  HyperbalanceClient,
  discoverHyperbeamAoBundlerProfile,
} from "@permaweb/hyperbalance"

const client = new HyperbalanceClient({
  nodeUrl: "https://hyperbeam.example.com",
})

const profile = await discoverHyperbeamAoBundlerProfile({
  nodeUrl: "https://hyperbeam.example.com",
})

const transferAdapter = new AoTokenTransferAdapter({
  async inferSender() {
    return "payer-wallet-address"
  },
  async message(input) {
    console.log("sign and submit AO message", input)
    return "message-id"
  },
  async waitForAssignmentSlot(messageId) {
    console.log("wait for AO assignment", messageId)
    return "slot"
  },
})

await client.ensureCredit({
  ledgerId: HYPERBEAM_DEFAULT_LEDGER_ID,
  minimumBalance: 1_000_000n,
  profile,
  recipient: "payer-wallet-address",
  tokenId: DEFAULT_AO_TOKEN_ID,
  transferAdapter,
})
