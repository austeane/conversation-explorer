"""
Stage 1 — Segmentation.

Hybrid temporal + semantic:
  * Temporal cut: silence >= max(MESSAGE_TEMPORAL_MIN_HOURS h, k * median_gap of last 50 msgs)
  * Semantic refinement (TextTiling-style, modernized with sentence embeddings):
      Inside any temporal block of length >= MIN_SEM_SPLIT messages, slide a window of W=10,
      take mean-embedding of left and right blocks, compute cosine similarity, then locate
      local minima with depth >= mean_dip + 0.5*std_dip; insert a cut there.

Inputs:
  data/runtime/conversation.db                       — message table
  data/embeddings_msg.npy / *_ids.npy  — per-message embeddings

Outputs (write into the same SQLite, additional tables prefixed seg_):
  seg_segments(id INTEGER PK, start_msg_id, end_msg_id, start_ts, end_ts,
               n_msgs, n_me, n_them, topic_id NULL, dominant_thread NULL)
  seg_msg_segment(msg_id PK, segment_id)
"""
import math
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
EMB_PATH = ROOT / "data" / "embeddings_msg.npy"
IDS_PATH = ROOT / "data" / "embeddings_msg_ids.npy"

TEMPORAL_MIN_HOURS = float(os.environ.get("MESSAGE_TEMPORAL_MIN_HOURS", "12"))
TEMPORAL_K = float(os.environ.get("MESSAGE_TEMPORAL_K", "5"))
W = int(os.environ.get("MESSAGE_TILE_W", "10"))
MIN_SEM_SPLIT = int(os.environ.get("MESSAGE_MIN_SEM_SPLIT", "60"))


def median_recent_gap(prev_gaps: list[int]) -> float:
    if not prev_gaps:
        return 600.0  # 10 min default
    arr = np.asarray(prev_gaps[-50:], dtype=np.float64)
    arr = arr[arr > 0]
    if len(arr) == 0:
        return 600.0
    return float(np.median(arr))


def temporal_segments(rows: list[dict]) -> list[list[int]]:
    """Return list of segments, each a list of message indices into `rows`."""
    if not rows:
        return []
    segments: list[list[int]] = []
    cur: list[int] = [0]
    gaps: list[int] = []
    min_gap_sec = TEMPORAL_MIN_HOURS * 3600.0
    for i in range(1, len(rows)):
        gap = rows[i]["ts"] - rows[i - 1]["ts"]
        med = median_recent_gap(gaps)
        thresh = max(min_gap_sec, TEMPORAL_K * med)
        if gap > thresh:
            segments.append(cur)
            cur = []
        cur.append(i)
        gaps.append(gap)
    if cur:
        segments.append(cur)
    return segments


