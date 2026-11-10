/**
 * The root holds more than the backend will observe. Retrying is pointless until the tree
 * shrinks, so callers that retry should wait their longest interval.
 */
export class FileObserverLimitError extends Error {
  constructor(
    readonly root: string,
    readonly limit: number,
    unit: "directories" | "entries",
  ) {
    super(`Recursive file observation exceeded ${limit} ${unit} under ${root}`);
    this.name = "FileObserverLimitError";
  }
}

export class FileObserverStartTimeoutError extends Error {
  constructor(
    readonly root: string,
    readonly timeoutMs: number,
  ) {
    super(`File observation of ${root} did not finish its initial scan within ${timeoutMs}ms`);
    this.name = "FileObserverStartTimeoutError";
  }
}
