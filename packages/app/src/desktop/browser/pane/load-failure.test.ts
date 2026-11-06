import { describe, expect, it } from "vitest";
import { autoRetryDelaySeconds, isAutoRetryableLoadError } from "./load-failure";

describe("browser load failure retry policy", () => {
  it("retries errors that mean nothing answered yet", () => {
    expect(isAutoRetryableLoadError("ERR_CONNECTION_REFUSED: http://localhost:3000/")).toBe(true);
    expect(isAutoRetryableLoadError("ERR_EMPTY_RESPONSE: http://localhost:3000/")).toBe(true);
    expect(isAutoRetryableLoadError("ERR_TUNNEL_CONNECTION_FAILED")).toBe(true);
  });

  it("waits for the user on errors a retry cannot fix", () => {
    expect(isAutoRetryableLoadError("ERR_NAME_NOT_RESOLVED: http://nope.invalid/")).toBe(false);
    expect(isAutoRetryableLoadError("ERR_CERT_AUTHORITY_INVALID")).toBe(false);
    expect(isAutoRetryableLoadError("Blocked unsupported browser URL: file:")).toBe(false);
  });

  it("backs off to a 30 second ceiling", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(autoRetryDelaySeconds)).toEqual([2, 4, 8, 16, 30, 30, 30]);
  });
});
