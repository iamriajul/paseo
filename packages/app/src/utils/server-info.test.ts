import { describe, expect, test } from "vitest";
import { toDaemonServerInfo } from "./server-info";

describe("toDaemonServerInfo", () => {
  test("preserves URL openers from the daemon handshake", () => {
    expect(
      toDaemonServerInfo({
        status: "server_info",
        serverId: "srv-1",
        hostname: "host-1",
        version: "0.1.104",
        urlOpeners: {
          vscodeProxyUri: "https://{{port}}--workspace.example.test",
          codeServer: {
            localhostUrl: "http://127.0.0.1:13337",
            externalUrl: "https://code-server.example.test/",
          },
        },
        features: {},
      }),
    ).toMatchObject({
      urlOpeners: {
        vscodeProxyUri: "https://{{port}}--workspace.example.test",
        codeServer: {
          localhostUrl: "http://127.0.0.1:13337",
          externalUrl: "https://code-server.example.test/",
        },
      },
    });
  });
});
