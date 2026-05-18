#!/usr/bin/env python3
"""Build the synthetic eval fixture DB.

The committed gold labels in data/eval/*.jsonl are ID-only. This script creates
the matching tiny.db with hand-written synthetic text so CI can exercise the
eval runner without touching the private archive.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "fixtures" / "tiny.db"


MESSAGES = [
    (1, 1_700_000_000, 1, "I love you and I miss you", None, 0),
    (2, 1_700_000_120, 0, "Love you too sweetheart", None, 0),
    (3, 1_700_003_600, 1, "Good morning", None, 0),
    (4, 1_700_007_200, 0, "What time is dinner tonight?", None, 0),
    (5, 1_700_007_500, 1, "Let's plan for seven", None, 0),
    (6, 1_700_014_400, 0, "I feel overwhelmed and anxious today", None, 0),
    (7, 1_700_014_700, 1, "I'm sorry, are you okay? I can bring food", None, 0),
    (8, 1_700_021_600, 0, "Okay sounds good", None, 0),
    (9, 1_700_021_800, 1, "lol that was silly", None, 0),
    (10, 1_700_028_800, 0, None, None, 1),
    (11, 1_700_032_400, 1, "That hurt and I am frustrated", None, 0),
]

SEGMENTS = [
    (1, 1, 2, 1_700_000_000, 1_700_000_120, 2, 1, 1, 1),
    (2, 4, 5, 1_700_007_200, 1_700_007_500, 2, 1, 1, 2),
    (3, 6, 7, 1_700_014_400, 1_700_014_700, 2, 1, 1, 3),
    (4, 8, 9, 1_700_021_600, 1_700_021_800, 2, 1, 1, 4),
    (5, 10, 10, 1_700_028_800, 1_700_028_800, 1, 0, 1, None),
]

SEGMENT_MESSAGES = [
    (1, 1),
    (1, 2),
    (2, 4),
    (2, 5),
    (3, 6),
    (3, 7),
    (4, 8),
    (4, 9),
    (5, 10),
]

SEGMENT_CATEGORIES = [
    (1, "romantic_intimacy", 0.91, "classified", "lexical_score", None, None, None, "fixture-lexical-v1", '["warmth"]'),
    (2, "logistics", 0.84, "classified", "lexical_score", None, None, None, "fixture-lexical-v1", '["planning"]'),
    (3, "emotional_support", 0.78, "classified", "lexical_score", None, None, None, "fixture-lexical-v1", '["strain","care"]'),
    (4, "small_talk", 0.72, "classified", "lexical_score", None, None, None, "fixture-lexical-v1", '["humor"]'),
    (5, None, 0.0, "topic_outlier", "hdbscan_outlier", None, None, None, "fixture-topic-v1", "[]"),
]

TOPICS = [
    (1, "affection", 1),
    (2, "logistics", 1),
    (3, "support", 1),
    (4, "banter", 1),
]

SEASONS = [
    (1, "Fixture season", "2023-11", "2023-11", "fixture-season-v1", "fixture-1"),
]


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()

    conn = sqlite3.connect(OUT)
    conn.executescript(
        """
        CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE attachments (
            id INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL,
            guid TEXT,
            filename TEXT,
            rel_path TEXT,
            mime_type TEXT,
            uti TEXT,
            total_bytes INTEGER,
            is_image INTEGER NOT NULL,
            is_video INTEGER NOT NULL,
            thumb_path TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            is_from_me INTEGER NOT NULL,
            text TEXT,
            associated_message_type INTEGER,
            has_attachment INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE seg_segments (
            id INTEGER PRIMARY KEY,
            start_msg_id INTEGER NOT NULL,
            end_msg_id INTEGER NOT NULL,
            start_ts INTEGER NOT NULL,
            end_ts INTEGER NOT NULL,
            n_msgs INTEGER NOT NULL,
            n_me INTEGER NOT NULL,
            n_them INTEGER NOT NULL,
            topic_id INTEGER
        );
        CREATE TABLE seg_msg_segment (
            segment_id INTEGER NOT NULL,
            msg_id INTEGER NOT NULL,
            PRIMARY KEY (segment_id, msg_id)
        );
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
        CREATE TABLE seg_topics (
            id INTEGER PRIMARY KEY,
            label TEXT NOT NULL,
            n_segments INTEGER NOT NULL
        );
        CREATE TABLE seg_seasons (
            id INTEGER PRIMARY KEY,
            label TEXT NOT NULL,
            start_ym TEXT NOT NULL,
            end_ym TEXT NOT NULL,
            method TEXT NOT NULL,
            generated_at TEXT NOT NULL
        );
        CREATE TABLE seg_topic_stability (
            topic_id INTEGER PRIMARY KEY,
            jaccard_mean REAL NOT NULL,
            jaccard_min REAL NOT NULL,
            member_count_mean REAL NOT NULL,
            method TEXT NOT NULL,
            generated_at TEXT NOT NULL
        );
        CREATE TABLE seg_topic_categories (
            topic_id INTEGER PRIMARY KEY,
            category TEXT NOT NULL,
            confidence REAL NOT NULL,
            method TEXT NOT NULL
        );
        CREATE TABLE seg_links (
            from_segment_id INTEGER NOT NULL,
            to_segment_id INTEGER NOT NULL,
            gap_seconds INTEGER NOT NULL,
            from_category TEXT,
            to_category TEXT
        );
        CREATE TABLE seg_category_transitions (
            from_cat TEXT NOT NULL,
            to_cat TEXT NOT NULL,
            n INTEGER NOT NULL,
            mean_gap_seconds REAL NOT NULL,
            PRIMARY KEY (from_cat, to_cat)
        );
        CREATE TABLE phrase_bigrams (
            gram TEXT NOT NULL,
            sender TEXT NOT NULL,
            n_count INTEGER NOT NULL,
            PRIMARY KEY (gram, sender)
        );
        CREATE TABLE phrase_trigrams (
            gram TEXT NOT NULL,
            sender TEXT NOT NULL,
            n_count INTEGER NOT NULL,
            PRIMARY KEY (gram, sender)
        );
        CREATE TABLE phrase_collocations (
            gram TEXT PRIMARY KEY,
            llr REAL NOT NULL,
            pmi REAL NOT NULL,
            tscore REAL NOT NULL,
            n_count INTEGER NOT NULL
        );
        CREATE TABLE phrase_divergence_2 (
            gram TEXT PRIMARY KEY,
            count_me INTEGER NOT NULL,
            count_them INTEGER NOT NULL,
            log_odds_z REAL NOT NULL,
            combined_count INTEGER NOT NULL
        );
        CREATE TABLE phrase_divergence_3 (
            gram TEXT PRIMARY KEY,
            count_me INTEGER NOT NULL,
            count_them INTEGER NOT NULL,
            log_odds_z REAL NOT NULL,
            combined_count INTEGER NOT NULL
        );
        CREATE TABLE sentence_stats (
            sender TEXT PRIMARY KEY,
            n_sentences INTEGER NOT NULL,
            mean_words REAL NOT NULL,
            median_words REAL NOT NULL,
            p90_words REAL NOT NULL,
            question_rate REAL NOT NULL,
            excl_rate REAL NOT NULL,
            emoji_rate REAL NOT NULL,
            fk_grade REAL NOT NULL
        );
        CREATE TABLE sentence_length_hist (
            sender TEXT NOT NULL,
            bucket TEXT NOT NULL,
            n_count INTEGER NOT NULL,
            PRIMARY KEY (sender, bucket)
        );
        CREATE TABLE cmp_people (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            is_target INTEGER NOT NULL,
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
            count_target INTEGER NOT NULL,
            count_others INTEGER NOT NULL,
            log_odds_z REAL NOT NULL,
            combined_count INTEGER NOT NULL,
            side TEXT NOT NULL
        );
        CREATE TABLE cmp_meta (
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
        """
    )
    conn.executemany(
        "INSERT INTO meta (k, v) VALUES (?, ?)",
        [
            ("generated_at", "fixture-1"),
            ("conversation_id", "fixture"),
            ("conversation_title", "Fixture Conversation"),
            ("conversation_brand", "fixture"),
            ("conversation_subtitle", "synthetic fixture conversation"),
            ("timezone", "America/Vancouver"),
            ("self_label", "Me"),
            ("self_short_label", "Me"),
            ("counterpart_label", "Them"),
            ("counterpart_short_label", "Them"),
        ],
    )
    conn.executemany(
        "INSERT INTO messages (id, ts, is_from_me, text, associated_message_type, has_attachment) VALUES (?,?,?,?,?,?)",
        MESSAGES,
    )
    conn.executemany(
        """
        INSERT INTO seg_segments (
          id, start_msg_id, end_msg_id, start_ts, end_ts, n_msgs, n_me, n_them, topic_id
        ) VALUES (?,?,?,?,?,?,?,?,?)
        """,
        SEGMENTS,
    )
    conn.executemany("INSERT INTO seg_msg_segment (segment_id, msg_id) VALUES (?,?)", SEGMENT_MESSAGES)
    conn.executemany(
        """
        INSERT INTO seg_segment_categories (
          segment_id, category, confidence, category_status, category_reason,
          secondary_category, secondary_confidence, secondary_score, method, signals
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        SEGMENT_CATEGORIES,
    )
    conn.executemany("INSERT INTO seg_topics (id, label, n_segments) VALUES (?,?,?)", TOPICS)
    conn.executemany(
        "INSERT INTO seg_seasons (id, label, start_ym, end_ym, method, generated_at) VALUES (?,?,?,?,?,?)",
        SEASONS,
    )
    conn.executemany(
        """
        INSERT INTO seg_topic_stability (
          topic_id, jaccard_mean, jaccard_min, member_count_mean, method, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (1, 0.91, 0.86, 1.0, "fixture-stability-v1", "fixture-1"),
            (2, 0.88, 0.8, 1.0, "fixture-stability-v1", "fixture-1"),
            (3, 0.76, 0.7, 1.0, "fixture-stability-v1", "fixture-1"),
            (4, 0.67, 0.6, 1.0, "fixture-stability-v1", "fixture-1"),
        ],
    )
    conn.executemany(
        "INSERT INTO seg_topic_categories (topic_id, category, confidence, method) VALUES (?, ?, ?, ?)",
        [
            (1, "romantic_intimacy", 0.91, "fixture-topic-v1"),
            (2, "logistics", 0.84, "fixture-topic-v1"),
            (3, "emotional_support", 0.78, "fixture-topic-v1"),
            (4, "small_talk", 0.72, "fixture-topic-v1"),
        ],
    )
    conn.executemany(
        "INSERT INTO cmp_meta (k, v) VALUES (?, ?)",
        [
            ("generated_at", "fixture-1"),
            ("counterpart_label", "Them"),
            ("target_outbound_tokens", "0"),
        ],
    )
    conn.execute("INSERT INTO messages_fts(rowid, text) SELECT id, COALESCE(text, '') FROM messages")
    conn.commit()
    conn.close()
    print(f"[eval-fixture] wrote {OUT}")


if __name__ == "__main__":
    main()
