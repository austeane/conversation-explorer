import { senderFor, type Sender } from "./senders";
import type { TurnMessage } from "./turns";

export const RESTART_GAP_6H = 6 * 60 * 60;

export type Restart<T extends TurnMessage = TurnMessage> = {
  before: T;
  after: T;
  gap_seconds: number;
  previous_sender: Sender;
  restarted_by: Sender;
};

export function findRestarts<T extends TurnMessage>(
  messages: T[],
  gapSec = RESTART_GAP_6H,
): Array<Restart<T>> {
  const ordered = [...messages].sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));
  const restarts: Array<Restart<T>> = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const before = ordered[index - 1];
    const after = ordered[index];
    const gapSeconds = after.ts - before.ts;
    if (gapSeconds < gapSec) continue;
    restarts.push({
      before,
      after,
      gap_seconds: gapSeconds,
      previous_sender: senderFor(before.is_from_me),
      restarted_by: senderFor(after.is_from_me),
    });
  }

  return restarts;
}
