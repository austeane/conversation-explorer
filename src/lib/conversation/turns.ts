import { senderFor, type Sender } from "./senders";

export const TURN_GAP_20M = 20 * 60;
export const EPISODE_GAP_2H = 2 * 60 * 60;
export const EPISODE_GAP_6H = 6 * 60 * 60;

export type TurnMessage = {
  id?: number;
  ts: number;
  is_from_me: 0 | 1 | number | boolean;
  text?: string | null;
  word_count?: number | null;
};

export type CollapsedTurn<T extends TurnMessage = TurnMessage> = {
  id: number;
  sender: Sender;
  is_from_me: 0 | 1;
  start_ts: number;
  end_ts: number;
  message_count: number;
  word_count: number;
  text: string;
  messages: T[];
};

export function collapseTurns<T extends TurnMessage>(
  messages: T[],
  gapSec = TURN_GAP_20M,
): Array<CollapsedTurn<T>> {
  const ordered = [...messages].sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));
  const turns: Array<CollapsedTurn<T>> = [];
  let current: CollapsedTurn<T> | null = null;

  for (const message of ordered) {
    const isFromMe = normalizeIsFromMe(message.is_from_me);
    const sender = senderFor(isFromMe);
    if (!current || current.is_from_me !== isFromMe || message.ts - current.end_ts > gapSec) {
      current = {
        id: turns.length,
        sender,
        is_from_me: isFromMe,
        start_ts: message.ts,
        end_ts: message.ts,
        message_count: 0,
        word_count: 0,
        text: "",
        messages: [],
      };
      turns.push(current);
    }

    current.end_ts = Math.max(current.end_ts, message.ts);
    current.message_count += 1;
    current.word_count += message.word_count ?? wordCount(message.text);
    current.messages.push(message);
    current.text = joinText(current.text, message.text);
  }

  return turns;
}

function normalizeIsFromMe(value: 0 | 1 | number | boolean): 0 | 1 {
  return value === 1 || value === true ? 1 : 0;
}

function wordCount(text: string | null | undefined): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function joinText(current: string, next: string | null | undefined): string {
  const cleaned = (next ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return current;
  return current ? `${current} ${cleaned}` : cleaned;
}
