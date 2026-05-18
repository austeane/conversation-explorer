/**
 * Build a comparison cohort from one-on-one Messages chats.
 *
 * Output is written into the configured runtime DB under the cmp_* namespace.
 * Each non-counterpart profile is labeled with their Contacts name pulled from the
 * macOS AddressBook stores under ~/Library/Application Support/AddressBook/,
 * falling back to the raw phone/email identifier when no contact matches.
 */
import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handleMatchesConfigured, loadConversationConfig } from "./config";
import { decodeAttributedBody } from "./decode-attributed-body";

const config = loadConversationConfig({ validateMessagesDir: false });
const RAW_DB = join(config.output.rawSnapshotDir, "chat.db");
const OUT_DB = config.output.dbPath;
const MIN_MESSAGES = Number(process.env.COMPARISON_MIN_MESSAGES ?? config.comparison.minMessages);
const APPLE_EPOCH_OFFSET = 978307200;
const COUNTERPART_HANDLE_IDS = new Set(config.counterpart.handles);

const WORD_STOP = new Set([
  "the","a","an","and","or","but","if","so","of","in","on","at","to","for","with","by",
  "is","are","was","were","be","been","being","have","has","had","do","does","did",
  "i","you","we","they","he","she","it","me","my","your","our","their","his","her","its",
  "this","that","these","those","as","not","no","yes","ok","okay","oh","um","uh","like","just",
  "really","very","up","down","out","off","over","there","here","then","than","when","where","what","which","who",
  "from","into","about","also","too","can","will","would","could","should",
  "u","ur","ya","yeah","yep","yup","ima","gotta","ah","mm","mhm","mmm","hm","hmm","huh",
  "lol","lmao","haha","hehe","nah","yo","hi","hey","hello","well","got","get","gets","getting","gotten",
  "go","goes","going","went","gone","good","bad","sure","right","fine","one","two","three",
  "im","i'm","ive","i've","ill","i'll","id","i'd",
  "dont","don't","doesnt","doesn't","didnt","didn't","cant","can't","wont","won't","aint","ain't",
  "thats","that's","theres","there's","whats","what's","heres","here's","its","it's",
  "youre","you're","youve","you've","youll","you'll","youd","you'd",
  "shes","she's","hes","he's","theyre","they're","weve","we've","were","we're",
  "gonna","wanna","kinda","sorta","gotta","didn","doesn","wasn","wasn't","isn","isn't",
  "wouldn","wouldn't","couldn","couldn't","shouldn","shouldn't","haven","haven't","hadn","hadn't","hasn","hasn't",
]);

type ChatSeed = {
  chat_id: number;
  handle_id: number;
  identifier: string;
  n: number;
};

type GroupSeed = {
  key: string;
  isThem: boolean;
  chatIds: Set<number>;
  totalMessages: number;
};

type MessageRow = {
  id: number;
  date: bigint | number;
  chat_id: number;
  is_from_me: number;
  text: string | null;
  attributedBody: Buffer | null;
  cache_has_attachments: number | null;
  associated_message_type: number | null;
  thread_originator_guid: string | null;
  reply_to_guid: string | null;
  payload_data: Buffer | null;
};

type Profile = {
  id: string;
  identifier: string;
  label: string;
  isThem: boolean;
  rank: number;
  chatCount: number;
  messagesTotal: number;
  meMessages: number;
  themMessages: number;
  meTextMessages: number;
  themTextMessages: number;
  firstTs: number | null;
  lastTs: number | null;
  meWords: number;
  meChars: number;
  themWords: number;
  themChars: number;
  meQuestions: number;
  meExclaims: number;
  meEmoji: number;
  meAttachments: number;
  meTapbacks: number;
  meLinks: number;
  meReplies: number;
  medianReplyMeSec: number | null;
  medianReplyThemSec: number | null;
  replyMeSamples: number[];
  replyThemSamples: number[];
  prevReal: { ts: number; isFromMe: boolean } | null;
};

if (!existsSync(RAW_DB)) {
  throw new Error(`Missing ${RAW_DB}. Run pnpm extract first so the raw Messages snapshot exists.`);
}
if (!existsSync(OUT_DB)) {
  throw new Error(`Missing ${OUT_DB}. Run pnpm extract first.`);
}
if (!config.comparison.enabled) {
  console.log("[cmp-etl] comparison.enabled is false; skipping comparison tables");
  process.exit(0);
}

