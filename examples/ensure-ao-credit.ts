import { AoTokenTransferAdapter } from "hyperbalance/adapters/ao"
import { HyperbalanceClient } from "hyperbalance"

const client = new HyperbalanceClient({
  nodeUrl: "https://hyperbeam.example.com",
})

const profile = await client.discover()

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
  ledgerId: "local-ao",
  minimumBalance: 1_000_000n,
  profile,
  recipient: "payer-wallet-address",
  tokenId: "ao-mainnet",
  transferAdapter,
})

