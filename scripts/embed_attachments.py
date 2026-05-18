#!/usr/bin/env python3
"""Build local attachment embeddings and clusters.

This script is intentionally offline-first. If a future environment provides a
CLIP backend, this is the place to swap in semantic image vectors; the current
default uses deterministic visual descriptors plus coarse local captions so the
attachments surface can expose clusters without sending images anywhere.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageStat

PROJECT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("RUNTIME_DB_PATH", PROJECT / "data" / "runtime" / "conversation.db"))
PUBLIC_DIR = PROJECT / "public"
EMBEDDINGS_PATH = PROJECT / "data" / "embeddings_attach.npy"
IDS_PATH = PROJECT / "data" / "embeddings_attach_ids.npy"
METHOD = "visual-caption-v1"


@dataclass(frozen=True)
class Attachment:
    id: int
    message_id: int
    thumb_path: str
    ts: int


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit(f"Missing DB: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = [
        Attachment(
            id=int(row["id"]),
            message_id=int(row["message_id"]),
            thumb_path=str(row["thumb_path"]),
            ts=int(row["ts"]),
        )
        for row in conn.execute(
            """
            SELECT a.id, a.message_id, a.thumb_path, m.ts
            FROM attachments a
            JOIN messages m ON m.id = a.message_id
            WHERE a.is_image = 1 AND a.thumb_path IS NOT NULL
            ORDER BY a.id
            """
        )
    ]
    if not rows:
        print("[attach-embed] no local image thumbnails found")
        return

    feature_rows: list[np.ndarray] = []
    captions: dict[int, str] = {}
    stats: dict[int, dict[str, float | str]] = {}
    kept: list[Attachment] = []

    for row in rows:
        image_path = PUBLIC_DIR / row.thumb_path.lstrip("/")
        if not image_path.exists():
            continue
        try:
            feature, stat = describe_image(image_path)
        except Exception as exc:  # pragma: no cover - logs bad local image files
            print(f"[attach-embed] skip {row.id}: {exc}")
            continue
        feature_rows.append(feature)
        captions[row.id] = caption_for(stat)
        stats[row.id] = stat
        kept.append(row)

    if not kept:
        print("[attach-embed] no readable image thumbnails found")
        return

    matrix = np.vstack(feature_rows).astype("float32")
    matrix = l2_normalize(matrix)
    ids = np.array([row.id for row in kept], dtype=np.int64)

    cluster_ids = cluster_vectors(matrix, choose_cluster_count(len(kept)))
    cluster_sizes = {
        cluster_id: int(np.sum(cluster_ids == cluster_id))
        for cluster_id in sorted(set(cluster_ids.tolist()))
    }
    cluster_labels = label_clusters(cluster_ids, kept, stats)
    nearest = nearest_within_cluster(matrix, ids, cluster_ids)
    segment_ids = map_segments(conn, kept)

    EMBEDDINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    np.save(EMBEDDINGS_PATH, matrix)
    np.save(IDS_PATH, ids)
    write_tables(
        conn=conn,
        rows=kept,
        cluster_ids=cluster_ids,
        cluster_sizes=cluster_sizes,
        cluster_labels=cluster_labels,
        nearest=nearest,
        segment_ids=segment_ids,
        captions=captions,
        stats=stats,
    )
    conn.commit()
    conn.close()
    print(
        f"[attach-embed] wrote {len(kept)} embeddings, "
        f"{len(cluster_sizes)} clusters, method={METHOD}"
    )


def describe_image(path: Path) -> tuple[np.ndarray, dict[str, float | str]]:
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        width, height = rgb.size
        thumb = rgb.resize((96, 96), Image.Resampling.LANCZOS)
        arr = np.asarray(thumb, dtype=np.float32) / 255.0

    hist, _ = np.histogramdd(
        arr.reshape(-1, 3),
        bins=(4, 4, 4),
        range=((0, 1), (0, 1), (0, 1)),
    )
    hist = hist.reshape(-1).astype(np.float32)
    hist = hist / max(float(hist.sum()), 1.0)

    mean = arr.reshape(-1, 3).mean(axis=0)
    std = arr.reshape(-1, 3).std(axis=0)
    gray = arr.mean(axis=2)
    grad_y = np.diff(gray, axis=0)
    grad_x = np.diff(gray, axis=1)
    texture = float((np.abs(grad_x).mean() + np.abs(grad_y).mean()) / 2)
    brightness = float(gray.mean())
    saturation = float((arr.max(axis=2) - arr.min(axis=2)).mean())
    warmth = float(mean[0] - mean[2])
    aspect = math.log(max(width, 1) / max(height, 1))

    extra = np.array(
        [
            *mean.tolist(),
            *std.tolist(),
            brightness,
            saturation,
            texture,
            warmth,
            aspect,
        ],
        dtype=np.float32,
    )
    stat = {
        "brightness": brightness,
        "saturation": saturation,
        "texture": texture,
        "warmth": warmth,
        "aspect": aspect,
        "tone": tone_for(mean),
        "orientation": orientation_for(aspect),
    }
    return np.concatenate([hist, extra]), stat


def tone_for(mean: np.ndarray) -> str:
    labels = ["red", "green", "blue"]
    dominant = labels[int(np.argmax(mean))]
    if float(max(mean) - min(mean)) < 0.08:
        return "neutral"
    if dominant == "red" and mean[1] > mean[2]:
        return "warm"
    return dominant


def orientation_for(aspect: float) -> str:
    if aspect > 0.22:
        return "landscape"
    if aspect < -0.22:
        return "portrait"
    return "square"


def caption_for(stat: dict[str, float | str]) -> str:
    light = "bright" if stat["brightness"] >= 0.58 else "dim" if stat["brightness"] < 0.34 else "midtone"
    color = "color-rich" if stat["saturation"] >= 0.28 else "muted"
    texture = "detailed" if stat["texture"] >= 0.085 else "quiet"
    return f"{light}, {color}, {texture}, {stat['orientation']} image"


def l2_normalize(matrix: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(matrix, axis=1, keepdims=True)
    norm[norm == 0] = 1
    return matrix / norm


def choose_cluster_count(n: int) -> int:
    if n < 4:
        return 1
    return min(10, max(2, round(math.sqrt(n))))


def cluster_vectors(matrix: np.ndarray, k: int) -> np.ndarray:
    if k <= 1:
        return np.zeros(matrix.shape[0], dtype=np.int64)

    seed_indexes = np.linspace(0, matrix.shape[0] - 1, k, dtype=np.int64)
    centers = matrix[seed_indexes].copy()
    labels = np.zeros(matrix.shape[0], dtype=np.int64)

    for _ in range(40):
        scores = matrix @ centers.T
        new_labels = np.argmax(scores, axis=1).astype(np.int64)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels
        for cluster_id in range(k):
            members = matrix[labels == cluster_id]
            if len(members) == 0:
                continue
            center = members.mean(axis=0, keepdims=True)
            centers[cluster_id] = l2_normalize(center)[0]

    return labels


def label_clusters(
    cluster_ids: np.ndarray,
    rows: list[Attachment],
    stats: dict[int, dict[str, float | str]],
) -> dict[int, str]:
    labels: dict[int, str] = {}
    for cluster_id in sorted(set(cluster_ids.tolist())):
        ids = [row.id for index, row in enumerate(rows) if int(cluster_ids[index]) == cluster_id]
        cluster_stats = [stats[attachment_id] for attachment_id in ids]
        avg_brightness = sum(float(s["brightness"]) for s in cluster_stats) / len(cluster_stats)
        avg_saturation = sum(float(s["saturation"]) for s in cluster_stats) / len(cluster_stats)
        orientation = mode(str(s["orientation"]) for s in cluster_stats)
        tone = mode(str(s["tone"]) for s in cluster_stats)
        light = "Bright" if avg_brightness >= 0.58 else "Low light" if avg_brightness < 0.34 else "Midtone"
        color = "vivid" if avg_saturation >= 0.28 else "muted"
        labels[cluster_id] = f"{light} {color} {orientation} · {tone}"
    return labels


def mode(values: object) -> str:
    counts: dict[str, int] = {}
    for value in values:
        key = str(value)
        counts[key] = counts.get(key, 0) + 1
    return max(counts.items(), key=lambda item: (item[1], item[0]))[0]


def nearest_within_cluster(
    matrix: np.ndarray,
    ids: np.ndarray,
    cluster_ids: np.ndarray,
) -> dict[int, list[int]]:
    scores = matrix @ matrix.T
    output: dict[int, list[int]] = {}
    for index, attachment_id in enumerate(ids.tolist()):
        same_cluster = np.where(cluster_ids == cluster_ids[index])[0]
        ranked = sorted(
            (candidate for candidate in same_cluster if candidate != index),
            key=lambda candidate: float(scores[index, candidate]),
            reverse=True,
        )
        output[int(attachment_id)] = [int(ids[candidate]) for candidate in ranked[:6]]
    return output


def map_segments(conn: sqlite3.Connection, rows: list[Attachment]) -> dict[int, int | None]:
    segments = [
        dict(row)
        for row in conn.execute(
            """
            SELECT id, start_msg_id, end_msg_id
            FROM seg_segments
            ORDER BY start_msg_id
            """
        )
    ]
    mapped: dict[int, int | None] = {}
    cursor = 0
    for row in sorted(rows, key=lambda item: item.message_id):
        while cursor < len(segments) and int(segments[cursor]["end_msg_id"]) < row.message_id:
            cursor += 1
        if cursor < len(segments):
            segment = segments[cursor]
            if int(segment["start_msg_id"]) <= row.message_id <= int(segment["end_msg_id"]):
                mapped[row.id] = int(segment["id"])
                continue
        mapped[row.id] = None
    return mapped


def write_tables(
    conn: sqlite3.Connection,
    rows: list[Attachment],
    cluster_ids: np.ndarray,
    cluster_sizes: dict[int, int],
    cluster_labels: dict[int, str],
    nearest: dict[int, list[int]],
    segment_ids: dict[int, int | None],
    captions: dict[int, str],
    stats: dict[int, dict[str, float | str]],
) -> None:
    conn.execute("DROP TABLE IF EXISTS seg_attachment_clusters")
    conn.execute(
        """
        CREATE TABLE seg_attachment_clusters (
          attachment_id INTEGER PRIMARY KEY,
          message_id INTEGER NOT NULL,
          segment_id INTEGER,
          cluster_id INTEGER NOT NULL,
          cluster_label TEXT NOT NULL,
          cluster_size INTEGER NOT NULL,
          caption TEXT NOT NULL,
          similar_attachment_ids TEXT NOT NULL,
          embedding_method TEXT NOT NULL,
          brightness REAL NOT NULL,
          saturation REAL NOT NULL,
          texture REAL NOT NULL,
          warmth REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX seg_attachment_clusters_cluster_idx ON seg_attachment_clusters(cluster_id)")
    conn.execute("CREATE INDEX seg_attachment_clusters_segment_idx ON seg_attachment_clusters(segment_id)")

    payload = [
        (
            row.id,
            row.message_id,
            segment_ids[row.id],
            int(cluster_ids[index]),
            cluster_labels[int(cluster_ids[index])],
            cluster_sizes[int(cluster_ids[index])],
            captions[row.id],
            json.dumps(nearest[row.id]),
            METHOD,
            float(stats[row.id]["brightness"]),
            float(stats[row.id]["saturation"]),
            float(stats[row.id]["texture"]),
            float(stats[row.id]["warmth"]),
        )
        for index, row in enumerate(rows)
    ]
    conn.executemany(
        """
        INSERT INTO seg_attachment_clusters (
          attachment_id, message_id, segment_id, cluster_id, cluster_label,
          cluster_size, caption, similar_attachment_ids, embedding_method,
          brightness, saturation, texture, warmth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        payload,
    )


if __name__ == "__main__":
    main()