def semantic_refine(seg_idxs: list[int], emb: np.ndarray, w: int) -> list[list[int]]:
    """TextTiling-style semantic split. Returns sub-segments (lists of indices)."""
    n = len(seg_idxs)
    if n < max(MIN_SEM_SPLIT, 4 * w):
        return [seg_idxs]

    # Block similarity: at boundary i (between i-1 and i), compare mean(emb[i-w:i]) vs mean(emb[i:i+w])
    # Vectorize with sliding mean.
    sub = emb[seg_idxs]  # (n, d), already L2-normalized by sentence-transformers
    # cumulative sum trick for mean
    cs = np.concatenate([np.zeros((1, sub.shape[1]), dtype=sub.dtype), np.cumsum(sub, axis=0)], axis=0)
    # left_mean[i] = mean(sub[i-w:i]), valid for i in [w, n-w]
    sims = np.full(n, np.nan, dtype=np.float64)
    for i in range(w, n - w + 1):
        left = (cs[i] - cs[i - w]) / w
        right = (cs[i + w] - cs[i]) / w
        # cosine
        ln = np.linalg.norm(left) + 1e-9
        rn = np.linalg.norm(right) + 1e-9
        sims[i] = float(np.dot(left, right) / (ln * rn))

    # Compute depth at each candidate boundary i: depth = (max(sim_left, sim_right) - sim[i])
    # where sim_left = max sim in (i-w, i), sim_right = max in (i, i+w]
    depths: list[tuple[int, float]] = []
    for i in range(w + 1, n - w):
        if math.isnan(sims[i]):
            continue
        left_max = np.nanmax(sims[max(w, i - w) : i])
        right_max = np.nanmax(sims[i + 1 : min(n - w + 1, i + w + 1)])
        depth = max(left_max, right_max) - sims[i]
        if depth > 0:
            depths.append((i, depth))

    if not depths:
        return [seg_idxs]

    dvals = np.asarray([d for _, d in depths])
    threshold = float(np.mean(dvals) + 0.5 * np.std(dvals))

    # Pick local minima with depth >= threshold, with minimum spacing of W.
    cuts: list[int] = []
    last_cut = -10 * w
    for i, d in sorted(depths, key=lambda x: -x[1]):
        if d < threshold:
            break
        # is i a local min?
        if any(abs(i - c) < w for c in cuts):
            continue
        cuts.append(i)
    cuts.sort()

    if not cuts:
        return [seg_idxs]

    parts: list[list[int]] = []
    prev = 0
    for c in cuts:
        if c - prev < w:
            continue
        parts.append(seg_idxs[prev:c])
        prev = c
    parts.append(seg_idxs[prev:])
    parts = [p for p in parts if len(p) >= max(3, w // 2)]
    if not parts:
        return [seg_idxs]
    return parts


def main() -> None:
    if not EMB_PATH.exists():
        raise SystemExit("embeddings missing — run scripts/embed.py first")

    print("[segment] loading embeddings…")
    emb = np.load(EMB_PATH)  # (N_msgs, 384)
    ids = np.load(IDS_PATH)  # (N_msgs,)
    id_to_idx = {int(i): k for k, i in enumerate(ids)}

    print("[segment] reading messages…")
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cur = conn.execute(
        """
        SELECT id, ts, is_from_me, text
        FROM messages
        WHERE (associated_message_type IS NULL OR associated_message_type < 2000)
          AND text IS NOT NULL AND length(trim(text)) > 0
        ORDER BY ts ASC, id ASC
        """
    )
    rows: list[dict] = [
        {"id": r["id"], "ts": r["ts"], "is_from_me": r["is_from_me"], "text": r["text"]}
        for r in cur
    ]
    print(f"[segment] {len(rows):,} text messages")

    # Map row index → embedding row index
    emb_idx = np.asarray(
        [id_to_idx.get(int(r["id"]), -1) for r in rows], dtype=np.int64
    )
    missing = int((emb_idx < 0).sum())
    if missing:
        print(f"[segment] WARNING: {missing} messages missing embeddings — dropping them")
        keep = emb_idx >= 0
        rows = [rows[i] for i in range(len(rows)) if keep[i]]
        emb_idx = emb_idx[keep]
    sub_emb = emb[emb_idx]  # (n, 384)

    print(f"[segment] running temporal splits (min={TEMPORAL_MIN_HOURS}h, k={TEMPORAL_K})…")
    temporal = temporal_segments(rows)
    print(f"[segment] {len(temporal):,} temporal segments")

    print(f"[segment] semantic refinement (W={W})…")
    refined: list[list[int]] = []
    for seg in temporal:
        if len(seg) < MIN_SEM_SPLIT:
            refined.append(seg)
            continue
        # operate on the local indices into rows
        sub_e = sub_emb  # already global; pass slice via indices
        # build a local emb for this seg
        local_emb = sub_e[seg]
        sub_segs = semantic_refine_local(local_emb, W)
        for ss in sub_segs:
            refined.append([seg[k] for k in ss])
    print(f"[segment] {len(refined):,} segments after refinement")

    # Persist
    seg_rows: list[tuple] = []
    msg_rows: list[tuple] = []
    for sid, seg in enumerate(refined, start=1):
        n = len(seg)
        if n == 0:
            continue
        ts0 = rows[seg[0]]["ts"]
        ts1 = rows[seg[-1]]["ts"]
        n_me = sum(1 for k in seg if rows[k]["is_from_me"])
        n_them = n - n_me
        seg_rows.append((sid, rows[seg[0]]["id"], rows[seg[-1]]["id"], ts0, ts1, n, n_me, n_them))
        for k in seg:
            msg_rows.append((rows[k]["id"], sid))

    print(f"[segment] writing {len(seg_rows):,} segments / {len(msg_rows):,} msg-mappings")
    write_conn = sqlite3.connect(DB)
    write_conn.execute("PRAGMA journal_mode=WAL")
    write_conn.execute("PRAGMA query_only=OFF")
    write_conn.executescript(
        """
        DROP TABLE IF EXISTS seg_msg_segment;
        DROP TABLE IF EXISTS seg_segments;
        CREATE TABLE seg_segments (
          id INTEGER PRIMARY KEY,
          start_msg_id INTEGER NOT NULL,
          end_msg_id   INTEGER NOT NULL,
          start_ts     INTEGER NOT NULL,
          end_ts       INTEGER NOT NULL,
          n_msgs       INTEGER NOT NULL,
          n_me         INTEGER NOT NULL,
          n_them       INTEGER NOT NULL,
          topic_id     INTEGER,
          umap_x       REAL,
          umap_y       REAL
        );
        CREATE INDEX seg_segments_topic_idx ON seg_segments(topic_id);
        CREATE INDEX seg_segments_ts_idx    ON seg_segments(start_ts);
        CREATE TABLE seg_msg_segment (
          msg_id     INTEGER PRIMARY KEY,
          segment_id INTEGER NOT NULL
        );
        CREATE INDEX seg_msg_segment_seg_idx ON seg_msg_segment(segment_id);
        """
    )
    write_conn.executemany(
        "INSERT INTO seg_segments (id, start_msg_id, end_msg_id, start_ts, end_ts, n_msgs, n_me, n_them) VALUES (?,?,?,?,?,?,?,?)",
        seg_rows,
    )
    write_conn.executemany(
        "INSERT INTO seg_msg_segment (msg_id, segment_id) VALUES (?, ?)", msg_rows
    )
    write_conn.commit()
    write_conn.close()
    conn.close()

    lengths = [r[5] for r in seg_rows]
    print(
        f"[segment] segments: {len(seg_rows):,}  "
        f"len mean={np.mean(lengths):.1f} median={np.median(lengths):.0f} "
        f"min={np.min(lengths)} max={np.max(lengths)}"
    )


def semantic_refine_local(local_emb: np.ndarray, w: int) -> list[list[int]]:
    """Same TextTiling logic but works on a contiguous embedding chunk and returns
    local index lists."""
    n = local_emb.shape[0]
    if n < max(MIN_SEM_SPLIT, 4 * w):
        return [list(range(n))]

    cs = np.concatenate(
        [np.zeros((1, local_emb.shape[1]), dtype=local_emb.dtype), np.cumsum(local_emb, axis=0)],
        axis=0,
    )
    sims = np.full(n + 1, np.nan, dtype=np.float64)
    for i in range(w, n - w + 1):
        left = (cs[i] - cs[i - w]) / w
        right = (cs[i + w] - cs[i]) / w
        ln = np.linalg.norm(left) + 1e-9
        rn = np.linalg.norm(right) + 1e-9
        sims[i] = float(np.dot(left, right) / (ln * rn))

    depths = []
    for i in range(w + 1, n - w):
        if math.isnan(sims[i]):
            continue
        left_max = np.nanmax(sims[max(w, i - w) : i + 1])
        right_max = np.nanmax(sims[i : min(n - w + 1, i + w + 1)])
        depth = max(left_max, right_max) - sims[i]
        if depth > 0:
            depths.append((i, depth))
    if not depths:
        return [list(range(n))]
    dvals = np.asarray([d for _, d in depths])
    threshold = float(np.mean(dvals) + 0.5 * np.std(dvals))

    cuts: list[int] = []
    for i, d in sorted(depths, key=lambda x: -x[1]):
        if d < threshold:
            break
        if any(abs(i - c) < w for c in cuts):
            continue
        cuts.append(i)
    cuts.sort()

    if not cuts:
        return [list(range(n))]

    parts: list[list[int]] = []
    prev = 0
    for c in cuts:
        if c - prev < max(3, w // 2):
            continue
        parts.append(list(range(prev, c)))
        prev = c
    parts.append(list(range(prev, n)))
    parts = [p for p in parts if len(p) >= max(3, w // 2)]
    return parts or [list(range(n))]


if __name__ == "__main__":
    sys.exit(main())
