import { describe, expect, it } from "vitest";
import {
  type HostAppearanceSource,
  defaultHostAppearance,
  selectHostBadges,
} from "@/hosts/appearance";

function host(
  serverId: string,
  label: string,
  appearance = defaultHostAppearance(),
): HostAppearanceSource {
  return { serverId, label, appearance };
}

describe("selectHostBadges showIcon", () => {
  it("omits the server glyph when showIcon is false", () => {
    const badges = selectHostBadges({
      hosts: [host("beta", "Beta")],
      localServerId: null,
      enabled: true,
      showIcon: false,
    });
    expect(badges.get("beta")).toEqual({
      serverId: "beta",
      label: "Beta",
      color: "none",
      showLabel: true,
      showIcon: false,
    });
  });
});
