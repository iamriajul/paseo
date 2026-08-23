import { describe, expect, it } from "vitest";
import { parseBrowserPreviewTemplate } from "./url-template.js";
import { transformPreviewResponseHeaders } from "./response-headers.js";

const template = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
const run = (headers: NodeJS.Dict<string | string[]>, targetPort = 4000) =>
  transformPreviewResponseHeaders({ headers, targetPort, template });

describe("transformPreviewResponseHeaders", () => {
  it("strips framing and policy headers so the page can be embedded", () => {
    const out = run({
      "content-security-policy": "frame-ancestors 'none'",
      "content-security-policy-report-only": "default-src 'self'",
      "x-frame-options": "DENY",
      "content-type": "text/html",
    });
    expect(out["content-security-policy"]).toBeUndefined();
    expect(out["content-security-policy-report-only"]).toBeUndefined();
    expect(out["x-frame-options"]).toBeUndefined();
    expect(out["content-type"]).toBe("text/html");
  });

  it("rewrites an absolute loopback Location on the target port", () => {
    const out = run({ location: "http://localhost:4000/generate?from=auth#done" });
    expect(out.location).toBe("https://4000--daemon-1.studio.example.com/generate?from=auth#done");
  });

  it("rewrites 127.0.0.1 and [::1] forms on the target port", () => {
    expect(run({ location: "http://127.0.0.1:4000/x" }).location).toBe(
      "https://4000--daemon-1.studio.example.com/x",
    );
    expect(run({ location: "http://[::1]:4000/x" }).location).toBe(
      "https://4000--daemon-1.studio.example.com/x",
    );
  });

  it("rewrites content-location the same way", () => {
    expect(run({ "content-location": "http://localhost:4000/y" })["content-location"]).toBe(
      "https://4000--daemon-1.studio.example.com/y",
    );
  });

  it("rewrites the URL inside a refresh header and keeps the delay", () => {
    expect(run({ refresh: "0; url=http://localhost:4000/z" }).refresh).toBe(
      "0; url=https://4000--daemon-1.studio.example.com/z",
    );
  });

  it("leaves relative redirects untouched so the browser keeps the proxy origin", () => {
    expect(run({ location: "/about" }).location).toBe("/about");
    expect(run({ location: "?page=2" }).location).toBe("?page=2");
  });

  it("leaves loopback redirects on a different port untouched", () => {
    expect(run({ location: "http://localhost:9999/x" }).location).toBe("http://localhost:9999/x");
  });

  it("leaves non-loopback redirects untouched", () => {
    expect(run({ location: "https://example.com/x" }).location).toBe("https://example.com/x");
  });
});
