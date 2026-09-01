import { describe, expect, test } from "vitest";
import {
  buildCodeServerUrlOpeners,
  detectCodeServerLocalhostUrl,
  extractCodeServerPortsFromProcessList,
  normalizeCodeServerExternalUrl,
} from "./code-server-detection.js";

function execFromOutputs(outputs: Record<string, Error | string>) {
  return (file: string, args: readonly string[] = []) => {
    const key = `${file} ${args.join(" ")}`.trim();
    if (!Object.hasOwn(outputs, key)) {
      throw new Error(`Unexpected command: ${key}`);
    }
    const output = outputs[key];
    if (output instanceof Error) {
      throw output;
    }
    return output ?? "";
  };
}

describe("code-server detection", () => {
  test("normalizes http and https CODE_SERVER_URL values", () => {
    expect(normalizeCodeServerExternalUrl(" https://code-server.example.test/ ")).toBe(
      "https://code-server.example.test/",
    );
    expect(normalizeCodeServerExternalUrl("file:///tmp/code-server")).toBeNull();
    expect(normalizeCodeServerExternalUrl("not a url")).toBeNull();
  });

  test("extracts ports from code-server process arguments", () => {
    expect(
      extractCodeServerPortsFromProcessList(
        [
          "/opt/code-server/lib/node /opt/code-server --auth none --port 13337",
          "/opt/code-server --bind-addr 127.0.0.1:8080",
          "/opt/code-server --port=9000",
        ].join("\n"),
      ),
    ).toEqual([13337, 8080, 9000]);
  });

  test("returns localhost URL when a candidate process has a loopback listener", () => {
    const execFile = execFromOutputs({
      "ps -axo pid=,command=": "7 /opt/code-server --auth none --port 13337\n",
      "ss -ltnp": 'LISTEN 0 4096 127.0.0.1:13337 0.0.0.0:* users:(("node",pid=7,fd=18))\n',
    });

    expect(detectCodeServerLocalhostUrl(execFile)).toBe("http://127.0.0.1:13337");
  });

  test("falls back to pgrep when ps is unavailable", () => {
    const execFile = execFromOutputs({
      "ps -axo pid=,command=": new Error("ps unavailable"),
      "pgrep -af [c]ode-server": "7 /opt/code-server --auth none --port 13337\n",
      "ss -ltnp": 'LISTEN 0 4096 127.0.0.1:13337 0.0.0.0:* users:(("node",pid=7,fd=18))\n',
    });

    expect(detectCodeServerLocalhostUrl(execFile)).toBe("http://127.0.0.1:13337");
  });

  test("detects the listener port from process ownership when args omit the port", () => {
    const execFile = execFromOutputs({
      "ps -axo pid=,command=": "42 /opt/code-server/lib/node /opt/code-server --auth none\n",
      "ss -ltnp": new Error("ss unavailable"),
      "lsof -nP -iTCP -sTCP:LISTEN":
        "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n" +
        "node 42 user 18u IPv4 12345 0t0 TCP 127.0.0.1:13337 (LISTEN)\n",
    });

    expect(detectCodeServerLocalhostUrl(execFile)).toBe("http://127.0.0.1:13337");
  });

  test("fails closed when listener confirmation contradicts the process port", () => {
    const execFile = execFromOutputs({
      "ps -axo pid=,command=": "7 /opt/code-server --auth none --port 13337\n",
      "ss -ltnp": 'LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=7,fd=18))\n',
    });

    expect(detectCodeServerLocalhostUrl(execFile)).toBeNull();
  });

  test("builds optional server_info URL opener metadata", () => {
    const execFile = execFromOutputs({
      "ps -axo pid=,command=": "7 /opt/code-server --auth none --port 13337\n",
      "ss -ltnp": 'LISTEN 0 4096 127.0.0.1:13337 0.0.0.0:* users:(("node",pid=7,fd=18))\n',
    });

    expect(
      buildCodeServerUrlOpeners({
        env: { CODE_SERVER_URL: "https://code-server.example.test/" },
        execFile,
      }),
    ).toEqual({
      localhostUrl: "http://127.0.0.1:13337",
      externalUrl: "https://code-server.example.test/",
    });
  });
});
