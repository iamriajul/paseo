import { describe, expect, test } from "vitest";

import { isLoopbackHttpUrl, rewriteWithVscodeProxyUri } from "./localhost-url";

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
