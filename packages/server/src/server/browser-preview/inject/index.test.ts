import { describe, expect, it } from "vitest";
import { buildInjectedScripts } from "./index.js";
import { BRIDGE_SOURCE } from "./protocol.js";

describe("buildInjectedScripts", () => {
  const scripts = buildInjectedScripts();

  it("pins eruda at the audited version", () => {
    expect(scripts).toContain("https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js");
  });

  it("includes navigation, eruda and selector", () => {
    expect(scripts).toContain(BRIDGE_SOURCE);
    expect(scripts).toContain("eruda");
    expect(scripts).toContain("paseo-selector");
  });

  it("emits balanced script tags", () => {
    const open = scripts.match(/<script\b/g) ?? [];
    const close = scripts.match(/<\/script>/g) ?? [];
    expect(open.length).toBe(close.length);
    expect(open.length).toBeGreaterThan(0);
  });

  // An unescaped </script> inside a template literal terminates the injected
  // block early and dumps the remaining script source into the page as text.
  it("contains no raw closing script tag inside inline source", () => {
    const inline = scripts
      .split(/<\/script>/)
      .slice(0, -1)
      .join("");
    expect(inline).not.toMatch(/<\/script\b/);
  });
});
