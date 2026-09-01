export function buildNewWorkspaceDraftKey(input: {
  selectedServerId: string;
  selectedSourceDirectory: string | null;
  draftId?: string;
}): string {
  const explicitDraftId = input.draftId?.trim();
  if (explicitDraftId) {
    return `new-workspace:draft:${explicitDraftId}`;
  }
  return `new-workspace:${input.selectedServerId}:${input.selectedSourceDirectory ?? "choose-project"}`;
}
