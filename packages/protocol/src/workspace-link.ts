/**
 * Links agents write so one tap opens a workspace, or its main preview, in the
 * Paseo app: `paseo://h/<serverId>/workspace/<workspaceId>[/preview]`.
 * The daemon builds them into its workspace tool results; the app opens them
 * from any Markdown surface. Same scheme and host shape as agent deep links.
 */
export type WorkspaceLinkView = "workspace" | "preview";

export interface WorkspaceLinkTarget {
  serverId: string;
  workspaceId: string;
  view: WorkspaceLinkView;
}

const WORKSPACE_LINK_PATTERN = /^paseo:\/\/h\/([^/?#\s]+)\/workspace\/([^/?#\s]+)(\/preview)?\/?$/i;

export function buildWorkspaceLinkUrl(target: WorkspaceLinkTarget): string {
  const serverId = target.serverId.trim();
  const workspaceId = target.workspaceId.trim();
  if (!serverId || !workspaceId) {
    throw new Error("Workspace links require a server ID and workspace ID.");
  }
  const base = `paseo://h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(workspaceId)}`;
  return target.view === "preview" ? `${base}/preview` : base;
}

/** `[label](url)`, with the label escaped so a title cannot break the link. */
export function buildWorkspaceMarkdownLink(label: string, url: string): string {
  const escaped = label
    .replace(/[\\[\]]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim();
  return `[${escaped || url}](${url})`;
}

export function parseWorkspaceLink(input: string): WorkspaceLinkTarget | null {
  const match = WORKSPACE_LINK_PATTERN.exec(input.trim());
  if (!match) {
    return null;
  }
  try {
    const serverId = decodeURIComponent(match[1] ?? "").trim();
    const workspaceId = decodeURIComponent(match[2] ?? "").trim();
    if (!serverId || !workspaceId) {
      return null;
    }
    return { serverId, workspaceId, view: match[3] ? "preview" : "workspace" };
  } catch {
    return null;
  }
}

interface PreviewCandidate {
  type: string;
  preview?: boolean;
}

/** The service paseo.json marks `"preview": true`; the daemon flags at most one. */
export function findMainPreviewScript<T extends PreviewCandidate>(scripts: readonly T[]): T | null {
  return scripts.find((script) => script.type === "service" && script.preview === true) ?? null;
}

export interface WorkspaceLinkFields {
  /** Markdown link to the workspace, ready to paste into a reply. */
  link: string;
  url: string;
  /** Markdown link that opens the workspace's main preview; only when it has one. */
  previewLink?: string;
  previewUrl?: string;
}

export function buildWorkspaceLinkFields(input: {
  serverId: string;
  workspaceId: string;
  label: string;
  hasPreview: boolean;
}): WorkspaceLinkFields {
  const url = buildWorkspaceLinkUrl({ ...input, view: "workspace" });
  const fields: WorkspaceLinkFields = {
    link: buildWorkspaceMarkdownLink(input.label, url),
    url,
  };
  if (input.hasPreview) {
    const previewUrl = buildWorkspaceLinkUrl({ ...input, view: "preview" });
    fields.previewLink = buildWorkspaceMarkdownLink(`${input.label} preview`, previewUrl);
    fields.previewUrl = previewUrl;
  }
  return fields;
}
