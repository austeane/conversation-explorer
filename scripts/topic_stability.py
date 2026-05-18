#!/usr/bin/env python3
"""Compute topic stability from bootstrapped segment centroids.

This is intentionally lighter than rerunning BERTopic in CI-sized loops. It
uses the persisted segment embeddings and current topic assignments, resamples
topic centroids five times, reassigns every segment to its nearest centroid, and
stores per-topic Jaccard agreement with the original assignment.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
SEG_EMB_PATH = ROOT / "data" / "segment_embeddings.npy"
SEG_IDS_PATH = ROOT / "data" / "segment_ids.npy"
SEEDS = [11, 23, 37, 41, 53]
SAMPLE_SHARE = 0.8


def main() -> None:
    if not SEG_EMB_PATH.exists() or not SEG_IDS_PATH.exists():
        raise SystemExit("segment embeddings missing - run scripts/topic_model.py first")

    embeddings = np.load(SEG_EMB_PATH).astype("float32")
    segment_ids = np.load(SEG_IDS_PATH).astype("int64")
    id_to_index = {int(segment_id): index for index, segment_id in enumerate(segment_ids)}

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT id, topic_id
        FROM seg_segments
        WHERE topic_id IS NOT NULL AND topic_id >= 0
        ORDER BY id
        """
    ).fetchall()

    topic_members: dict[int, list[int]] = {}
    for row in rows:
        index = id_to_index.get(int(row["id"]))
        if index is None:
            continue
        topic_members.setdefault(int(row["topic_id"]), []).append(index)

    topic_ids = sorted(topic for topic, members in topic_members.items() if members)
    if not topic_ids:
        raise SystemExit("no topic assignments found")

    normalized = normalize_rows(embeddings)
    original_sets = {topic: set(members) for topic, members in topic_members.items()}
    jaccards: dict[int, list[float]] = {topic: [] for topic in topic_ids}
    member_counts: dict[int, list[int]] = {topic: [] for topic in topic_ids}

    for seed in SEEDS:
        rng = np.random.default_rng(seed)
        centroids = []
        centroid_topics = []
        for topic in topic_ids:
            members = topic_members[topic]
            sample_size = max(1, int(round(len(members) * SAMPLE_SHARE)))
            if len(members) >= 3:
                sample = rng.choice(members, size=sample_size, replace=False)
            else:
                sample = np.asarray(members)
            center = normalized[sample].mean(axis=0)
            center = center / max(float(np.linalg.norm(center)), 1e-9)
            centroids.append(center)
            centroid_topics.append(topic)

        centroid_matrix = np.vstack(centroids)
        assignments = normalized @ centroid_matrix.T
        winners = assignments.argmax(axis=1)
        predicted_sets = {topic: set() for topic in topic_ids}
        for segment_index in {index for members in topic_members.values() for index in members}:
            predicted_sets[centroid_topics[int(winners[segment_index])]].add(segment_index)

        for topic in topic_ids:
            original = original_sets[topic]
            predicted = predicted_sets[topic]
            union = original | predicted
            score = len(original & predicted) / len(union) if union else 0.0
            jaccards[topic].append(score)
            member_counts[topic].append(len(predicted))

    generated_at = datetime.now(timezone.utc).isoformat()
    conn.execute("DROP TABLE IF EXISTS seg_topic_stability")
    conn.execute(
        """
        CREATE TABLE seg_topic_stability (
          topic_id INTEGER PRIMARY KEY,
          jaccard_mean REAL NOT NULL,
          jaccard_min REAL NOT NULL,
          member_count_mean REAL NOT NULL,
          method TEXT NOT NULL,
          generated_at TEXT NOT NULL
        )
        """
    )
    conn.executemany(
        """
        INSERT INTO seg_topic_stability (
          topic_id, jaccard_mean, jaccard_min, member_count_mean, method, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                topic,
                round(float(np.mean(jaccards[topic])), 4),
                round(float(np.min(jaccards[topic])), 4),
                round(float(np.mean(member_counts[topic])), 2),
                "bootstrap-centroid-v1",
                generated_at,
            )
            for topic in topic_ids
        ],
    )
    conn.commit()
    conn.close()
    print(f"[topic-stability] wrote {len(topic_ids)} topics to seg_topic_stability")


def normalize_rows(values: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.maximum(norms, 1e-9)


if __name__ == "__main__":
    main()
