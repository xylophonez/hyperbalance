export class HyperbalanceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = "HyperbalanceError"
  }
}

export class MissingDiscoveryError extends HyperbalanceError {
  constructor(readonly attemptedUrls: string[]) {
    super(`No hyperbalance discovery endpoint found: ${attemptedUrls.join(", ")}`)
    this.name = "MissingDiscoveryError"
  }
}

export class PaymentRequiredError extends HyperbalanceError {
  constructor(
    message: string,
    readonly required: bigint,
    readonly available: bigint,
  ) {
    super(message)
    this.name = "PaymentRequiredError"
  }
}

