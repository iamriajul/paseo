import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { ChatHistorySearchBar } from "@/agent-search/chat-history-search-bar";
import {
  findChatHistoryMatches,
  navigateChatHistoryMatches,
  normalizeChatHistoryQuery,
  preserveOrSelectChatHistoryMatch,
  selectInitialChatHistoryMatch,
} from "@/agent-search/chat-history-search";
import type { AgentStreamViewHandle } from "@/agent-stream/view";
import type { ToastApi } from "@/components/toast-host";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];

export interface ChatHistorySearchState {
  isSearchOpen: boolean;
  activeSearchResultId: string | null;
  bar: ReactElement | null;
}

export function useChatHistorySearch({
  serverId,
  agentId,
  isPaneFocused,
  streamViewRef,
  toast,
}: {
  serverId: string;
  agentId: string;
  isPaneFocused: boolean;
  streamViewRef: RefObject<AgentStreamViewHandle | null>;
  toast?: ToastApi | null;
}): ChatHistorySearchState {
  const streamItemsRaw = useSessionStore((state) =>
    state.sessions[serverId]?.agentStreamTail?.get(agentId),
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [includeUser, setIncludeUser] = useState(true);
  const [includeAssistant, setIncludeAssistant] = useState(true);
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null);
  const [searchBackfillState, setSearchBackfillState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [searchRetryKey, setSearchRetryKey] = useState(0);
  const searchInputRef = useRef<EditingTextInputHandle>(null);
  const searchGenerationRef = useRef(0);
  const previousSearchKeyRef = useRef("");
  const { hasOlder, loadAllOlder } = useLoadOlderAgentHistory({
    serverId,
    agentId,
    toast,
  });
  const searchMatches = useMemo(
    () =>
      findChatHistoryMatches(streamItems, searchQuery, {
        includeUser,
        includeAssistant,
      }),
    [includeAssistant, includeUser, searchQuery, streamItems],
  );
  const normalizedSearchQuery = normalizeChatHistoryQuery(searchQuery);
  const canSearch = normalizedSearchQuery.length > 0 && (includeUser || includeAssistant);
  const activeSearchIndex = searchMatches.findIndex((match) => match.id === activeSearchResultId);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    setActiveSearchResultId((current) => preserveOrSelectChatHistoryMatch(searchMatches, current));
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchMatches]);

  const closeSearch = useCallback(() => {
    searchGenerationRef.current += 1;
    setIsSearchOpen(false);
    setActiveSearchResultId(null);
    setSearchBackfillState("idle");
  }, []);

  const navigateSearch = useCallback(
    (direction: "next" | "previous") => {
      setActiveSearchResultId((current) =>
        navigateChatHistoryMatches(searchMatches, current, direction),
      );
    },
    [searchMatches],
  );
  const selectPreviousSearchResult = useCallback(
    () => navigateSearch("previous"),
    [navigateSearch],
  );
  const selectNextSearchResult = useCallback(() => navigateSearch("next"), [navigateSearch]);
  const retrySearch = useCallback(() => setSearchRetryKey((value) => value + 1), []);

  useKeyboardActionHandler({
    handlerId: `agent-search:${serverId}:${agentId}`,
    actions: ["agent.search"],
    enabled: isPaneFocused,
    priority: 250,
    isActive: () => isPaneFocused,
    handle: () => {
      openSearch();
      return true;
    },
  });

  useEffect(() => {
    const nextKey = `${normalizedSearchQuery}\u0000${includeUser}\u0000${includeAssistant}`;
    if (previousSearchKeyRef.current !== nextKey) {
      previousSearchKeyRef.current = nextKey;
      setActiveSearchResultId(selectInitialChatHistoryMatch(searchMatches));
      return;
    }
    setActiveSearchResultId((current) => preserveOrSelectChatHistoryMatch(searchMatches, current));
  }, [includeAssistant, includeUser, normalizedSearchQuery, searchMatches]);

  useEffect(() => {
    if (isSearchOpen && activeSearchResultId) {
      streamViewRef.current?.scrollToItem(activeSearchResultId);
    }
  }, [activeSearchResultId, isSearchOpen, streamViewRef]);

  useEffect(() => {
    if (!isSearchOpen || !canSearch) {
      return;
    }
    const generation = searchGenerationRef.current;
    setSearchBackfillState("loading");
    void loadAllOlder(() => searchGenerationRef.current === generation)
      .then((result) => {
        if (searchGenerationRef.current !== generation) return undefined;
        setSearchBackfillState(result === "failed" ? "error" : "idle");
        return undefined;
      })
      .catch(() => {
        if (searchGenerationRef.current === generation) setSearchBackfillState("error");
      });
  }, [canSearch, hasOlder, isSearchOpen, loadAllOlder, searchRetryKey]);

  useEffect(
    () => () => {
      searchGenerationRef.current += 1;
    },
    [],
  );

  const bar = isSearchOpen ? (
    <ChatHistorySearchBar
      ref={searchInputRef}
      query={searchQuery}
      onQueryChange={setSearchQuery}
      includeUser={includeUser}
      includeAssistant={includeAssistant}
      onIncludeUserChange={setIncludeUser}
      onIncludeAssistantChange={setIncludeAssistant}
      current={activeSearchIndex >= 0 ? activeSearchIndex + 1 : 0}
      total={searchMatches.length}
      isLoading={searchBackfillState === "loading"}
      isIncomplete={hasOlder || searchBackfillState === "error"}
      hasError={searchBackfillState === "error"}
      onPrevious={selectPreviousSearchResult}
      onNext={selectNextSearchResult}
      onRetry={retrySearch}
      onClose={closeSearch}
    />
  ) : null;

  return {
    isSearchOpen,
    activeSearchResultId: isSearchOpen ? activeSearchResultId : null,
    bar,
  };
}
