import type { StreamItem } from "@/types/stream";

export interface ChatHistorySearchFilters {
  includeUser: boolean;
  includeAssistant: boolean;
}

export interface ChatHistorySearchMatch {
  id: string;
  kind: "user_message" | "assistant_message";
}

export function normalizeChatHistoryQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function findChatHistoryMatches(
  items: readonly StreamItem[],
  query: string,
  filters: ChatHistorySearchFilters,
): ChatHistorySearchMatch[] {
  const normalizedQuery = normalizeChatHistoryQuery(query);
  if (!normalizedQuery || (!filters.includeUser && !filters.includeAssistant)) {
    return [];
  }

  return items.flatMap((item): ChatHistorySearchMatch[] => {
    const isIncluded =
      (item.kind === "user_message" && filters.includeUser) ||
      (item.kind === "assistant_message" && filters.includeAssistant);
    if (!isIncluded || !item.text.toLocaleLowerCase().includes(normalizedQuery)) {
      return [];
    }
    return [{ id: item.id, kind: item.kind }];
  });
}

export function selectInitialChatHistoryMatch(matches: readonly ChatHistorySearchMatch[]) {
  return matches.at(-1)?.id ?? null;
}

export function preserveOrSelectChatHistoryMatch(
  matches: readonly ChatHistorySearchMatch[],
  currentId: string | null,
): string | null {
  if (currentId && matches.some((match) => match.id === currentId)) {
    return currentId;
  }
  return selectInitialChatHistoryMatch(matches);
}

export function navigateChatHistoryMatches(
  matches: readonly ChatHistorySearchMatch[],
  currentId: string | null,
  direction: "next" | "previous",
): string | null {
  if (matches.length === 0) {
    return null;
  }
  const currentIndex = matches.findIndex((match) => match.id === currentId);
  if (currentIndex < 0) {
    return selectInitialChatHistoryMatch(matches);
  }
  const offset = direction === "next" ? 1 : -1;
  return matches[(currentIndex + offset + matches.length) % matches.length]?.id ?? null;
}
