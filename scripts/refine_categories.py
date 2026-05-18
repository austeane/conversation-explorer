"""
Segment-level category refinement.

The older pipeline labelled each topic, then let every segment inherit that
topic label. That is too coarse for capsule browsing because a local Wordle or
tech-help passage can sit inside a broad topic that was labelled "intimacy".

This stage scores the actual messages inside each segment, writes a primary and
secondary category plus explicit category-status fields, stores per-category
score details, splits intimacy into romantic_intimacy and sexual_intimacy, and
then derives topic labels from the new segment-level majority. Unknown, outlier,
and attachment-only segments stay uncertain instead of being folded into
small_talk.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
TOPIC_REPS = ROOT / "data" / "topic_reps.json"

METHOD = "segment-lexical-v2"

CATEGORIES = [
    "logistics",
    "planning",
    "small_talk",
    "romantic_intimacy",
    "sexual_intimacy",
    "conflict",
    "emotional_support",
    "humor",
    "work_school",
    "family",
    "daily_check_in",
    "photo_sharing",
    "memes_links",
    "food",
    "travel",
    "games",
    "tech",
    "health",
    "household",
    "finance",
]

TOPIC_PRIOR_WEIGHT = 0.18
MIN_PRIMARY_SCORE = 2.4
MIN_SECONDARY_SCORE = 1.8
MIN_SMALL_TALK_SCORE = 1.4
AMBIGUOUS_SCORE_MARGIN = 0.1


@dataclass
class Lexicon:
    words: dict[str, float] = field(default_factory=dict)
    phrases: dict[str, float] = field(default_factory=dict)
    patterns: list[tuple[re.Pattern[str], float, str]] = field(default_factory=list)


@dataclass
class MessageScore:
    romantic: float
    sexual: float
    signals: list[str]


@dataclass
class SegmentInput:
    segment_id: int
    topic_id: int | None
    n_msgs: int
    n_me: int
    n_them: int
    top_words: list[str]
    top_phrases: list[str]
    topic_label: str | None
    messages: list[dict]


def lexicon(
    words: Iterable[str] = (),
    phrases: Iterable[str] = (),
    patterns: Iterable[tuple[str, float, str]] = (),
    word_weight: float = 1.0,
    phrase_weight: float = 2.0,
) -> Lexicon:
    return Lexicon(
        words={word: word_weight for word in words},
        phrases={phrase: phrase_weight for phrase in phrases},
        patterns=[(re.compile(pattern, re.I), weight, label) for pattern, weight, label in patterns],
    )


LEXICONS: dict[str, Lexicon] = {
    "small_talk": lexicon(
        words=[
            "ah",
            "aha",
            "cool",
            "dang",
            "hello",
            "hey",
            "hi",
            "hmm",
            "k",
            "lol",
            "nice",
            "okay",
            "ok",
            "oop",
            "oops",
            "sure",
            "thanks",
            "ty",
            "whoa",
            "yeah",
            "yep",
            "yes",
        ],
        phrases=[
            "good morning",
            "good night",
            "sounds good",
            "no worries",
            "see you",
            "talk soon",
        ],
        patterns=[
            (r"^(hi|hey|hello|okay|ok|sure|yeah|yep|lol|haha)[!. ]*$", 1.6, "short acknowledgment"),
            (r"\b(good\s*night|goodnight|good\s+morning|see you|talk soon)\b", 1.6, "greeting/farewell"),
        ],
    ),
    "romantic_intimacy": lexicon(
        words=[
            "adore",
            "babe",
            "bb",
            "beloved",
            "beautiful",
            "cuddle",
            "cuddles",
            "cute",
            "cutie",
            "darling",
            "gorgeous",
            "handsome",
            "hug",
            "hugs",
            "kiss",
            "kisses",
            "lovey",
            "miss",
            "romantic",
            "sweetheart",
            "sweetie",
            "wife",
        ],
        phrases=[
            "i love you",
            "love you",
            "love u",
            "miss you",
            "miss u",
            "my love",
            "thinking of you",
            "proud of you",
            "so proud",
            "come cuddle",
            "wanna cuddle",
            "want to cuddle",
            "good night my",
            "goodnight my",
        ],
        patterns=[
            (r"\bi\s+love\s+(you|u)\b", 3.4, "love declaration"),
            (r"\bmiss\s+(you|u)\b", 2.8, "missing each other"),
            (r"\b(cuddle|cuddles|kiss|kisses)\b", 1.8, "physical affection"),
            ("[\\u2764\\u2665\\U0001f618\\U0001f970\\U0001f60d]", 1.8, "affection emoji"),
        ],
    ),
    "sexual_intimacy": lexicon(
        words=[
            "aroused",
            "bdsm",
            "bedroom",
            "blowjob",
            "boob",
            "boobs",
            "butthole",
            "clit",
            "cock",
            "cum",
            "cumming",
            "desire",
            "dom",
            "dommed",
            "domming",
            "edge",
            "edging",
            "erotic",
            "fetish",
            "flogger",
            "fuck",
            "fucked",
            "fucking",
            "handjob",
            "handjobs",
            "horny",
            "kink",
            "kinky",
            "lick",
            "licking",
            "lingerie",
            "lovense",
            "naked",
            "nipples",
            "orgasm",
            "pegging",
            "pleasure",
            "porn",
            "pussy",
            "queef",
            "railed",
            "roleplay",
            "sex",
            "sexual",
            "sexy",
            "shibari",
            "spank",
            "strap",
            "stripper",
            "squirt",
            "squirted",
            "threesome",
            "toy",
            "vagina",
            "vaginal",
            "vibrator",
            "voyeur",
            "wevibe",
        ],
        phrases=[
            "turn me on",
            "turned on",
            "get off",
            "getting off",
            "make me cum",
            "want you inside",
            "want to fuck",
            "have sex",
            "sex with you",
            "sex tonight",
            "send nudes",
            "nude photo",
            "dirty talk",
            "sexual texting",
            "jerk off",
            "go down on",
            "eat you out",
            "goon cave",
        ],
        patterns=[
            (r"\bhor+n+y+\b", 2.5, "horny spelling"),
            (r"\b(sex|sexual|sexy|kink|bdsm|porn)\b", 2.3, "explicit sexual term"),
            (r"\b(clit|cock|cum|pussy|vagina|nipples?)\b", 3.0, "body/sex term"),
            (r"\b(naked|lingerie|vibrator|lovense|wevibe|strap|pegging)\b", 2.2, "sexual object/body"),
        ],
    ),
    "conflict": lexicon(
        words=[
            "angry",
            "argue",
            "arguing",
            "blame",
            "conflict",
            "defensive",
            "fight",
            "fighting",
            "frustrated",
            "hurtful",
            "mad",
            "resent",
            "snippy",
            "tense",
            "upset",
        ],
        phrases=[
            "not okay",
            "that hurt",
            "feel hurt",
            "i am upset",
            "i'm upset",
            "you hurt",
            "really frustrated",
            "not fair",
        ],
        patterns=[
            (r"\b(i'?m|i am)\s+(upset|mad|angry|frustrated|hurt)\b", 2.5, "stated hurt/frustration"),
            (r"\b(fight|argument|conflict)\b", 2.0, "conflict word"),
        ],
    ),
    "emotional_support": lexicon(
        words=[
            "anxious",
            "anxiety",
            "comfort",
            "cry",
            "crying",
            "depressed",
            "hard",
            "overwhelmed",
            "panic",
            "sad",
            "scared",
            "spiral",
            "stress",
            "stressed",
            "support",
            "worried",
        ],
        phrases=[
            "are you okay",
            "you okay",
            "you ok",
            "feel better",
            "here for you",
            "that sounds hard",
            "i'm sorry",
            "im sorry",
            "i am sorry",
            "proud of you",
            "you did great",
        ],
        patterns=[
            (r"\b(anxious|overwhelmed|panic|sad|scared|worried|stressed)\b", 1.6, "distress"),
            (r"\b(i'?m|im|i am)\s+sorry\b", 1.6, "comfort/apology"),
        ],
    ),
    "humor": lexicon(
        words=[
            "ahah",
            "ahaha",
            "bahaha",
            "funny",
            "haha",
            "hehe",
            "joke",
            "lmao",
            "lol",
            "lolol",
            "meme",
            "omg",
            "silly",
            "wtf",
        ],
        phrases=["very funny", "made me laugh", "this is hilarious", "so funny"],
        patterns=[
            (r"\b(lol+|lmao+|haha+|ahah+|bahaha+)\b", 0.8, "laughter"),
            ("[\\U0001f602\\U0001f923]", 1.2, "laugh emoji"),
        ],
    ),
    "games": lexicon(
        words=[
            "astarion",
            "baldurs",
            "catan",
            "connections",
            "discord",
            "elden",
            "game",
            "games",
            "gloomhaven",
            "jackbox",
            "moxfield",
            "overwatch",
            "purple",
            "redactle",
            "score",
            "scores",
            "steam",
            "valorant",
            "wordle",
            "yellow",
        ],
        phrases=[
            "blue green yellow purple",
            "yellow green blue purple",
            "yellow blue green purple",
            "green blue yellow purple",
            "wordle in",
            "got wordle",
            "got it in",
            "connections first",
            "purple perfect",
        ],
        patterns=[
            (r"\bwordle\b", 3.0, "wordle"),
            (r"\bconnections\b", 3.0, "connections"),
            (r"\b(blue|green|yellow|purple)\s+(blue|green|yellow|purple)\b", 1.4, "connections colors"),
            (r"\b(got|did|finished)\s+(it|wordle|connections)\s+in\s+[23456]\b", 2.2, "game result"),
        ],
    ),
    "tech": lexicon(
        words=[
            "airpods",
            "android",
            "app",
            "browser",
            "bug",
            "command",
            "computer",
            "cursor",
            "download",
            "file",
            "function",
            "iphone",
            "keyboard",
            "laptop",
            "link",
            "login",
            "mac",
            "phone",
            "safari",
            "screenshot",
            "settings",
            "software",
            "upload",
            "website",
            "wifi",
        ],
        phrases=[
            "command f",
            "cmd f",
            "control f",
            "doesn't send",
            "didn't send",
            "photo didn't send",
            "how do i",
            "can't figure out",
            "search function",
        ],
        patterns=[
            (r"\b(command|cmd|control)\s*f\b", 3.0, "find command"),
            (r"\b(safari|iphone|phone|app|browser|website|wifi|download|upload)\b", 1.1, "tech object"),
        ],
    ),
    "logistics": lexicon(
        words=[
            "arrive",
            "bus",
            "calendar",
            "drop",
            "errand",
            "ferry",
            "keys",
            "late",
            "mail",
            "parking",
            "pickup",
            "pick",
            "ride",
            "schedule",
            "send",
            "sent",
            "time",
            "uber",
        ],
        phrases=[
            "on my way",
            "what time",
            "pick you up",
            "pick me up",
            "drop off",
            "can you send",
            "let me know when",
            "how long",
        ],
        patterns=[
            (r"\b(eta|uber|bus|ferry|parking|schedule|calendar)\b", 1.5, "coordination"),
            (r"\b(on my way|omw|what time|how long)\b", 1.8, "timing"),
        ],
    ),
    "planning": lexicon(
        words=[
            "book",
            "booking",
            "coffee",
            "date",
            "dinner",
            "event",
            "invite",
            "later",
            "meet",
            "plan",
            "plans",
            "reservation",
            "restaurant",
            "soon",
            "tomorrow",
            "tonight",
            "weekend",
        ],
        phrases=[
            "do you want to",
            "should we",
            "want to go",
            "want to do",
            "this weekend",
            "tomorrow night",
            "make a reservation",
        ],
        patterns=[
            (r"\b(should we|want to|wanna|do you want)\b", 1.2, "planning question"),
        ],
    ),
    "work_school": lexicon(
        words=[
            "assignment",
            "boss",
            "class",
            "client",
            "deadline",
            "exam",
            "final",
            "finals",
            "homework",
            "interview",
            "meeting",
            "office",
            "professor",
            "project",
            "school",
            "study",
            "teacher",
            "work",
        ],
        phrases=["at work", "work meeting", "school work", "job interview", "my boss"],
    ),
    "family": lexicon(
        words=[
            "aunt",
            "brother",
            "cousin",
            "dad",
            "family",
            "father",
            "grandma",
            "grandpa",
            "in-laws",
            "mom",
            "mother",
            "mum",
            "parents",
            "sibling",
            "sister",
        ],
        phrases=["your mom", "my mom", "your dad", "my dad", "my parents", "your parents"],
    ),
    "daily_check_in": lexicon(
        words=[
            "awake",
            "bed",
            "goodnight",
            "gnight",
            "hello",
            "hi",
            "home",
            "morning",
            "sleep",
            "sleepy",
            "tired",
            "wake",
            "woke",
        ],
        phrases=[
            "good morning",
            "good night",
            "how are you",
            "how was your day",
            "how's your day",
            "made it home",
            "sleep well",
            "going to bed",
        ],
        patterns=[
            (r"\b(good\s*night|goodnight|gnight|good\s+morning)\b", 2.0, "daily greeting"),
        ],
    ),
    "photo_sharing": lexicon(
        words=["image", "photo", "photos", "pic", "pics", "picture", "pictures", "selfie", "video"],
        phrases=["send a photo", "send pic", "sent a photo", "sent you", "photo didn't send"],
        patterns=[
            (r"\b(photo|pic|picture|video|selfie)s?\b", 1.7, "media"),
        ],
    ),
    "memes_links": lexicon(
        words=["article", "link", "meme", "reddit", "tiktok", "tweet", "twitter", "youtube"],
        phrases=["sent you a link", "look at this", "watch this", "this article"],
        patterns=[
            (r"https?://", 3.0, "url"),
            (r"\b(youtube|youtu\.be|tiktok|reddit|twitter|instagram)\b", 2.0, "internet source"),
        ],
    ),
    "food": lexicon(
        words=[
            "breakfast",
            "cook",
            "cooking",
            "dinner",
            "eat",
            "food",
            "hungry",
            "lunch",
            "meal",
            "recipe",
            "restaurant",
            "snack",
            "soup",
        ],
        phrases=["what should we eat", "for dinner", "made food", "order food"],
    ),
    "travel": lexicon(
        words=[
            "airbnb",
            "airport",
            "border",
            "flight",
            "hotel",
            "passport",
            "plane",
            "roadtrip",
            "suitcase",
            "trip",
            "travel",
            "vacation",
        ],
        phrases=["book flights", "road trip", "at the airport", "hotel room"],
    ),
    "health": lexicon(
        words=[
            "ache",
            "appointment",
            "blood",
            "bleed",
            "bleeding",
            "cold",
            "covid",
            "cramp",
            "cramps",
            "dentist",
            "doctor",
            "health",
            "hurt",
            "injury",
            "midwife",
            "meds",
            "nauseous",
            "pain",
            "pelvic",
            "pharmacy",
            "physio",
            "pill",
            "poop",
            "pooping",
            "pregnancy",
            "pregnant",
            "sick",
            "symptoms",
            "tampon",
            "tear",
            "tears",
            "uterus",
        ],
        phrases=[
            "blood work",
            "butt hole",
            "doctor appointment",
            "feel better",
            "feel sick",
            "first degree tear",
            "second degree tear",
            "take meds",
        ],
    ),
    "household": lexicon(
        words=[
            "apartment",
            "bathroom",
            "bedroom",
            "chores",
            "clean",
            "cleaning",
            "dishes",
            "home",
            "house",
            "laundry",
            "rent",
            "room",
            "sink",
            "trash",
        ],
        phrases=["clean up", "do laundry", "at home", "around the house"],
    ),
    "finance": lexicon(
        words=[
            "bill",
            "budget",
            "buy",
            "cost",
            "credit",
            "dollar",
            "e-transfer",
            "fee",
            "money",
            "paid",
            "pay",
            "price",
            "refund",
            "rent",
            "tax",
        ],
        phrases=["how much", "pay you back", "send money", "credit card", "tax return"],
    ),
}


TOPIC_CATEGORY_MAP = {
    "intimacy": "romantic_intimacy",
    "photo": "photo_sharing",
    "photo_sharing": "photo_sharing",
}


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")

    segments = load_segments(conn)
    message_scores: dict[int, MessageScore] = {}
    segment_results = []
    category_scores = []

    for segment in segments:
        result, scores = classify_segment(segment, message_scores)
        segment_results.append(result)
        for category, payload in scores.items():
            category_scores.append(
                (
                    segment.segment_id,
                    category,
                    round(payload["score"], 4),
                    int(payload["evidence"]),
                    json.dumps(payload["signals"][:8]),
                )
            )

    write_results(conn, segment_results, category_scores, message_scores)
    update_topics(conn)
    update_topic_reps(conn)
    print_summary(conn)
    conn.close()


def load_segments(conn: sqlite3.Connection) -> list[SegmentInput]:
    raw_segments = conn.execute(
        """
        SELECT s.id,
               s.topic_id,
               s.n_msgs,
               s.n_me,
               s.n_them,
               t.top_words,
               t.top_phrases,
               t.label AS topic_label
        FROM seg_segments s
        LEFT JOIN seg_topics t ON t.id = s.topic_id
        ORDER BY s.id ASC
        """
    ).fetchall()

    messages_by_segment: dict[int, list[dict]] = defaultdict(list)
    rows = conn.execute(
        """
        SELECT sms.segment_id,
               m.id,
               m.ts,
               m.is_from_me,
               m.text,
               m.has_attachment
        FROM seg_msg_segment sms
        JOIN messages m ON m.id = sms.msg_id
        WHERE m.associated_message_type IS NULL OR m.associated_message_type = 0
        ORDER BY sms.segment_id ASC, m.ts ASC, m.id ASC
        """
    ).fetchall()
    for row in rows:
        messages_by_segment[int(row["segment_id"])].append(dict(row))

    segments: list[SegmentInput] = []
    for row in raw_segments:
        segments.append(
            SegmentInput(
                segment_id=int(row["id"]),
                topic_id=int(row["topic_id"]) if row["topic_id"] is not None else None,
                n_msgs=int(row["n_msgs"]),
                n_me=int(row["n_me"]),
                n_them=int(row["n_them"]),
                top_words=safe_json_list(row["top_words"]),
                top_phrases=safe_json_list(row["top_phrases"]),
                topic_label=row["topic_label"],
                messages=messages_by_segment.get(int(row["id"]), []),
            )
        )
    return segments


def classify_segment(segment: SegmentInput, message_scores: dict[int, MessageScore]):
    score_payload: dict[str, dict] = {
        category: {"score": 0.0, "evidence": 0, "signals": []}
        for category in CATEGORIES
    }

    substantive_messages = 0
    token_total = 0
    sexual_messages = 0
    romantic_messages = 0
    attachment_count = 0

    for message in segment.messages:
        text = normalize(message.get("text") or "")
        if text:
            substantive_messages += 1
            token_total += len(tokenize(text))
            add_text_scores(text, score_payload)
            intimacy = score_message_intimacy(text)
            message_scores[int(message["id"])] = intimacy
            if intimacy.sexual >= 2.3:
                sexual_messages += 1
            if intimacy.romantic >= 2.3:
                romantic_messages += 1
        else:
            message_scores[int(message["id"])] = MessageScore(0.0, 0.0, [])

        if int(message.get("has_attachment") or 0):
            attachment_count += 1
            bump(score_payload, "photo_sharing", 1.8, "attachment")

    topic_text = " ".join(segment.top_words[:10] + segment.top_phrases[:6]).lower()
    topic_label = normalize_topic(segment.topic_label)
    if topic_label and topic_label in score_payload:
        bump(score_payload, topic_label, TOPIC_PRIOR_WEIGHT, "topic prior")
    if topic_text:
        add_topic_prior_scores(topic_text, score_payload)

    # Segment-level dampening: one affectionate or sexual word should not label
    # a long puzzle/logistics exchange as intimacy.
    apply_contextual_adjustments(
        score_payload,
        substantive_messages=substantive_messages,
        token_total=token_total,
        sexual_messages=sexual_messages,
        romantic_messages=romantic_messages,
        attachment_count=attachment_count,
    )

    ranked = sorted(
        ((category, payload["score"], payload) for category, payload in score_payload.items()),
        key=lambda item: item[1],
        reverse=True,
    )
    top_category, top_score, top_payload = ranked[0]
    second_category, second_score, _ = ranked[1]
    category_status = "classified"
    category_reason = "lexical_score"

    if substantive_messages == 0:
        top_category = None
        top_score = 0.0
        top_payload = {"signals": ["non text segment"]}
        category_status = "no_text"
        category_reason = "non_text"
    elif segment.topic_id is None:
        top_category = None
        top_score = 0.0
        top_payload = {"signals": ["hdbscan outlier"]}
        category_status = "topic_outlier"
        category_reason = "hdbscan_outlier"
    elif top_category == "romantic_intimacy" and romantic_messages == 0 and top_score < 4.0:
        fallback = fallback_without(ranked, {"romantic_intimacy", "sexual_intimacy"})
        if fallback is not None:
            top_category, top_score, top_payload = fallback
            category_reason = "fallback"
        else:
            top_category = None
            top_score = 0.0
            top_payload = {"signals": ["unsupported intimacy signal"]}
            category_status = "low_signal"
            category_reason = "lexical_score"
    elif top_category == "sexual_intimacy" and sexual_messages == 0:
        fallback = fallback_without(ranked, {"sexual_intimacy"})
        if fallback is not None:
            top_category, top_score, top_payload = fallback
            category_reason = "fallback"
        else:
            top_category = None
            top_score = 0.0
            top_payload = {"signals": ["unsupported sexual signal"]}
            category_status = "low_signal"
            category_reason = "lexical_score"

    if category_status == "classified" and top_score < MIN_PRIMARY_SCORE:
        small_talk_score = score_payload["small_talk"]["score"]
        if small_talk_score >= MIN_SMALL_TALK_SCORE and small_talk_score >= top_score * 0.75:
            top_category = "small_talk"
            top_score = small_talk_score
            top_payload = score_payload["small_talk"]
        else:
            top_category = None
            top_score = 0.0
            top_payload = {"signals": ["low signal"]}
            category_status = "low_signal"
            category_reason = "lexical_score"

    if top_category is None:
        confidence = 0.0
    elif top_category == "small_talk":
        confidence = min(0.75, 0.35 + top_score / 10)
    else:
        confidence = confidence_from_margin(top_score, second_score)

    secondary_category = None
    secondary_confidence = None
    secondary_score = None
    if top_category is not None:
        for category, score, _payload in ranked:
            if category == top_category or score < MIN_SECONDARY_SCORE:
                continue
            secondary_category = category
            secondary_score = round(score, 4)
            secondary_confidence = round(min(0.95, score / max(top_score, 1.0)), 3)
            if category_status == "classified" and abs(top_score - score) < AMBIGUOUS_SCORE_MARGIN:
                category_status = "ambiguous"
            break

    signals = top_payload.get("signals", [])[:10] if isinstance(top_payload, dict) else []
    result = (
        segment.segment_id,
        top_category,
        round(confidence, 3),
        category_status,
        category_reason,
        secondary_category,
        secondary_confidence,
        secondary_score,
        METHOD,
        json.dumps(signals),
    )
    return result, score_payload


def add_text_scores(text: str, payload: dict[str, dict]) -> None:
    tokens = tokenize(text)
    token_counts = Counter(tokens)

    for category, lex in LEXICONS.items():
        for phrase, weight in lex.phrases.items():
            if phrase in text:
                bump(payload, category, weight, phrase)
        for pattern, weight, label in lex.patterns:
            matches = pattern.findall(text)
            if matches:
                bump(payload, category, weight * min(3, len(matches)), label)
        for word, weight in lex.words.items():
            count = token_counts.get(word, 0)
            if count:
                bump(payload, category, weight * min(3, count), word)

    if "?" in text:
        bump(payload, "daily_check_in", 0.25, "question")

    # Prevent pure color words from dominating unless they appear in a puzzle
    # context, where the Connections color sequence is a real signal.
    if any(word in text for word in ["wordle", "connections"]):
        colors = sum(token_counts.get(color, 0) for color in ["blue", "green", "yellow", "purple"])
        if colors >= 2:
            bump(payload, "games", min(4.0, colors * 0.9), "game color sequence")


def add_topic_prior_scores(topic_text: str, payload: dict[str, dict]) -> None:
    for category, lex in LEXICONS.items():
        topic_hits = 0
        for phrase in lex.phrases:
            if phrase in topic_text:
                topic_hits += 1
        for word in lex.words:
            if re.search(rf"\b{re.escape(word)}\b", topic_text):
                topic_hits += 1
        if topic_hits:
            bump(payload, category, min(1.2, topic_hits * TOPIC_PRIOR_WEIGHT), "topic keywords")


def apply_contextual_adjustments(
    payload: dict[str, dict],
    *,
    substantive_messages: int,
    token_total: int,
    sexual_messages: int,
    romantic_messages: int,
    attachment_count: int,
) -> None:
    if substantive_messages == 0:
        return

    non_intimacy_max = max(
        item["score"]
        for category, item in payload.items()
        if category not in {"romantic_intimacy", "sexual_intimacy"}
    )

    romantic_density = romantic_messages / substantive_messages
    sexual_density = sexual_messages / substantive_messages

    if romantic_density < 0.18 and non_intimacy_max >= 3.5:
        payload["romantic_intimacy"]["score"] *= 0.32
        payload["romantic_intimacy"]["signals"].append("low-density romance dampened")
    elif romantic_density < 0.28 and non_intimacy_max >= 5.0:
        payload["romantic_intimacy"]["score"] *= 0.55
        payload["romantic_intimacy"]["signals"].append("mixed-topic romance dampened")
    elif romantic_messages <= 1 and payload["romantic_intimacy"]["score"] < max(5.0, non_intimacy_max * 0.9):
        payload["romantic_intimacy"]["score"] *= 0.55
        payload["romantic_intimacy"]["signals"].append("single-message romance dampened")

    if payload["health"]["score"] >= 4.0 and payload["sexual_intimacy"]["score"] <= payload["health"]["score"] * 1.35:
        payload["sexual_intimacy"]["score"] *= 0.25
        payload["sexual_intimacy"]["signals"].append("medical context dampened")
    elif sexual_density < 0.12 and non_intimacy_max >= 5.0:
        payload["sexual_intimacy"]["score"] *= 0.5
        payload["sexual_intimacy"]["signals"].append("low-density sexual signal dampened")
    elif sexual_messages <= 1 and payload["sexual_intimacy"]["score"] < max(5.0, non_intimacy_max * 0.95):
        payload["sexual_intimacy"]["score"] *= 0.45
        payload["sexual_intimacy"]["signals"].append("single-message sexual signal dampened")

    if payload["games"]["score"] >= 4.5 and payload["tech"]["score"] >= 2.0:
        payload["games"]["score"] += 0.8
        payload["games"]["signals"].append("puzzle exchange with tech aside")

    if attachment_count >= 2:
        payload["photo_sharing"]["score"] += min(3.0, attachment_count * 0.4)

    if token_total < 10:
        for category in payload:
            payload[category]["score"] *= 0.85


def score_message_intimacy(text: str) -> MessageScore:
    signals: list[str] = []
    romantic = score_one_category(text, LEXICONS["romantic_intimacy"], signals, "romantic")
    sexual = score_one_category(text, LEXICONS["sexual_intimacy"], signals, "sexual")

    # "naked" can be logistical/body-state context; by itself it is weaker than
    # an explicit sexual turn.
    if sexual < 2.5 and re.search(r"\bnaked\b", text):
        sexual *= 0.5

    return MessageScore(round(romantic, 4), round(sexual, 4), signals[:8])


def score_one_category(text: str, lex: Lexicon, signals: list[str], prefix: str) -> float:
    score = 0.0
    tokens = Counter(tokenize(text))
    for phrase, weight in lex.phrases.items():
        if phrase in text:
            score += weight
            signals.append(f"{prefix}:{phrase}")
    for pattern, weight, label in lex.patterns:
        matches = pattern.findall(text)
        if matches:
            score += weight * min(3, len(matches))
            signals.append(f"{prefix}:{label}")
    for word, weight in lex.words.items():
        count = tokens.get(word, 0)
        if count:
            score += weight * min(3, count)
            signals.append(f"{prefix}:{word}")
    return score


def write_results(
    conn: sqlite3.Connection,
    segment_results: list[tuple],
    category_scores: list[tuple],
    message_scores: dict[int, MessageScore],
) -> None:
    conn.executescript(
        """
        DROP TABLE IF EXISTS seg_segment_categories;
        DROP TABLE IF EXISTS seg_segment_category_scores;
        DROP TABLE IF EXISTS seg_message_intimacy_scores;

        CREATE TABLE seg_segment_categories (
            segment_id INTEGER PRIMARY KEY,
            category TEXT,
            confidence REAL NOT NULL,
            category_status TEXT NOT NULL,
            category_reason TEXT NOT NULL,
            secondary_category TEXT,
            secondary_confidence REAL,
            secondary_score REAL,
            method TEXT NOT NULL,
            signals TEXT NOT NULL
        );
        CREATE INDEX seg_segment_categories_cat_idx ON seg_segment_categories(category);
        CREATE INDEX seg_segment_categories_status_idx ON seg_segment_categories(category_status);
        CREATE INDEX seg_segment_categories_secondary_idx ON seg_segment_categories(secondary_category);

        CREATE TABLE seg_segment_category_scores (
            segment_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            score REAL NOT NULL,
            evidence_count INTEGER NOT NULL,
            signals TEXT NOT NULL,
            PRIMARY KEY (segment_id, category)
        );
        CREATE INDEX seg_segment_category_scores_cat_idx ON seg_segment_category_scores(category);

        CREATE TABLE seg_message_intimacy_scores (
            msg_id INTEGER PRIMARY KEY,
            romantic_score REAL NOT NULL,
            sexual_score REAL NOT NULL,
            signals TEXT NOT NULL
        );
        CREATE INDEX seg_message_intimacy_scores_romantic_idx ON seg_message_intimacy_scores(romantic_score);
        CREATE INDEX seg_message_intimacy_scores_sexual_idx ON seg_message_intimacy_scores(sexual_score);
        """
    )
    conn.executemany(
        """
        INSERT INTO seg_segment_categories (
          segment_id, category, confidence, category_status, category_reason,
          secondary_category, secondary_confidence, secondary_score, method, signals
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        segment_results,
    )
    conn.executemany(
        """
        INSERT INTO seg_segment_category_scores (
          segment_id, category, score, evidence_count, signals
        ) VALUES (?,?,?,?,?)
        """,
        category_scores,
    )
    conn.executemany(
        """
        INSERT INTO seg_message_intimacy_scores (
          msg_id, romantic_score, sexual_score, signals
        ) VALUES (?,?,?,?)
        """,
        [
            (msg_id, score.romantic, score.sexual, json.dumps(score.signals))
            for msg_id, score in message_scores.items()
        ],
    )
    conn.commit()


