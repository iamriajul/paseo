import type { PinnedTabTarget } from "@/workspace-pins/target";

const TERMINAL_PROFILE_PREFIX = "terminal-profile:";

export function launchItemPinTarget(itemId: string): PinnedTabTarget | null {
  switch (itemId) {
    case "agent":
      return { kind: "draft" };
    case "terminal":
      return { kind: "terminal" };
    case "browser":
      return { kind: "browser" };
    case "code-server":
      return { kind: "codeServer" };
    default:
      if (itemId.startsWith(TERMINAL_PROFILE_PREFIX)) {
        return { kind: "profile", profileId: itemId.slice(TERMINAL_PROFILE_PREFIX.length) };
      }
      return null;
  }
}

export function pinTargetLaunchItemId(target: PinnedTabTarget): string {
  switch (target.kind) {
    case "draft":
      return "agent";
    case "terminal":
      return "terminal";
    case "browser":
      return "browser";
    case "codeServer":
      return "code-server";
    case "profile":
      return `${TERMINAL_PROFILE_PREFIX}${target.profileId}`;
  }
}
