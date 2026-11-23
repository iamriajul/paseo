import type { ReactNode, RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import type { ChatFindMark } from "./marks";

export interface MountedMessageIds {
  has(messageId: string): boolean;
}
export interface ChatFindProps {
  agentId: string;
  serverId: string;
  epoch: string | null;
  items: StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  revealLoadedMessage(messageId: string): boolean;
  visibleMessageIds: MountedMessageIds;
  children: ReactNode;
}
export interface ChatFindExpansionProps {
  messageId: string;
  /**
   * `mark` is the occurrence to highlight inside this message's own text. Web paints its
   * highlight over the rendered DOM and always passes null.
   */
  children(renderFullContent: boolean, mark: ChatFindMark | null): ReactNode;
}
export interface ChatFindPlainTextProps {
  messageId: string | undefined;
  text: string;
}