def update_topics(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        DROP TABLE IF EXISTS seg_topic_categories;
        CREATE TABLE seg_topic_categories (
            topic_id INTEGER PRIMARY KEY,
            category TEXT NOT NULL,
            confidence REAL NOT NULL,
            method TEXT NOT NULL
        );
        """
    )
    rows = conn.execute(
        """
        SELECT s.topic_id,
               c.category,
               SUM(s.n_msgs * MAX(c.confidence, 0.25)) AS weight
        FROM seg_segments s
        JOIN seg_segment_categories c ON c.segment_id = s.id
        WHERE s.topic_id IS NOT NULL
          AND c.category IS NOT NULL
          AND c.category_status = 'classified'
        GROUP BY s.topic_id, c.category
        ORDER BY s.topic_id ASC, weight DESC
        """
    ).fetchall()

    by_topic: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        by_topic[int(row["topic_id"])].append(row)

    topic_rows = []
    for topic_id, grouped in by_topic.items():
        total = sum(float(row["weight"]) for row in grouped)
        best = max(grouped, key=lambda row: float(row["weight"]))
        confidence = float(best["weight"]) / total if total else 0.0
        topic_rows.append((topic_id, best["category"], round(confidence, 3), "segment-majority-lexical-v2"))
        conn.execute("UPDATE seg_topics SET label=? WHERE id=?", (best["category"], topic_id))

    conn.executemany(
        "INSERT INTO seg_topic_categories (topic_id, category, confidence, method) VALUES (?,?,?,?)",
        topic_rows,
    )
    conn.commit()


def update_topic_reps(conn: sqlite3.Connection) -> None:
    if not TOPIC_REPS.exists():
        return
    reps = json.loads(TOPIC_REPS.read_text())
    rows = conn.execute("SELECT topic_id, category, confidence FROM seg_topic_categories").fetchall()
    for row in rows:
        key = str(row["topic_id"])
        if key not in reps:
            continue
        reps[key]["label"] = row["category"]
        reps[key]["confidence"] = row["confidence"]
        reps[key]["method"] = "segment-majority-lexical-v2"
    TOPIC_REPS.write_text(json.dumps(reps, indent=2))


def print_summary(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT COALESCE(category, category_status) AS category,
               category_status,
               COUNT(*) AS n,
               ROUND(AVG(confidence), 3) AS confidence
        FROM seg_segment_categories
        GROUP BY COALESCE(category, category_status), category_status
        ORDER BY n DESC
        """
    ).fetchall()
    print("[refine] segments per category:")
    for row in rows:
        print(f"   {row['category']:<22} {row['category_status']:<14} {row['n']:>5,}  avg_conf={row['confidence']}")

    intimacy = conn.execute(
        """
        SELECT
          SUM(CASE WHEN category = 'romantic_intimacy' THEN 1 ELSE 0 END) AS romantic_segments,
          SUM(CASE WHEN category = 'sexual_intimacy' THEN 1 ELSE 0 END) AS sexual_segments,
          (SELECT COUNT(*) FROM seg_message_intimacy_scores WHERE romantic_score >= 2.3) AS romantic_messages,
          (SELECT COUNT(*) FROM seg_message_intimacy_scores WHERE sexual_score >= 2.3) AS sexual_messages
        FROM seg_segment_categories
        """
    ).fetchone()
    print(
        "[refine] intimacy split: "
        f"{intimacy['romantic_segments']} romantic segments, "
        f"{intimacy['sexual_segments']} sexual segments, "
        f"{intimacy['romantic_messages']} romantic-scored messages, "
        f"{intimacy['sexual_messages']} sexual-scored messages"
    )


