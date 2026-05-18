export type MessageKind =
  | "text_turn"
  | "segmentable_text"
  | "visible_message"
  | "browsable_message"
  | "reaction_add"
  | "reaction_remove"
  | "object_message"
  | "all_row";

export type MessageKindRow = {
  associated_message_type: number | null;
  text?: string | null;
};

const NORMAL_MESSAGE = "(associated_message_type IS NULL OR associated_message_type = 0)";
const NON_REACTION_MESSAGE = "(associated_message_type IS NULL OR associated_message_type < 2000)";
const HAS_TEXT = "(text IS NOT NULL AND text != '')";

export function realMessageWhere(kind: MessageKind, alias?: string) {
  const prefix = alias ? `${alias}.` : "";
  return predicateFor(kind)
    .replaceAll("associated_message_type", `${prefix}associated_message_type`)
    .replaceAll("text", `${prefix}text`);
}

export function isRealMessage(row: MessageKindRow, kind: MessageKind) {
  const type = row.associated_message_type;
  switch (kind) {
    case "text_turn":
      return type == null || type === 0;
    case "segmentable_text":
      return (type == null || type === 0) && Boolean(row.text?.trim());
    case "visible_message":
    case "browsable_message":
      return type == null || type < 2000;
    case "reaction_add":
      return type != null && type >= 2000 && type < 3000;
    case "reaction_remove":
      return type != null && type >= 3000 && type < 4000;
    case "object_message":
      return type != null && type > 0 && type < 2000;
    case "all_row":
      return true;
  }
}

function predicateFor(kind: MessageKind) {
  switch (kind) {
    case "text_turn":
      return NORMAL_MESSAGE;
    case "segmentable_text":
      return `${NORMAL_MESSAGE} AND ${HAS_TEXT}`;
    case "visible_message":
    case "browsable_message":
      return NON_REACTION_MESSAGE;
    case "reaction_add":
      return "(associated_message_type >= 2000 AND associated_message_type < 3000)";
    case "reaction_remove":
      return "(associated_message_type >= 3000 AND associated_message_type < 4000)";
    case "object_message":
      return "(associated_message_type > 0 AND associated_message_type < 2000)";
    case "all_row":
      return "1=1";
  }
}
