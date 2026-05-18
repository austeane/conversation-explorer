export type Sender = "me" | "them";
export type SenderKey = "me" | "them";

export const SENDERS: Array<{ key: SenderKey; label: Sender; isFromMe: 0 | 1 }> = [
  { key: "me", label: "me", isFromMe: 1 },
  { key: "them", label: "them", isFromMe: 0 },
];

export function senderFor(isFromMe: 0 | 1 | boolean | number): Sender {
  return isFromMe === 1 || isFromMe === true ? "me" : "them";
}

export function senderKeyFor(isFromMe: 0 | 1 | boolean | number): SenderKey {
  return senderFor(isFromMe);
}
