"""
Stage 3 — Disentangle concurrent threads inside a long segment.

For every segment with >= MIN_DISENTANGLE_MSGS messages:
    Build a graph where nodes = messages and edges =
        weight(i,j) = exp(-|t_i - t_j| / TAU) * cos_sim(emb_i, emb_j) + reply_bonus
    Drop edges below WEIGHT_FLOOR; only consider pairs within WINDOW msgs of each other.

Then run Louvain community detection. Each community = a sub-thread.

Outputs:
    seg_threads(id PK, segment_id, community_idx, msg_ids JSON)
"""
import json
import os
import sqlite3
import sys
from pathlib import Path

import community as community_louvain  # python-louvain
import networkx as nx
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
EMB_PATH = ROOT / "data" / "embeddings_msg.npy"
IDS_PATH = ROOT / "data" / "embeddings_msg_ids.npy"

MIN_DISENTANGLE = int(os.environ.get("MESSAGE_DISENTANGLE_MIN", "30"))
TAU = float(os.environ.get("MESSAGE_TAU_SEC", "300"))  # 5 minutes
REPLY_BONUS = 0.5
WEIGHT_FLOOR = 0.3
WINDOW = 25  # only build edges between msgs within this many ordered positions


def main() -> None:
    print("[disentangle] loading embeddings…")
    emb = np.load(EMB_PATH)
    ids = np.load(IDS_PATH)
    id_to_idx = {int(i): k for k, i in enumerate(ids)}

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    # GUID → id map for resolving reply_to_guid
    guid_map: dict[str, int] = {}
    for r in conn.execute("SELECT id, guid FROM messages WHERE guid IS NOT NULL"):
        guid_map[r["guid"]] = r["id"]

    seg_rows = list(
        conn.execute(
            "SELECT id, n_msgs FROM seg_segments WHERE n_msgs >= ? ORDER BY id",
            (MIN_DISENTANGLE,),
        )
    )
    print(f"[disentangle] {len(seg_rows)} segments >= {MIN_DISENTANGLE} msgs to process")

    write_conn = sqlite3.connect(DB)
    write_conn.execute("PRAGMA journal_mode=WAL")
    write_conn.executescript(
        """
        DROP TABLE IF EXISTS seg_threads;
        CREATE TABLE seg_threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_id INTEGER NOT NULL,
            community_idx INTEGER NOT NULL,
            n_msgs INTEGER NOT NULL,
            msg_ids TEXT NOT NULL
        );
        CREATE INDEX seg_threads_seg_idx ON seg_threads(segment_id);
        """
    )

    total_threads = 0
    long_handled = 0

    for seg in seg_rows:
        seg_id = seg["id"]
        msgs = list(
            conn.execute(
                """
                SELECT m.id, m.ts, m.is_from_me, m.reply_to_guid
                FROM seg_msg_segment sm
                JOIN messages m ON m.id = sm.msg_id
                WHERE sm.segment_id = ?
                ORDER BY m.ts ASC, m.id ASC
                """,
                (seg_id,),
            )
        )
        n = len(msgs)
        if n < MIN_DISENTANGLE:
            continue

        # collect embeddings rows
        emb_rows: list[int] = []
        valid: list[int] = []
        for k, m in enumerate(msgs):
            mi = id_to_idx.get(int(m["id"]))
            if mi is None:
                continue
            emb_rows.append(mi)
            valid.append(k)
        if len(valid) < MIN_DISENTANGLE:
            continue
        sub_emb = emb[emb_rows]  # (m, 384), normalized

        # similarity within sliding window
        G = nx.Graph()
        for k_idx, k in enumerate(valid):
            G.add_node(k)

        # Build edges
        n_valid = len(valid)
        for ai in range(n_valid):
            ts_a = msgs[valid[ai]]["ts"]
            for bj in range(ai + 1, min(n_valid, ai + 1 + WINDOW)):
                ts_b = msgs[valid[bj]]["ts"]
                dt = abs(ts_b - ts_a)
                temporal = float(np.exp(-dt / TAU))
                if temporal < 1e-6:
                    continue
                sim = float(np.dot(sub_emb[ai], sub_emb[bj]))
                # cosine since normalized; clamp negative
                if sim < 0:
                    sim = 0.0
                w = temporal * sim
                # reply bonus
                a_msg = msgs[valid[ai]]
                b_msg = msgs[valid[bj]]
                if b_msg["reply_to_guid"]:
                    target = guid_map.get(b_msg["reply_to_guid"])
                    if target == a_msg["id"]:
                        w += REPLY_BONUS
                if w >= WEIGHT_FLOOR:
                    G.add_edge(valid[ai], valid[bj], weight=w)

        if G.number_of_edges() == 0:
            # fallback: one community
            comm = {valid[i]: 0 for i in range(n_valid)}
        else:
            comm = community_louvain.best_partition(G, weight="weight", random_state=42)

        # Group by community (collapse tiny comms < 3 msgs into "other")
        groups: dict[int, list[int]] = {}
        for k_local, cidx in comm.items():
            groups.setdefault(cidx, []).append(k_local)

        # Order communities by earliest message ts; collapse tiny ones
        sorted_groups = sorted(
            groups.items(), key=lambda kv: min(msgs[k]["ts"] for k in kv[1])
        )
        primary: list[list[int]] = []
        leftover: list[int] = []
        for _, members in sorted_groups:
            if len(members) >= 3:
                primary.append(sorted(members, key=lambda kk: msgs[kk]["ts"]))
            else:
                leftover.extend(members)
        if leftover:
            primary.append(sorted(leftover, key=lambda kk: msgs[kk]["ts"]))

        for c_idx, members in enumerate(primary):
            ids_json = json.dumps([msgs[k]["id"] for k in members])
            write_conn.execute(
                "INSERT INTO seg_threads (segment_id, community_idx, n_msgs, msg_ids) VALUES (?,?,?,?)",
                (seg_id, c_idx, len(members), ids_json),
            )
            total_threads += 1

        long_handled += 1
        if long_handled % 200 == 0:
            print(f"[disentangle]   processed {long_handled}/{len(seg_rows)}  threads_so_far={total_threads}")
            write_conn.commit()

    write_conn.commit()
    write_conn.close()
    conn.close()
    print(f"[disentangle] done. {total_threads} threads across {long_handled} long segments.")


if __name__ == "__main__":
    sys.exit(main())
