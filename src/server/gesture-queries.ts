import { createServerFn } from "@tanstack/react-start";
import { messageScopeInput, type MessageScope } from "~/lib/conversation/scope";
import { dayBounds } from "~/lib/conversation/time";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const TAPBACK_TYPE_MIN = 2000;
const REPLY_WINDOW_SECONDS = 6 * 60 * 60;
const MAX_EXAMPLES = 18;

export type Sender = "Me" | "Them";

export type GestureOverview = {
  generated_at: string;
  real_messages: number;
  tapbacks: number;
  threaded_replies: number;
  sent_objects: number;
  top_reaction: string;
  strongest_draw: string;
  busiest_object_channel: string;
};

export type GestureMonth = {
  ym: string;
  messages: number;
  tapbacks: number;
  hearts: number;
  laughs: number;
  threaded_replies: number;
  objects: number;
  links: number;
  games: number;
  media: number;
};

export type ReactionTypeCard = {
  key: string;
  label: string;
  count: number;
  from_me: number;
  from_them: number;
  target_me: number;
  target_them: number;
  median_delay_seconds: number | null;
  top_target_feature: string;
  target_feature_rate: number;
  examples: GestureExample[];
};

export type GestureDrawFeature = {
  key: string;
  label: string;
  description: string;
  baseline_count: number;
  reacted_count: number;
  baseline_rate: number;
  reacted_rate: number;
  lift: number;
  log_odds_z: number;
};

export type ThreadPattern = {
  key: string;
  label: string;
  description: string;
  count: number;
  me_replies: number;
  them_replies: number;
  median_gap_seconds: number | null;
  examples: GestureExample[];
};

export type ObjectChannel = {
  key: string;
  label: string;
  description: string;
  count: number;
  from_me: number;
  from_them: number;
  reply_rate: number;
  median_reply_seconds: number | null;
  peak_ym: string;
  examples: GestureExample[];
};

export type GestureExample = {
  kind: "tapback" | "thread" | "object";
  label: string;
  ts: number;
  ymd: string;
  sender: Sender;
  target_sender: Sender | null;
  delay_seconds: number | null;
  primary_text: string;
  response_text: string | null;
  context: string;
};

export type GestureResult = {
  overview: GestureOverview;
  months: GestureMonth[];
  reactions: ReactionTypeCard[];
  draw_features: GestureDrawFeature[];
  thread_patterns: ThreadPattern[];
  object_channels: ObjectChannel[];
  examples: GestureExample[];
};

type MessageRow = {
  id: number;
  guid: string | null;
  ts: number;
  ym: string;
  ymd: string;
  is_from_me: number;
  word_count: number;
  char_count: number;
  text: string | null;
  has_attachment: number;
  associated_message_type: number | null;
  associated_message_guid: string | null;
  reply_to_guid: string | null;
  thread_originator_guid: string | null;
  expressive_style: string | null;
  balloon_bundle_id: string | null;
  rich_link_url: string | null;
};

type TapbackEvent = {
  row: MessageRow;
  target: MessageRow;
  key: string;
  label: string;
  sender: Sender;
  targetSender: Sender;
  delaySeconds: number;
  targetFeatures: string[];
};

type ThreadEvent = {
  row: MessageRow;
  target: MessageRow;
  sender: Sender;
  targetSender: Sender;
  key: string;
  label: string;
  description: string;
  gapSeconds: number;
};

type ObjectEvent = {
  row: MessageRow;
  sender: Sender;
  key: string;
  label: string;
  description: string;
  response: MessageRow | null;
  responseSeconds: number | null;
};

type FeatureSpec = {
  key: string;
  label: string;
  description: string;
  test: (row: MessageRow) => boolean;
};

type ScopeBounds = {
  fromTs: number | null;
  toTs: number | null;
};

