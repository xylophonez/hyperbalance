import type { HyperbeamSignedRequestFields, SignedHyperbeamRequestSender } from "../types.js"

export interface AoCoreRequestLike {
  request(fields: HyperbeamSignedRequestFields): Promise<Response>
}

export function createAoCoreRequestSender(aoCore: AoCoreRequestLike): SignedHyperbeamRequestSender {
  return (fields) => aoCore.request(fields)
}
