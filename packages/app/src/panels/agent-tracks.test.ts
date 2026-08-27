import { describe, expect, it } from "vitest";
import { shouldShowAgentTrackBar } from "./agent-tracks-visibility";

describe("shouldShowAgentTrackBar", () => {
  it("shows the bar when only fork extra pills exist", () => {
    expect(
      shouldShowAgentTrackBar({
        hasOfficialTracks: false,
        hasWorkspaceDiffStat: false,
        hasExtraPills: true,
      }),
    ).toBe(true);
  });

  it("hides the bar when official tracks, diff, and fork pills are all empty", () => {
    expect(
      shouldShowAgentTrackBar({
        hasOfficialTracks: false,
        hasWorkspaceDiffStat: false,
        hasExtraPills: false,
      }),
    ).toBe(false);
  });
});
