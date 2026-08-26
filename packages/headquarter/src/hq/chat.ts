/**
 * Direct-chat / executive-room presentation contracts (issue #43, order 1).
 *
 * Presentation-layer only: these types are the contract a chat/message
 * transport must satisfy to be displayed. Live transport belongs to the
 * operator/control-plane layer and is intentionally not implemented here.
 */

export interface ChatMessage {
  author: string;
  /** ISO-8601 instant. */
  at: string;
  text: string;
}

export interface ChatThread {
  id: string;
  title: string;
  /** e.g. ["founder", "claude"] for a direct chat; all executives for the room. */
  participants: string[];
  messages: ChatMessage[];
}

export interface Specialist {
  name: string;
  role: string;
  /** Lane: "executive", "implementation", "review", "research", "specialist-tool". */
  lane: string;
  /** e.g. "active", "on-demand", "future-planned". */
  status: string;
}
