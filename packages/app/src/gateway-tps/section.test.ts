/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { gatewayTpsCopy } from "./copy";
import { GatewayTpsSection } from "./section";

describe("gatewayTpsCopy", () => {
  it("states the rate in tokens per second", () => {
    expect(gatewayTpsCopy.rate(250)).toBe("250 tokens/sec");
  });

  it("keeps one decimal below 100 so a slow model stays readable", () => {
    expect(gatewayTpsCopy.rate(42.35)).toBe("42.4 tokens/sec");
    expect(gatewayTpsCopy.rate(99.9)).toBe("99.9 tokens/sec");
  });

  it("never reports a rate for a request that produced nothing", () => {
    expect(gatewayTpsCopy.rate(0)).toBe("0 tokens/sec");
    expect(gatewayTpsCopy.rate(Number.NaN)).toBe("0 tokens/sec");
  });

  it("names the output tokens and generation time the rate came from", () => {
    expect(gatewayTpsCopy.detail(900, 3600)).toBe("900 output tokens in 3.6s of generation");
    expect(gatewayTpsCopy.detail(4200, 12_400)).toBe("4200 output tokens in 12s of generation");
  });
});

describe("GatewayTpsSection", () => {
  // The section is not exercised through React here: it renders inside the
  // shared `Tooltip`, and `src/components/ui/tooltip.tsx` cannot render under
  // this jsdom transform (it throws "React is not defined" on its own,
  // independent of this component). The hidden-sample contract is the observable
  // one that matters, and the strings it renders are covered above.
  it("returns nothing when the host has no sample", () => {
    expect(GatewayTpsSection({ sample: null })).toBeNull();
  });
});
