export function shouldShowAgentTrackBar({
  hasOfficialTracks,
  hasWorkspaceDiffStat,
  hasWorkspaceTodos = false,
  hasExtraPills,
}: {
  hasOfficialTracks: boolean;
  hasWorkspaceDiffStat: boolean;
  hasWorkspaceTodos?: boolean;
  hasExtraPills: boolean;
}): boolean {
  return hasOfficialTracks || hasWorkspaceDiffStat || hasWorkspaceTodos || hasExtraPills;
}