const FEATURE_SPECS: FeatureSpec[] = [
  {
    key: "media",
    label: "Images and media",
    description: "Messages carrying a photo, video, or cached attachment.",
    test: (row) => row.has_attachment === 1,
  },
  {
    key: "warmth",
    label: "Warm language",
    description: "Affection, pride, thanks, missing, sweetness, or explicit care.",
    test: (row) => /\b(love|miss|proud|sweet|cute|beautiful|handsome|thank|thanks|appreciate|grateful|heart|cuddle|kiss)\b/i.test(row.text ?? ""),
  },
  {
    key: "humor",
    label: "Play and laughter",
    description: "Laughter tokens, jokes, silliness, or playful escalation.",
    test: (row) => /\b(lol|lmao|haha|hehe|funny|hilarious|silly|ridiculous|wild)\b/i.test(row.text ?? ""),
  },
  {
    key: "logistics",
    label: "Logistics",
    description: "Timing, place, travel, food, or concrete coordination.",
    test: (row) => /\b(when|where|tonight|tomorrow|today|time|meet|come over|dinner|lunch|ride|pickup|pick up|drop off|leaving|arrive)\b/i.test(row.text ?? ""),
  },
  {
    key: "questions",
    label: "Questions",
    description: "Direct asks and question-mark turns.",
    test: (row) => (row.text ?? "").includes("?"),
  },
  {
    key: "links",
    label: "Links",
    description: "URLs, rich links, maps, articles, tickets, or other web objects.",
    test: (row) => Boolean(row.rich_link_url) || /\bhttps?:\/\//i.test(row.text ?? ""),
  },
  {
    key: "strain",
    label: "Strain",
    description: "Stress, tiredness, sadness, worry, fear, or difficulty.",
    test: (row) => /\b(sad|anxious|worried|worry|scared|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|overwhelmed|rough)\b/i.test(row.text ?? ""),
  },
  {
    key: "long",
    label: "Long turns",
    description: "Messages in the upper text-length range for this thread.",
    test: (row) => row.word_count >= 45,
  },
  {
    key: "short",
    label: "Tiny acknowledgements",
    description: "One to four word acknowledgements, often used as lightweight glue.",
    test: (row) => row.word_count > 0 && row.word_count <= 4,
  },
];

export const getGestures = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<GestureResult> => {
    const resolved = resolveMessageScope(data);
    const bounds = scopeBounds(resolved);
    return withDbCache(`gestures:${JSON.stringify(resolved)}`, () => {
      const rows = db()
        .prepare(
          `
          SELECT
            id,
            guid,
            ts,
            ym,
            ymd,
            is_from_me,
            word_count,
            char_count,
            text,
            has_attachment,
            associated_message_type,
            associated_message_guid,
            reply_to_guid,
            thread_originator_guid,
            expressive_style,
            balloon_bundle_id,
            rich_link_url
          FROM messages
          ORDER BY ts ASC, id ASC
        `,
        )
        .all() as MessageRow[];

      const guidMap = new Map<string, MessageRow>();
      for (const row of rows) {
        if (row.guid) guidMap.set(row.guid, row);
      }

      const allRealRows = rows.filter(isRealMessage);
      const scopedRealRows = allRealRows.filter((row) => rowInDateScope(row, bounds));
      const sourceRealRows = scopedRealRows.filter((row) => senderMatches(row, resolved.sender));
      const realIndex = new Map(scopedRealRows.map((row, index) => [row.id, index]));
      const tapbacks = buildTapbacks(rows, guidMap).filter(
        (event) => rowInDateScope(event.row, bounds) && senderMatches(event.row, resolved.sender),
      );
      const threadEvents = buildThreadEvents(sourceRealRows, guidMap);
      const objectEvents = buildObjectEvents(sourceRealRows, scopedRealRows, realIndex);
      const reactions = buildReactions(tapbacks);
      const drawFeatures = buildDrawFeatures(scopedRealRows, tapbacks);
      const objectChannels = buildObjectChannels(objectEvents);
      const threadPatterns = buildThreadPatterns(threadEvents);

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: sourceRealRows.length,
          tapbacks: tapbacks.length,
          threaded_replies: threadEvents.length,
          sent_objects: objectEvents.length,
          top_reaction: reactions[0]?.label ?? "n/a",
          strongest_draw: drawFeatures[0]?.label ?? "n/a",
          busiest_object_channel: objectChannels[0]?.label ?? "n/a",
        },
        months: buildMonths(sourceRealRows, tapbacks, threadEvents, objectEvents),
        reactions,
        draw_features: drawFeatures,
        thread_patterns: threadPatterns,
        object_channels: objectChannels,
        examples: buildExamples(tapbacks, threadEvents, objectEvents),
      };
    });
  });