def bump(payload: dict[str, dict], category: str, amount: float, signal: str) -> None:
    if category not in payload:
        return
    payload[category]["score"] += amount
    payload[category]["evidence"] += 1
    if signal and signal not in payload[category]["signals"]:
        payload[category]["signals"].append(signal)


def fallback_without(ranked: list[tuple[str, float, dict]], forbidden: set[str]) -> tuple[str, float, dict] | None:
    for category, score, payload in ranked:
        if category not in forbidden and score >= MIN_PRIMARY_SCORE:
            return category, score, payload
    return None


def confidence_from_margin(top: float, second: float) -> float:
    if top <= 0:
        return 0.2
    margin = max(0.0, top - second)
    return min(0.97, 0.45 + 0.42 * (margin / max(top, 1.0)) + 0.12 * math.tanh(top / 8))


def normalize_topic(label: str | None) -> str | None:
    if not label:
        return None
    label = label.strip().lower().replace(" ", "_")
    return TOPIC_CATEGORY_MAP.get(label, label)


def normalize(text: str) -> str:
    text = text.lower()
    text = text.replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"\s+", " ", text).strip()


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def safe_json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    except json.JSONDecodeError:
        pass
    return [part.strip() for part in raw.split(",") if part.strip()]


if __name__ == "__main__":
    main()
