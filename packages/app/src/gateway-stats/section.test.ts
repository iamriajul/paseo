/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { formatDuration, formatThroughput, gatewayStatsCopy } from "./copy";
import { buildStatsTableRows, GatewayStatsSection } from "./section";

const sample = {
  model: "grok-4.6",
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
  durationMs: 4200,
  ttftMs: 600,
  generationMs: 3600,
  inputTokens: 1200,
  outputTokens: 900,
  tps: 250,
  stream: true,
};

describe("formatDuration", () => {
  it("keeps one decimal below 10s and rounds to whole seconds above", () => {
    expect(formatDuration(600)).toBe("0.6s");
    expect(formatDuration(3600)).toBe("3.6s");
    expect(formatDuration(12_400)).toBe("12s");
  });

  it("never reports a negative or absent duration", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatThroughput", () => {
  it("rounds a fast model and keeps a slow one readable", () => {
    expect(formatThroughput(250)).toBe("250 tok/s");
    expect(formatThroughput(42.35)).toBe("42.4 tok/s");
    expect(formatThroughput(0)).toBe("0 tok/s");
  });
});

describe("buildStatsTableRows", () => {
  it("puts the Gateway's measurements before the rows derived from them", () => {
    expect(buildStatsTableRows(sample)).toEqual([
      { label: "First token", value: "0.6s", measured: true },
      { label: "Generating", value: "3.6s", measured: true },
      { label: "Total", value: "4.2s", measured: false },
      { label: "Throughput", value: "250 tok/s", measured: false },
      { label: "Ran", value: "5m ago", measured: false },
    ]);
  });

  it("makes the timing split add up to the total", () => {
    const rows = buildStatsTableRows(sample);
    const value = (label: string) => Number.parseFloat(rows.find((r) => r.label === label)!.value);
    // The reason TTFT is its own row: throughput is computed over generation
    // time alone, and the reader can see that from the layout.
    expect(value("First token") + value("Generating")).toBeCloseTo(value("Total"), 1);
  });

  it("omits the age rather than inventing copy when the timestamp is unreadable", () => {
    const rows = buildStatsTableRows({ ...sample, at: "not-a-date" });
    expect(rows.map((row) => row.label)).toEqual([
      "First token",
      "Generating",
      "Total",
      "Throughput",
    ]);
  });

  it("distinguishes a request that produced no output from a fast one", () => {
    const rows = buildStatsTableRows({ ...sample, tps: 0, outputTokens: 0, generationMs: 0 });
    expect(rows.find((row) => row.label === "Throughput")?.value).toBe("0 tok/s");
    expect(rows.find((row) => row.label === "Generating")?.value).toBe("0s");
  });
});

describe("gatewayStatsCopy", () => {
  it("names the section after the endpoint it reads", () => {
    expect(gatewayStatsCopy.title).toBe("CLIProxyAPI latest request");
  });
});

describe("GatewayStatsSection", () => {
  // Not exercised through React here: it renders inside the shared `Tooltip`,
  // and `src/components/ui/tooltip.tsx` cannot render under this jsdom transform
  // (it throws "React is not defined" on its own, independent of this component).
  it("returns nothing when the host has no sample", () => {
    expect(GatewayStatsSection({ sample: null })).toBeNull();
  });
});
