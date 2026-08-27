export function shouldShowAgentTrackBar({
  hasOfficialTracks,
  hasWorkspaceDiffStat,
  hasExtraPills,
}: {
  hasOfficialTracks: boolean;
  hasWorkspaceDiffStat: boolean;
  hasExtraPills: boolean;
}): boolean {
  return hasOfficialTracks || hasWorkspaceDiffStat || hasExtraPills;
}