function buildTapbacks(rows: MessageRow[], guidMap: Map<string, MessageRow>) {
  const events: TapbackEvent[] = [];

  for (const row of rows) {
    if ((row.associated_message_type ?? 0) < TAPBACK_TYPE_MIN || !row.associated_message_guid) {
      continue;
    }
    const targetGuid = normalizeAssociatedGuid(row.associated_message_guid);
    if (!targetGuid) continue;
    const target = guidMap.get(targetGuid);
    if (!target || !isRealMessage(target)) continue;
    const meta = reactionMeta(row);
    events.push({
      row,
      target,
      key: meta.key,
      label: meta.label,
      sender: senderFor(row),
      targetSender: senderFor(target),
      delaySeconds: Math.max(0, row.ts - target.ts),
      targetFeatures: FEATURE_SPECS.filter((feature) => feature.test(target)).map((feature) => feature.label),
    });
  }

  return events;
}

function buildThreadEvents(realRows: MessageRow[], guidMap: Map<string, MessageRow>) {
  const events: ThreadEvent[] = [];

  for (const row of realRows) {
    if (!row.reply_to_guid) continue;
    const target = guidMap.get(row.reply_to_guid);
    if (!target || !isRealMessage(target) || target.id === row.id) continue;
    const pattern = classifyThreadTarget(target);
    events.push({
      row,
      target,
      sender: senderFor(row),
      targetSender: senderFor(target),
      key: pattern.key,
      label: pattern.label,
      description: pattern.description,
      gapSeconds: Math.max(0, row.ts - target.ts),
    });
  }

  return events;
}

function buildObjectEvents(sourceRows: MessageRow[], responseRows: MessageRow[], realIndex: Map<number, number>) {
  const events: ObjectEvent[] = [];

  for (const row of sourceRows) {
    const channel = classifyObject(row);
    if (!channel) continue;
    const response = nextOtherReply(row, responseRows, realIndex);
    events.push({
      row,
      sender: senderFor(row),
      key: channel.key,
      label: channel.label,
      description: channel.description,
      response,
      responseSeconds: response ? response.ts - row.ts : null,
    });
  }

  return events;
}