console.log(`[cmp-etl] reading ${RAW_DB}`);
const src = new Database(RAW_DB, { readonly: true, fileMustExist: true });
const out = new Database(OUT_DB);
out.pragma("journal_mode = WAL");
out.pragma("synchronous = NORMAL");

const chatSeeds = src
  .prepare(
    `
    SELECT c.ROWID AS chat_id, h.ROWID AS handle_id, h.id AS identifier,
           COUNT(cmj.message_id) AS n
    FROM chat c
    JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    JOIN handle h ON h.ROWID = chj.handle_id
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    WHERE c.style = 45
    GROUP BY c.ROWID, h.ROWID, h.id
    `,
  )
  .all() as ChatSeed[];

const groups = new Map<string, GroupSeed>();
for (const seed of chatSeeds) {
  const identifier = normalizeIdentifier(seed.identifier);
  const isThem = handleMatchesConfigured(identifier, COUNTERPART_HANDLE_IDS);
  const key = isThem ? "them" : identifier;
  const group =
    groups.get(key) ??
    ({
      key,
      isThem,
      chatIds: new Set<number>(),
      totalMessages: 0,
    } satisfies GroupSeed);
  group.chatIds.add(seed.chat_id);
  group.totalMessages += seed.n;
  groups.set(key, group);
}

const qualified = [...groups.values()]
  .filter((g) => g.totalMessages >= MIN_MESSAGES)
  .sort((a, b) => b.totalMessages - a.totalMessages);
const chatToGroup = new Map<number, GroupSeed>();
for (const group of qualified) {
  for (const chatId of group.chatIds) chatToGroup.set(chatId, group);
}

const chatIds = [...chatToGroup.keys()];
console.log(
  `[cmp-etl] cohort: ${qualified.length} people, ${chatIds.length} one-on-one chats, min ${MIN_MESSAGES} messages`,
);
if (chatIds.length === 0) throw new Error("No comparison chats qualified.");

const profilesByKey = new Map<string, Profile>();
for (const group of qualified) {
  profilesByKey.set(group.key, {
    id: group.isThem ? "them" : "",
    identifier: group.key,
    label: group.isThem ? config.counterpart.label : "",
    isThem: group.isThem,
    rank: 0,
    chatCount: group.chatIds.size,
    messagesTotal: 0,
    meMessages: 0,
    themMessages: 0,
    meTextMessages: 0,
    themTextMessages: 0,
    firstTs: null,
    lastTs: null,
    meWords: 0,
    meChars: 0,
    themWords: 0,
    themChars: 0,
    meQuestions: 0,
    meExclaims: 0,
    meEmoji: 0,
    meAttachments: 0,
    meTapbacks: 0,
    meLinks: 0,
    meReplies: 0,
    medianReplyMeSec: null,
    medianReplyThemSec: null,
    replyMeSamples: [],
    replyThemSamples: [],
    prevReal: null,
  });
}

const themWords = new Map<string, number>();
const otherWords = new Map<string, number>();
let nThemTokens = 0;
let nOtherTokens = 0;

const placeholders = chatIds.map(() => "?").join(",");
const rows = src
  .prepare(
    `
    SELECT m.ROWID AS id, m.date, cmj.chat_id, m.is_from_me, m.text,
           m.attributedBody, m.cache_has_attachments, m.associated_message_type,
           m.thread_originator_guid, m.reply_to_guid, m.payload_data
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    WHERE cmj.chat_id IN (${placeholders})
    ORDER BY cmj.chat_id ASC, m.date ASC
    `,
  )
  .iterate(...chatIds) as IterableIterator<MessageRow>;

