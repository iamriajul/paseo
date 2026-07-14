import { describe, expect, test } from "vitest";
import { resolveCodeServerLaunchUrl } from "./code-server-url";

const VSCODE_PROXY_URI = "https://{{port}}--workspace.example.test";
const WORKSPACE_DIRECTORY = "/home/coder/my-project";

describe("resolveCodeServerLaunchUrl", () => {
  test("opens the current workspace folder in the desktop Code Server tab", () => {
    expect(
      resolveCodeServerLaunchUrl({
        isElectron: true,
        codeServerUrlOpeners: { localhostUrl: "http://127.0.0.1:13337" },
        workspaceDirectory: WORKSPACE_DIRECTORY,
      }),
    ).toBe("http://127.0.0.1:13337/?folder=%2Fhome%2Fcoder%2Fmy-project");
  });

  test("opens the current workspace folder through CODE_SERVER_URL on mobile", () => {
    expect(
      resolveCodeServerLaunchUrl({
        isElectron: false,
        codeServerUrlOpeners: {
          externalUrl: "https://code-server.example.test/?auth=1#editor",
        },
        workspaceDirectory: WORKSPACE_DIRECTORY,
      }),
    ).toBe("https://code-server.example.test/?auth=1&folder=%2Fhome%2Fcoder%2Fmy-project#editor");
  });

  test("rewrites a loopback CODE_SERVER_URL through VSCODE_PROXY_URI on mobile", () => {
    expect(
      resolveCodeServerLaunchUrl({
        isElectron: false,
        codeServerUrlOpeners: { externalUrl: "http://localhost:13337" },
        vscodeProxyUri: VSCODE_PROXY_URI,
        workspaceDirectory: WORKSPACE_DIRECTORY,
      }),
    ).toBe("https://13337--workspace.example.test/?folder=%2Fhome%2Fcoder%2Fmy-project");
  });

  test("uses the detected Code Server port with VSCODE_PROXY_URI when no external URL exists", () => {
    expect(
      resolveCodeServerLaunchUrl({
        isElectron: false,
        codeServerUrlOpeners: { localhostUrl: "http://127.0.0.1:13337" },
        vscodeProxyUri: VSCODE_PROXY_URI,
      }),
    ).toBe("https://13337--workspace.example.test/");
  });

  test("does not expose a daemon-local Code Server URL to mobile without a proxy", () => {
    expect(
      resolveCodeServerLaunchUrl({
        isElectron: false,
        codeServerUrlOpeners: { localhostUrl: "http://127.0.0.1:13337" },
      }),
    ).toBeNull();
  });
});
