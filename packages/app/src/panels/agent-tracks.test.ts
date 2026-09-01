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

  it("shows the bar when workspace todos exist", () => {
    expect(
      shouldShowAgentTrackBar({
        hasOfficialTracks: false,
        hasWorkspaceDiffStat: false,
        hasWorkspaceTodos: true,
        hasExtraPills: false,
      }),
    ).toBe(true);
  });

  it("hides the bar when official tracks, diff, todos, and fork pills are all empty", () => {
    expect(
      shouldShowAgentTrackBar({
        hasOfficialTracks: false,
        hasWorkspaceDiffStat: false,
        hasWorkspaceTodos: false,
        hasExtraPills: false,
      }),
    ).toBe(false);
  });
});
