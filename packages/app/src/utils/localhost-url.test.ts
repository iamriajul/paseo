import { describe, expect, test } from "vitest";

import {
  isLoopbackHostname,
  isLoopbackHttpUrl,
  isLoopbackTlsUrl,
  rewriteWithVscodeProxyUri,
} from "./localhost-url";

const TEMPLATE = "https://{{port}}--main--coder--iamriajul.coder.riajul.dev";

describe("localhost URL helpers", () => {
  test("detects loopback HTTP URLs", () => {
    expect(isLoopbackHttpUrl("http://localhost:5173")).toBe(true);
    expect(isLoopbackHttpUrl("localhost:5173")).toBe(true);
    expect(isLoopbackHttpUrl("https://127.42.0.1:8443")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:3000")).toBe(true);
    expect(isLoopbackHttpUrl("ws://localhost:5173")).toBe(false);
    expect(isLoopbackHttpUrl("https://example.com")).toBe(false);
  });

  test("recognizes standard loopback names and address ranges", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("app.localhost.")).toBe(true);
    expect(isLoopbackHostname("127.42.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.example.com")).toBe(false);
    expect(isLoopbackHostname("127.999.0.1")).toBe(false);
    expect(isLoopbackHostname("192.168.1.4")).toBe(false);
  });

  test("identifies only loopback HTTPS and WSS as unsupported local TLS", () => {
    expect(isLoopbackTlsUrl("https://localhost:8443")).toBe(true);
    expect(isLoopbackTlsUrl("wss://app.localhost/socket")).toBe(true);
    expect(isLoopbackTlsUrl("https://example.com")).toBe(false);
    expect(isLoopbackTlsUrl("http://localhost:3000")).toBe(false);
  });

  test("rewrites clicked localhost URLs through VSCODE_PROXY_URI", () => {
    expect(
      rewriteWithVscodeProxyUri({
        url: "http://localhost:5173/src/main.tsx?cache=1#module",
        vscodeProxyUri: TEMPLATE,
      }),
    ).toBe("https://5173--main--coder--iamriajul.coder.riajul.dev/src/main.tsx?cache=1#module");
  });

  test("uses default HTTP and HTTPS ports when omitted", () => {
    expect(
      rewriteWithVscodeProxyUri({
        url: "http://localhost/",
        vscodeProxyUri: TEMPLATE,
      }),
    ).toBe("https://80--main--coder--iamriajul.coder.riajul.dev/");
    expect(
      rewriteWithVscodeProxyUri({
        url: "https://localhost/",
        vscodeProxyUri: TEMPLATE,
      }),
    ).toBe("https://443--main--coder--iamriajul.coder.riajul.dev/");
  });

  test("does not rewrite without a valid template", () => {
    expect(
      rewriteWithVscodeProxyUri({
        url: "http://localhost:5173",
        vscodeProxyUri: "https://example.com",
      }),
    ).toBeNull();
    expect(
      rewriteWithVscodeProxyUri({
        url: "https://example.com",
        vscodeProxyUri: TEMPLATE,
      }),
    ).toBeNull();
  });
});