let seen = 0;
for (const row of rows) {
  const group = chatToGroup.get(row.chat_id);
  if (!group) continue;
  const profile = profilesByKey.get(group.key);
  if (!profile) continue;

  seen++;
  const ts = appleDateToUnix(row.date);
  const isMe = row.is_from_me === 1;
  const isTapback =
    row.associated_message_type != null &&
    row.associated_message_type >= 2000 &&
    row.associated_message_type <= 2005;
  const text = decodeMessageText(row);
  const tokens = text ? tokenize(text) : [];
  const emojiCount = text ? countEmoji(text) : 0;
  const hasLink = text ? /https?:\/\//i.test(text) : payloadHasHttp(row.payload_data);

  profile.messagesTotal++;
  if (isMe) profile.meMessages++;
  else profile.themMessages++;
  profile.firstTs = profile.firstTs == null ? ts : Math.min(profile.firstTs, ts);
  profile.lastTs = profile.lastTs == null ? ts : Math.max(profile.lastTs, ts);

  if (isMe) {
    if (text) profile.meTextMessages++;
    profile.meWords += tokens.length;
    profile.meChars += text?.length ?? 0;
    if (text?.includes("?")) profile.meQuestions++;
    if (text?.includes("!")) profile.meExclaims++;
    profile.meEmoji += emojiCount;
    if (row.cache_has_attachments) profile.meAttachments++;
    if (isTapback) profile.meTapbacks++;
    if (hasLink) profile.meLinks++;
    if (row.thread_originator_guid || row.reply_to_guid) profile.meReplies++;

    const counts = group.isThem ? themWords : otherWords;
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    if (group.isThem) nThemTokens += tokens.length;
    else nOtherTokens += tokens.length;
  } else {
    if (text) profile.themTextMessages++;
    profile.themWords += tokens.length;
    profile.themChars += text?.length ?? 0;
  }

  if (!isTapback) {
    const prev = profile.prevReal;
    if (prev && prev.isFromMe !== isMe) {
      const gap = ts - prev.ts;
      if (gap > 0 && gap < 86400) {
        if (isMe) profile.replyMeSamples.push(gap);
        else profile.replyThemSamples.push(gap);
      }
    }
    profile.prevReal = { ts, isFromMe: isMe };
  }
}

const profiles = [...profilesByKey.values()].sort((a, b) => b.messagesTotal - a.messagesTotal);
const addressBookNames = config.comparison.resolveContactNames ? loadAddressBookNames() : new Map<string, string>();
let resolved = 0;
let otherRank = 1;
for (const profile of profiles) {
  if (profile.isThem) {
    profile.id = "them";
    profile.label = config.counterpart.label;
    profile.rank = 0;
  } else {
    profile.rank = otherRank;
    profile.id = `other_${String(otherRank).padStart(3, "0")}`;
    const name = addressBookNames.get(profile.identifier);
    if (name) resolved++;
    profile.label = name ?? prettyIdentifier(profile.identifier);
    otherRank++;
  }
  profile.medianReplyMeSec = median(profile.replyMeSamples);
  profile.medianReplyThemSec = median(profile.replyThemSamples);
}
console.log(`[cmp-etl] resolved ${resolved}/${profiles.length - 1} non-counterpart profiles to Contacts names`);

const distinctive = computeDistinctiveWords(themWords, otherWords, nThemTokens, nOtherTokens);

const write = out.transaction(() => {
  out.exec(`
    DROP TABLE IF EXISTS cmp_meta;
    DROP TABLE IF EXISTS cmp_people;
    DROP TABLE IF EXISTS cmp_distinctive_words;

    CREATE TABLE cmp_meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    CREATE TABLE cmp_people (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      is_them INTEGER NOT NULL,
      person_rank INTEGER NOT NULL,
      chat_count INTEGER NOT NULL,
      messages_total INTEGER NOT NULL,
      me_messages INTEGER NOT NULL,
      them_messages INTEGER NOT NULL,
      me_text_messages INTEGER NOT NULL,
      them_text_messages INTEGER NOT NULL,
      first_ts INTEGER,
      last_ts INTEGER,
      me_words INTEGER NOT NULL,
      me_chars INTEGER NOT NULL,
      them_words INTEGER NOT NULL,
      them_chars INTEGER NOT NULL,
      me_questions INTEGER NOT NULL,
      me_exclaims INTEGER NOT NULL,
      me_emoji INTEGER NOT NULL,
      me_attachments INTEGER NOT NULL,
      me_tapbacks INTEGER NOT NULL,
      me_links INTEGER NOT NULL,
      me_replies INTEGER NOT NULL,
      median_reply_me_sec INTEGER,
      median_reply_them_sec INTEGER
    );

    CREATE TABLE cmp_distinctive_words (
      word TEXT PRIMARY KEY,
      count_them INTEGER NOT NULL,
      count_others INTEGER NOT NULL,
      log_odds_z REAL NOT NULL,
      combined_count INTEGER NOT NULL,
      side TEXT NOT NULL
    );

    CREATE INDEX cmp_people_rank_idx ON cmp_people(is_them, person_rank);
    CREATE INDEX cmp_words_side_idx ON cmp_distinctive_words(side, ABS(log_odds_z));
  `);

  const setMeta = out.prepare(`INSERT INTO cmp_meta (k, v) VALUES (?, ?)`);
  setMeta.run("generated_at", new Date().toISOString());
  setMeta.run("min_messages", String(MIN_MESSAGES));
  setMeta.run("people", String(profiles.length));
  setMeta.run("other_people", String(profiles.filter((p) => !p.isThem).length));
  setMeta.run("messages_scanned", String(seen));
  setMeta.run("counterpart_label", config.counterpart.label);
  setMeta.run("them_outbound_tokens", String(nThemTokens));
  setMeta.run("other_outbound_tokens", String(nOtherTokens));

  const insProfile = out.prepare(`
    INSERT INTO cmp_people (
      id, label, is_them, person_rank, chat_count, messages_total,
      me_messages, them_messages, me_text_messages, them_text_messages,
      first_ts, last_ts, me_words, me_chars, them_words, them_chars,
      me_questions, me_exclaims, me_emoji, me_attachments, me_tapbacks,
      me_links, me_replies, median_reply_me_sec, median_reply_them_sec
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const p of profiles) {
    insProfile.run(
      p.id,
      p.label,
      p.isThem ? 1 : 0,
      p.rank,
      p.chatCount,
      p.messagesTotal,
      p.meMessages,
      p.themMessages,
      p.meTextMessages,
      p.themTextMessages,
      p.firstTs,
      p.lastTs,
      p.meWords,
      p.meChars,
      p.themWords,
      p.themChars,
      p.meQuestions,
      p.meExclaims,
      p.meEmoji,
      p.meAttachments,
      p.meTapbacks,
      p.meLinks,
      p.meReplies,
      p.medianReplyMeSec,
      p.medianReplyThemSec,
    );
  }

  const insWord = out.prepare(`
    INSERT INTO cmp_distinctive_words
      (word, count_them, count_others, log_odds_z, combined_count, side)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const w of distinctive) {
    insWord.run(w.word, w.countThem, w.countOthers, w.z, w.combined, w.z >= 0 ? "them" : "others");
  }
});