function buildReactions(events: TapbackEvent[]): ReactionTypeCard[] {
  const groups = groupBy(events, (event) => event.key);
  return [...groups.entries()]
    .map(([key, rows]) => {
      const featureCounts = countMap(rows.flatMap((event) => event.targetFeatures));
      const topFeature = [...featureCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const examples = rows
        .slice()
        .sort((a, b) => a.delaySeconds - b.delaySeconds || b.target.word_count - a.target.word_count)
        .slice(0, 2)
        .map(tapbackExample);
      return {
        key,
        label: rows[0]?.label ?? key,
        count: rows.length,
        from_me: rows.filter((event) => event.sender === "Me").length,
        from_them: rows.filter((event) => event.sender === "Them").length,
        target_me: rows.filter((event) => event.targetSender === "Me").length,
        target_them: rows.filter((event) => event.targetSender === "Them").length,
        median_delay_seconds: median(rows.map((event) => event.delaySeconds)),
        top_target_feature: topFeature?.[0] ?? "No dominant feature",
        target_feature_rate: rate(topFeature?.[1] ?? 0, rows.length),
        examples,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 9);
}

function buildDrawFeatures(realRows: MessageRow[], events: TapbackEvent[]): GestureDrawFeature[] {
  const reactedTargetIds = new Set(events.map((event) => event.target.id));
  const reactedTargets = realRows.filter((row) => reactedTargetIds.has(row.id));
  const baselineTotal = realRows.length;
  const reactedTotal = reactedTargets.length;

  return FEATURE_SPECS.map((feature) => {
    const baselineCount = realRows.filter(feature.test).length;
    const reactedCount = reactedTargets.filter(feature.test).length;
    const baselineRate = rate(baselineCount, baselineTotal);
    const reactedRate = rate(reactedCount, reactedTotal);
    return {
      key: feature.key,
      label: feature.label,
      description: feature.description,
      baseline_count: baselineCount,
      reacted_count: reactedCount,
      baseline_rate: baselineRate,
      reacted_rate: reactedRate,
      lift: baselineRate === 0 ? 0 : reactedRate / baselineRate,
      log_odds_z: logOddsZ(reactedCount, reactedTotal - reactedCount, baselineCount, baselineTotal - baselineCount),
    };
  })
    .filter((feature) => feature.reacted_count >= 8)
    .sort((a, b) => b.log_odds_z - a.log_odds_z || b.lift - a.lift)
    .slice(0, 8);
}

function buildThreadPatterns(events: ThreadEvent[]): ThreadPattern[] {
  const groups = groupBy(events, (event) => event.key);
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      label: rows[0]?.label ?? key,
      description: rows[0]?.description ?? "",
      count: rows.length,
      me_replies: rows.filter((event) => event.sender === "Me").length,
      them_replies: rows.filter((event) => event.sender === "Them").length,
      median_gap_seconds: median(rows.map((event) => event.gapSeconds)),
      examples: rows
        .slice()
        .sort((a, b) => a.gapSeconds - b.gapSeconds || b.target.word_count - a.target.word_count)
        .slice(0, 2)
        .map(threadExample),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function buildObjectChannels(events: ObjectEvent[]): ObjectChannel[] {
  const groups = groupBy(events, (event) => event.key);
  return [...groups.entries()]
    .map(([key, rows]) => {
      const monthCounts = countMap(rows.map((event) => event.row.ym));
      const peak = [...monthCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      const replied = rows.filter((event) => event.responseSeconds != null);
      return {
        key,
        label: rows[0]?.label ?? key,
        description: rows[0]?.description ?? "",
        count: rows.length,
        from_me: rows.filter((event) => event.sender === "Me").length,
        from_them: rows.filter((event) => event.sender === "Them").length,
        reply_rate: rate(replied.length, rows.length),
        median_reply_seconds: median(replied.map((event) => event.responseSeconds).filter((seconds): seconds is number => seconds != null)),
        peak_ym: peak?.[0] ?? "n/a",
        examples: rows
          .slice()
          .sort((a, b) => (a.responseSeconds ?? Number.MAX_SAFE_INTEGER) - (b.responseSeconds ?? Number.MAX_SAFE_INTEGER))
          .slice(0, 2)
          .map(objectExample),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 7);
}

function buildMonths(
  realRows: MessageRow[],
  tapbacks: TapbackEvent[],
  threadEvents: ThreadEvent[],
  objectEvents: ObjectEvent[],
): GestureMonth[] {
  const months = new Map<string, GestureMonth>();
  const ensure = (ym: string) => {
    const existing = months.get(ym);
    if (existing) return existing;
    const month = {
      ym,
      messages: 0,
      tapbacks: 0,
      hearts: 0,
      laughs: 0,
      threaded_replies: 0,
      objects: 0,
      links: 0,
      games: 0,
      media: 0,
    };
    months.set(ym, month);
    return month;
  };

  for (const row of realRows) {
    ensure(row.ym).messages += 1;
  }
  for (const event of tapbacks) {
    const month = ensure(event.row.ym);
    month.tapbacks += 1;
    if (event.key.includes("heart") || event.key === "emoji_heart") month.hearts += 1;
    if (event.key.includes("laugh") || event.key === "emoji_laugh") month.laughs += 1;
  }
  for (const event of threadEvents) {
    ensure(event.row.ym).threaded_replies += 1;
  }
  for (const event of objectEvents) {
    const month = ensure(event.row.ym);
    month.objects += 1;
    if (event.key === "link" || event.key === "location") month.links += 1;
    if (event.key === "game") month.games += 1;
    if (event.key === "media") month.media += 1;
  }

  return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

function buildExamples(tapbacks: TapbackEvent[], threads: ThreadEvent[], objects: ObjectEvent[]) {
  const selected: GestureExample[] = [];
  const seen = new Set<string>();

  for (const reaction of distinctBy(tapbacks.sort((a, b) => b.target.word_count - a.target.word_count), (event) => event.key)) {
    addExample(selected, seen, tapbackExample(reaction));
  }
  for (const thread of distinctBy(threads.sort((a, b) => b.target.word_count - a.target.word_count), (event) => event.key)) {
    addExample(selected, seen, threadExample(thread));
  }
  for (const object of distinctBy(objects.sort((a, b) => b.row.word_count - a.row.word_count), (event) => event.key)) {
    addExample(selected, seen, objectExample(object));
  }

  return selected.slice(0, MAX_EXAMPLES);
}

function addExample(selected: GestureExample[], seen: Set<string>, example: GestureExample) {
  const key = `${example.kind}-${example.ts}-${example.primary_text}`;
  if (seen.has(key)) return;
  seen.add(key);
  selected.push(example);
}

function tapbackExample(event: TapbackEvent): GestureExample {
  return {
    kind: "tapback",
    label: event.label,
    ts: event.row.ts,
    ymd: event.target.ymd,
    sender: event.sender,
    target_sender: event.targetSender,
    delay_seconds: event.delaySeconds,
    primary_text: preview(event.target.text, event.target.has_attachment === 1 ? "an attachment" : "message"),
    response_text: preview(event.row.text, "tapback"),
    context: `${event.sender} reacted to ${event.targetSender}`,
  };
}

function threadExample(event: ThreadEvent): GestureExample {
  return {
    kind: "thread",
    label: event.label,
    ts: event.row.ts,
    ymd: event.target.ymd,
    sender: event.sender,
    target_sender: event.targetSender,
    delay_seconds: event.gapSeconds,
    primary_text: preview(event.target.text, event.target.has_attachment === 1 ? "an attachment" : "anchored message"),
    response_text: preview(event.row.text, "thread reply"),
    context: `${event.sender} replied to a ${event.label.toLowerCase()} anchor`,
  };
}

function objectExample(event: ObjectEvent): GestureExample {
  return {
    kind: "object",
    label: event.label,
    ts: event.row.ts,
    ymd: event.row.ymd,
    sender: event.sender,
    target_sender: event.response ? senderFor(event.response) : null,
    delay_seconds: event.responseSeconds,
    primary_text: preview(event.row.text, objectFallback(event.row)),
    response_text: event.response ? preview(event.response.text, "reply") : null,
    context: event.response ? `${event.label} got a reply` : `${event.label} without a fast text reply`,
  };
}

function reactionMeta(row: MessageRow) {
  const type = row.associated_message_type ?? 0;
  if (type === 2000) return { key: "heart", label: "Loved" };
  if (type === 2001) return { key: "like", label: "Liked" };
  if (type === 2002) return { key: "dislike", label: "Disliked" };
  if (type === 2003) return { key: "laugh", label: "Laughed" };
  if (type === 2004) return { key: "emphasis", label: "Emphasized" };
  if (type === 2005) return { key: "questioned", label: "Questioned" };
  if (type === 2006) return { key: "emoji_reaction", label: "Emoji reaction" };
  if (type === 3000) return { key: "removed_heart", label: "Removed heart" };
  if (type === 3001) return { key: "removed_like", label: "Removed like" };
  if (type === 3003) return { key: "removed_laugh", label: "Removed laugh" };
  return { key: `type_${type}`, label: `Reaction ${type}` };
}

function classifyThreadTarget(row: MessageRow) {
  if (row.has_attachment === 1) {
    return { key: "media", label: "Media", description: "Threaded replies anchored to photos, videos, or sent files." };
  }
  if (row.rich_link_url || /\bhttps?:\/\//i.test(row.text ?? "")) {
    return { key: "link", label: "Link", description: "Replies that branch off URLs, maps, articles, or shared web objects." };
  }
  if (/\b(love|miss|proud|sweet|cute|beautiful|thank|thanks|appreciate|heart)\b/i.test(row.text ?? "")) {
    return { key: "warmth", label: "Warmth", description: "Replies anchored to affection, gratitude, or sweetness." };
  }
  if (/\b(lol|lmao|haha|hehe|funny|hilarious|silly|ridiculous|wild)\b/i.test(row.text ?? "")) {
    return { key: "humor", label: "Humor", description: "Replies that branch off jokes and playful turns." };
  }
  if (/\b(sad|anxious|worried|scared|hurt|stress|stressed|hard|tired|rough)\b/i.test(row.text ?? "")) {
    return { key: "strain", label: "Strain", description: "Replies anchored to worry, difficulty, or heavy feeling." };
  }
  if ((row.text ?? "").includes("?")) {
    return { key: "question", label: "Question", description: "Replies anchored to explicit questions." };
  }
  if (/\b(when|where|tonight|tomorrow|time|meet|ride|pickup|dinner|lunch|arrive|leaving)\b/i.test(row.text ?? "")) {
    return { key: "logistics", label: "Logistics", description: "Replies anchored to practical coordination." };
  }
  if (row.word_count >= 45) {
    return { key: "long", label: "Long message", description: "Replies anchored to long, story-like turns." };
  }
  return { key: "ordinary", label: "Ordinary text", description: "Replies anchored to everyday text turns." };
}

function classifyObject(row: MessageRow) {
  const balloon = row.balloon_bundle_id ?? "";
  const text = row.text ?? "";
  const url = row.rich_link_url ?? "";
  if (row.expressive_style) {
    return { key: "effect", label: "Message effects", description: "Loud, impact, and other expressive send styles." };
  }
  if (/gamepigeon|wordswipe/i.test(balloon) || /\b(Checkers|Sea Battle|Word Hunt|Cup Pong|Anagrams)\b/i.test(text)) {
    return { key: "game", label: "Games", description: "GamePigeon and other app-game turns inside Messages." };
  }
  if (/findmy|maps|SafetyMonitor|google\.com\/maps|maps\.apple/i.test(`${balloon} ${url} ${text}`)) {
    return { key: "location", label: "Location objects", description: "Maps, Find My, Safety Check, and place-sharing objects." };
  }
  if (row.has_attachment === 1 || /PhotosMessagesApp/i.test(balloon)) {
    return { key: "media", label: "Photos and media", description: "Photos, videos, files, and other attachment-bearing messages." };
  }
  if (row.rich_link_url || /\bhttps?:\/\//i.test(text) || /URLBalloonProvider/i.test(balloon)) {
    return { key: "link", label: "Links", description: "Rich links, URLs, articles, listings, and shared web objects." };
  }
  if (balloon || row.associated_message_type === 3) {
    return { key: "app", label: "App objects", description: "Other Messages app payloads and object-like turns." };
  }
  return null;
}

function nextOtherReply(row: MessageRow, realRows: MessageRow[], realIndex: Map<number, number>) {
  const startIndex = realIndex.get(row.id);
  if (startIndex == null) return null;
  const sender = row.is_from_me;
  for (let index = startIndex + 1; index < realRows.length; index += 1) {
    const candidate = realRows[index];
    const gap = candidate.ts - row.ts;
    if (gap > REPLY_WINDOW_SECONDS) return null;
    if (candidate.is_from_me !== sender) return candidate;
  }
  return null;
}

function normalizeAssociatedGuid(guid: string) {
  if (guid.startsWith("p:")) {
    const slash = guid.lastIndexOf("/");
    return slash >= 0 ? guid.slice(slash + 1) : guid.slice(2);
  }
  if (guid.startsWith("bp:")) return guid.slice(3);
  return guid;
}

function isRealMessage(row: MessageRow) {
  return row.associated_message_type == null || row.associated_message_type < TAPBACK_TYPE_MIN;
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me ? "Me" : "Them";
}

function senderMatches(row: MessageRow, sender: MessageScope["sender"]) {
  if (sender === "me") return row.is_from_me === 1;
  if (sender === "them") return row.is_from_me === 0;
  return true;
}

function scopeBounds(scope: MessageScope): ScopeBounds {
  return {
    fromTs: scope.from ? dayBounds(scope.from).start : null,
    toTs: scope.to ? dayBounds(scope.to).end : null,
  };
}

function rowInDateScope(row: MessageRow, bounds: ScopeBounds) {
  if (bounds.fromTs != null && row.ts < bounds.fromTs) return false;
  if (bounds.toTs != null && row.ts >= bounds.toTs) return false;
  return true;
}

function preview(text: string | null, fallback: string) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

function objectFallback(row: MessageRow) {
  if (row.has_attachment === 1) return "sent media";
  if (row.rich_link_url) return row.rich_link_url;
  if (row.balloon_bundle_id) return row.balloon_bundle_id.split(":").pop() ?? "sent object";
  return "sent object";
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function countMap(items: string[]) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function distinctBy<T>(items: T[], keyFn: (item: T) => string) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function rate(part: number, whole: number) {
  return whole === 0 ? 0 : part / whole;
}

function logOddsZ(a: number, b: number, c: number, d: number) {
  const prior = 1.5;
  const aa = a + prior;
  const bb = b + prior;
  const cc = c + prior;
  const dd = d + prior;
  const delta = Math.log(aa / bb) - Math.log(cc / dd);
  const variance = 1 / aa + 1 / bb + 1 / cc + 1 / dd;
  return delta / Math.sqrt(variance);
}
