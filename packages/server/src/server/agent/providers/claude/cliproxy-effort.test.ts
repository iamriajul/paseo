import { describe, expect, test } from "vitest";

import {
  buildCliproxyCapabilityList,
  buildCliproxyThinkingOptions,
  indexCliproxyEffortProfiles,
} from "./cliproxy-effort.js";
import type { GatewayCodexModelRow } from "../../gateway/models.js";

function codexRow(
  overrides: Partial<GatewayCodexModelRow> & { slug: string },
): GatewayCodexModelRow {
  return {
    displayName: overrides.slug,
    supportedReasoningEfforts: [],
    hidden: false,
    ...overrides,
  };
}

function optionIds(options: readonly { id: string }[]): string[] {
  return options.map((option) => option.id);
}

describe("indexCliproxyEffortProfiles", () => {
  test("reads the top rungs from the advertised reasoning levels", () => {
    const index = indexCliproxyEffortProfiles([
      codexRow({ slug: "muse-spark-1.3-contributor", supportedReasoningEfforts: ["low", "high"] }),
      codexRow({
        slug: "muse-spark-1.3",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    ]);

    expect(index.get("muse-spark-1.3-contributor")).toMatchObject({
      maxEffort: false,
      xhighEffort: false,
    });
    expect(index.get("muse-spark-1.3")).toMatchObject({ maxEffort: true, xhighEffort: true });
  });

  test("keeps the gateway display name for the model label", () => {
    const index = indexCliproxyEffortProfiles([
      codexRow({ slug: "grok-4.5", displayName: "Grok 4.5" }),
    ]);

    expect(index.get("grok-4.5")?.label).toBe("Grok 4.5");
  });

  test("omits a blank display name rather than setting an empty label", () => {
    const index = indexCliproxyEffortProfiles([codexRow({ slug: "muse", displayName: "  " })]);

    expect(index.get("muse")?.label).toBeUndefined();
  });
});

describe("buildCliproxyThinkingOptions", () => {
  test("drops max for a model the gateway does not list it for", () => {
    const options = buildCliproxyThinkingOptions({ maxEffort: false, xhighEffort: true });

    expect(optionIds(options)).toEqual(["low", "medium", "high", "xhigh", "ultracode"]);
  });

  test("drops Ultra Code along with xhigh, since it runs at xhigh", () => {
    const options = buildCliproxyThinkingOptions({ maxEffort: true, xhighEffort: false });

    expect(optionIds(options)).toEqual(["low", "medium", "high", "max"]);
  });

  test("keeps high as the default so known and unknown models agree", () => {
    for (const profile of [undefined, { maxEffort: true, xhighEffort: true }]) {
      const options = buildCliproxyThinkingOptions(profile);
      expect(options.find((option) => option.isDefault)?.id).toBe("high");
    }
  });

  test("keeps the full set for a model the catalog does not describe", () => {
    const options = buildCliproxyThinkingOptions(undefined);

    expect(optionIds(options)).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
  });
});

describe("buildCliproxyCapabilityList", () => {
  test("omits capabilities the model lacks so the CLI stops offering them", () => {
    expect(buildCliproxyCapabilityList({ maxEffort: false, xhighEffort: true })).toEqual([
      "effort",
      "xhigh_effort",
    ]);
    expect(buildCliproxyCapabilityList({ maxEffort: true, xhighEffort: false })).toEqual([
      "effort",
      "max_effort",
    ]);
  });

  test("keeps effort itself so the /effort command survives", () => {
    // Dropping `effort` would remove every level rather than cap the top one.
    expect(buildCliproxyCapabilityList({ maxEffort: false, xhighEffort: false })).toEqual([
      "effort",
    ]);
  });

  test("declares the full vocabulary for an unknown model", () => {
    expect(buildCliproxyCapabilityList(undefined)).toEqual([
      "effort",
      "xhigh_effort",
      "max_effort",
    ]);
  });
});
