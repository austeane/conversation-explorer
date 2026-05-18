import type { CollapsedTurn, TurnMessage } from "./turns";

export const REPLY_6H = 6 * 60 * 60;
export const REPLY_24H = 24 * 60 * 60;
export const REPLY_48H = 48 * 60 * 60;

export type ReplyPair<T extends TurnMessage = TurnMessage> = {
  source: CollapsedTurn<T>;
  reply: CollapsedTurn<T>;
  gap_seconds: number;
  direction: "me_to_them" | "them_to_me";
};

export function pairReplies<T extends TurnMessage>(
  turns: Array<CollapsedTurn<T>>,
  windowSec = REPLY_24H,
): Array<ReplyPair<T>> {
  const pairs: Array<ReplyPair<T>> = [];
  for (let index = 0; index < turns.length - 1; index += 1) {
    const source = turns[index];
    const reply = turns[index + 1];
    if (source.is_from_me === reply.is_from_me) continue;
    const gapSeconds = reply.start_ts - source.end_ts;
    if (gapSeconds < 0 || gapSeconds > windowSec) continue;
    pairs.push({
      source,
      reply,
      gap_seconds: gapSeconds,
      direction: source.is_from_me === 1 ? "me_to_them" : "them_to_me",
    });
  }
  return pairs;
}
