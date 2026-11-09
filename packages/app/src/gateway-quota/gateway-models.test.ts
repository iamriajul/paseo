import { describe, expect, test } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { buildGatewayModelOptions } from "./gateway-models";

function model(id: string, extra: Partial<AgentModelDefinition> = {}): AgentModelDefinition {
  return { provider: "claude", id, label: id.toUpperCase(), ...extra };
}

describe("buildGatewayModelOptions", () => {
  test("lists the agent's model first, then every gateway model by label", () => {
    const options = buildGatewayModelOptions(
      [
        model("claude-sonnet-5-5"),
        model("zeta", { metadata: { source: "cliproxyapi" } }),
        model("claude-opus-5-5", { metadata: { cliproxyapiAdvertised: true } }),
        model("alpha", { metadata: { source: "cliproxyapi" } }),
        model("hidden", { metadata: { source: "cliproxyapi" }, isSelectable: false }),
      ],
      "claude-opus-5-5",
    );
    expect(options.map((option) => option.id)).toEqual(["claude-opus-5-5", "alpha", "zeta"]);
    expect(options[0]?.label).toBe("CLAUDE-OPUS-5-5");
  });

  test("keeps the agent's model when the catalog has not loaded", () => {
    expect(buildGatewayModelOptions(undefined, "grok-4.6")).toEqual([
      { id: "grok-4.6", label: "grok-4.6" },
    ]);
  });
});
