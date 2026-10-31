import type { ReviewDraftComment } from "@/review/store";
import { useReviewDraftStore } from "@/review/store";
import { selectHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { clientReviewKeyToWireKey } from "./keys";

export interface ReviewHostSyncClient {
  getUiState: (input: { namespace: "composer" | "review"; key: string }) => Promise<{
    error: string | null;
    record: {
      comments?: ReviewDraftComment[];
      updatedAt: string;
    } | null;
  }>;
  upsertUiState: (input: {
    namespace: "composer" | "review";
    key: string;
    record: {
      comments?: Array<{
        id: string;
        filePath: string;
        side: "old" | "new";
        lineNumber: number;
        body: string;
        createdAt: string;
        updatedAt: string;
      }>;
      updatedAt: string;
    };
  }) => Promise<unknown>;
  clearUiState: (input: {
    namespace: "composer" | "review";
    key: string;
    updatedAt: string;
  }) => Promise<unknown>;
}

export async function hydrateReviewFromHost(input: {
  client: ReviewHostSyncClient;
  clientReviewKey: string;
}): Promise<void> {
  const wireKey = clientReviewKeyToWireKey(input.clientReviewKey);
  if (!wireKey) {
    return;
  }
  const payload = await input.client.getUiState({
    namespace: "review",
    key: wireKey,
  });
  if (payload.error || !payload.record) {
    return;
  }
  const comments = (payload.record.comments ?? []) as ReviewDraftComment[];
  useReviewDraftStore.setState((state) => ({
    drafts: {
      ...state.drafts,
      [input.clientReviewKey]: comments,
    },
  }));
}

export async function upsertReviewOnHost(input: {
  client: ReviewHostSyncClient;
  clientReviewKey: string;
  comments: readonly ReviewDraftComment[];
}): Promise<void> {
  const wireKey = clientReviewKeyToWireKey(input.clientReviewKey);
  if (!wireKey) {
    return;
  }
  try {
    await input.client.upsertUiState({
      namespace: "review",
      key: wireKey,
      record: {
        comments: input.comments.map((comment) => ({
          id: comment.id,
          filePath: comment.filePath,
          side: comment.side,
          lineNumber: comment.lineNumber,
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        })),
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error: unknown) {
    console.warn("[ui-state] review upsert failed", error);
  }
}

export async function clearReviewOnHost(input: {
  client: ReviewHostSyncClient;
  clientReviewKey: string;
}): Promise<void> {
  const wireKey = clientReviewKeyToWireKey(input.clientReviewKey);
  if (!wireKey) {
    return;
  }
  try {
    await input.client.clearUiState({
      namespace: "review",
      key: wireKey,
      updatedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.warn("[ui-state] review clear failed", error);
  }
}

export function readReviewDraftHostServerId(reviewDraftKey: string): string | null {
  const match = /(?:^|:)server=([^:]+)(?::|$)/.exec(reviewDraftKey);
  return match?.[1] ?? null;
}

/** Mirrors the local draft to its host, so a later hydrate cannot bring back what was removed. */
export function syncReviewDraftToHost(reviewDraftKey: string): void {
  const hostServerId = readReviewDraftHostServerId(reviewDraftKey);
  if (!hostServerId || !selectHostFeature(useSessionStore.getState(), hostServerId, "uiState")) {
    return;
  }
  const client = getHostRuntimeStore().getClient(hostServerId);
  if (!client) {
    return;
  }
  const comments = useReviewDraftStore.getState().drafts[reviewDraftKey] ?? [];
  void upsertReviewOnHost({ client, clientReviewKey: reviewDraftKey, comments });
}

export function handleUiStateUpdatedForReview(input: {
  message: {
    type: string;
    namespace?: string;
    key?: string;
    record?: { comments?: ReviewDraftComment[] } | null;
  };
  clientReviewKey: string;
  wireKey: string;
}): void {
  if (input.message.type !== "ui_state.updated") {
    return;
  }
  if (input.message.namespace !== "review" || input.message.key !== input.wireKey) {
    return;
  }
  if (input.message.record == null) {
    useReviewDraftStore.setState((state) => {
      const next = { ...state.drafts };
      delete next[input.clientReviewKey];
      return { drafts: next };
    });
    return;
  }
  const comments = input.message.record.comments ?? [];
  useReviewDraftStore.setState((state) => ({
    drafts: {
      ...state.drafts,
      [input.clientReviewKey]: comments,
    },
  }));
}
