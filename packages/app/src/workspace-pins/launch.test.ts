import { describe, expect, it } from "vitest";
import { shouldShowCodeServerLauncher } from "./code-server-availability";

describe("shouldShowCodeServerLauncher", () => {
  it("shows desktop code-server pins only when the host advertises a localhost URL", () => {
    expect(
      shouldShowCodeServerLauncher({
        isElectron: true,
        codeServerUrlOpeners: { localhostUrl: "http://127.0.0.1:13337" },
      }),
    ).toBe(true);
    expect(
      shouldShowCodeServerLauncher({
        isElectron: true,
        codeServerUrlOpeners: { externalUrl: "https://code-server.example.test/" },
      }),
    ).toBe(false);
  });

  it("shows non-desktop code-server pins for an external URL or a proxied localhost URL", () => {
    expect(
      shouldShowCodeServerLauncher({
        isElectron: false,
        codeServerUrlOpeners: { externalUrl: "https://code-server.example.test/" },
      }),
    ).toBe(true);
    expect(
      shouldShowCodeServerLauncher({
        isElectron: false,
        codeServerUrlOpeners: { localhostUrl: "http://127.0.0.1:13337" },
      }),
    ).toBe(false);
    expect(
      shouldShowCodeServerLauncher({
        isElectron: false,
        codeServerUrlOpeners: { localhostUrl: "http://127.0.0.1:13337" },
        vscodeProxyUri: "https://{{port}}--workspace.example.test",
      }),
    ).toBe(true);
  });
});