write();

const counterpart = profiles.find((p) => p.isThem);
console.log(
  `[cmp-etl] wrote ${profiles.length} profiles, ${distinctive.length} distinctive words, ` +
    `${nThemTokens}/${nOtherTokens} self tokens (counterpart/others)`,
);
if (counterpart) {
  console.log(
    `[cmp-etl] counterpart: ${counterpart.messagesTotal} messages, ${counterpart.meMessages} from self, ` +
      `${rate(counterpart.meWords, counterpart.meTextMessages).toFixed(2)} words/outbound text`,
  );
}

out.pragma("wal_checkpoint(TRUNCATE)");
src.close();
out.close();

function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;
  return trimmed.replace(/[^\d+]/g, "");
}

function appleDateToUnix(date: bigint | number): number {
  const rawDate = typeof date === "bigint" ? date : BigInt(date);
  if (rawDate > 1_000_000_000_000n) {
    return Number(rawDate / 1_000_000_000n) + APPLE_EPOCH_OFFSET;
  }
  return Number(rawDate) + APPLE_EPOCH_OFFSET;
}

function decodeMessageText(row: MessageRow): string | null {
  if (row.text && row.text.trim() !== "") return row.text;
  if (!row.attributedBody) return null;
  return decodeAttributedBody(row.attributedBody);
}

function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[^a-z' ]+/g, " ");
  const out: string[] = [];
  for (const raw of normalized.split(/\s+/)) {
    if (!raw) continue;
    const word = raw.replace(/^'+|'+$/g, "");
    if (word.length < 3 || word.length > 20) continue;
    if (WORD_STOP.has(word)) continue;
    out.push(word);
  }
  return out;
}

function countEmoji(text: string): number {
  const matches = text.match(/(?:\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic})*[️]?)/gu);
  return matches?.length ?? 0;
}

function payloadHasHttp(payload: Buffer | null): boolean {
  return payload ? payload.indexOf(Buffer.from("http", "ascii")) >= 0 : false;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function loadAddressBookNames(): Map<string, string> {
  const sourcesDir = join(homedir(), "Library/Application Support/AddressBook/Sources");
  if (!existsSync(sourcesDir)) {
    console.warn(
      `[cmp-etl] AddressBook not found at ${sourcesDir}; comparison labels will fall back to raw identifiers`,
    );
    return new Map();
  }
  const dirs = readdirSync(sourcesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(sourcesDir, d.name));

  const names = new Map<string, string>();
  let phoneCount = 0;
  let emailCount = 0;
  for (const dir of dirs) {
    const dbPath = join(dir, "AddressBook-v22.abcddb");
    if (!existsSync(dbPath)) continue;
    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      console.warn(`[cmp-etl] could not open ${dbPath}: ${(err as Error).message}`);
      continue;
    }
    try {
      const rows = db
        .prepare(
          `SELECT Z_PK AS pk, ZFIRSTNAME AS first, ZLASTNAME AS last,
                  ZNICKNAME AS nick, ZORGANIZATION AS org
           FROM ZABCDRECORD`,
        )
        .all() as Array<{
        pk: number;
        first: string | null;
        last: string | null;
        nick: string | null;
        org: string | null;
      }>;
      const byPk = new Map<number, string>();
      for (const r of rows) {
        const display = formatContactName(r.first, r.last, r.nick, r.org);
        if (display) byPk.set(r.pk, display);
      }
      const phones = db
        .prepare(`SELECT ZOWNER AS pk, ZFULLNUMBER AS num FROM ZABCDPHONENUMBER`)
        .all() as Array<{ pk: number; num: string | null }>;
      for (const p of phones) {
        const name = byPk.get(p.pk);
        if (!name || !p.num) continue;
        for (const variant of phoneVariants(p.num)) {
          if (!names.has(variant)) names.set(variant, name);
        }
        phoneCount++;
      }
      const emails = db
        .prepare(`SELECT ZOWNER AS pk, ZADDRESS AS addr FROM ZABCDEMAILADDRESS`)
        .all() as Array<{ pk: number; addr: string | null }>;
      for (const e of emails) {
        const name = byPk.get(e.pk);
        if (!name || !e.addr) continue;
        const k = e.addr.trim().toLowerCase();
        if (!k) continue;
        if (!names.has(k)) names.set(k, name);
        emailCount++;
      }
    } finally {
      db.close();
    }
  }
  console.log(
    `[cmp-etl] AddressBook: ${names.size} identifier→name mappings (${phoneCount} phones, ${emailCount} emails) across ${dirs.length} sources`,
  );
  return names;
}

function formatContactName(
  first: string | null,
  last: string | null,
  nick: string | null,
  org: string | null,
): string | null {
  const f = first?.trim();
  const l = last?.trim();
  const n = nick?.trim();
  const o = org?.trim();
  const full = [f, l].filter(Boolean).join(" ").trim();
  if (full) return n ? `${full} (${n})` : full;
  if (n) return n;
  if (o) return o;
  return null;
}

function phoneVariants(raw: string): string[] {
  const norm = raw.trim().toLowerCase().replace(/[^\d+]/g, "");
  if (!norm) return [];
  const variants = new Set<string>([norm]);
  const digits = norm.replace(/^\+/, "");
  if (digits.length === 10) variants.add(`+1${digits}`);
  if (digits.length === 11 && digits.startsWith("1")) variants.add(`+${digits}`);
  return [...variants];
}

function prettyIdentifier(identifier: string): string {
  if (identifier.includes("@")) return identifier;
  // North-American E.164: +1NPAXXXXXXX → +1 (NPA) NXX-XXXX
  const m = identifier.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
  return identifier;
}

function computeDistinctiveWords(
  them: Map<string, number>,
  others: Map<string, number>,
  nThem: number,
  nOthers: number,
) {
  const alpha0 = 100;
  const minCombined = 10;
  const vocab = new Set([...them.keys(), ...others.keys()]);
  const rows: Array<{
    word: string;
    countThem: number;
    countOthers: number;
    z: number;
    combined: number;
  }> = [];
  const nTotal = nThem + nOthers;
  for (const word of vocab) {
    const yThem = them.get(word) ?? 0;
    const yOthers = others.get(word) ?? 0;
    const yWord = yThem + yOthers;
    if (yWord < minCombined) continue;
    const alphaWord = alpha0 * (yWord / nTotal);
    const logOddsThem = Math.log(
      (yThem + alphaWord) / (nThem + alpha0 - yThem - alphaWord),
    );
    const logOddsOthers = Math.log(
      (yOthers + alphaWord) / (nOthers + alpha0 - yOthers - alphaWord),
    );
    const variance = 1 / (yThem + alphaWord) + 1 / (yOthers + alphaWord);
    rows.push({
      word,
      countThem: yThem,
      countOthers: yOthers,
      z: (logOddsThem - logOddsOthers) / Math.sqrt(variance),
      combined: yWord,
    });
  }
  return rows
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 800);
}
