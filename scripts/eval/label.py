#!/usr/bin/env python3
"""Interactive ID-only labeling helper for local archive eval sets."""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EVAL_DIR = ROOT / "data" / "eval"
PRIVATE_DIR = EVAL_DIR / "private"
DEFAULT_DB = ROOT / "data" / "runtime" / "conversation.db"

SETS = {
    "turn_moves": {
        "path": EVAL_DIR / "turn_moves.jsonl",
        "id": "message_id",
        "labels": ["question", "repair", "care", "logistics", "invitation", "affection", "vulnerable", "play", "object", "status"],
    },
    "restart_openers": {
        "path": EVAL_DIR / "restart_openers.jsonl",
        "id": "message_id",
        "labels": ["question", "repair", "care", "logistics", "invitation", "affection", "vulnerable", "play", "object", "status"],
    },
    "strain_repair": {
        "path": EVAL_DIR / "strain_repair.jsonl",
        "id": "message_id",
        "labels": ["none", "care", "repair", "affection"],
    },
    "segment_categories": {
        "path": EVAL_DIR / "segment_categories.jsonl",
        "id": "segment_id",
        "labels": ["logistics", "planning", "small_talk", "romantic_intimacy", "sexual_intimacy", "conflict", "emotional_support", "humor", "work_school", "family", "daily_check_in", "photo_sharing", "memes_links", "food", "travel", "games", "tech", "health", "household", "finance", "unclassified"],
    },
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("set", choices=SETS.keys())
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--cache-text", action="store_true", help="append local-only text excerpts under data/eval/private")
    args = parser.parse_args()

    spec = SETS[args.set]
    out_path = Path(spec["path"])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    seen = labeled_ids(out_path, str(spec["id"]))
    candidate = pick_candidate(conn, args.set, seen)
    if candidate is None:
        print("[label] no unlabeled candidate found")
        return

    print(f"\n[{args.set}] {spec['id']}={candidate['id']}")
    print("-" * 72)
    print(candidate["text"] or "[no text]")
    print("-" * 72)
    for index, label in enumerate(spec["labels"], start=1):
        print(f"{index:>2}. {label}")
    raw = input("label number or name (blank to skip): ").strip()
    if not raw:
        print("[label] skipped")
        return
    label = resolve_label(raw, spec["labels"])
    notes = input("notes (optional): ").strip()
    row = build_row(args.set, candidate["id"], label, notes)
    with out_path.open("a") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")
    if args.cache_text:
        PRIVATE_DIR.mkdir(parents=True, exist_ok=True)
        with (PRIVATE_DIR / "text_excerpts.jsonl").open("a") as handle:
            handle.write(json.dumps({"set": args.set, **row, "text": candidate["text"]}, sort_keys=True) + "\n")
    print(f"[label] wrote {out_path}")


def labeled_ids(path: Path, id_key: str) -> set[int]:
    if not path.exists():
        return set()
    ids = set()
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if id_key in row:
            ids.add(int(row[id_key]))
    return ids


def pick_candidate(conn: sqlite3.Connection, set_name: str, seen: set[int]) -> dict[str, Any] | None:
    if set_name == "segment_categories":
        rows = conn.execute(
            """
            SELECT s.id,
                   GROUP_CONCAT(COALESCE(m.text, '[object]'), ' | ') AS text
            FROM seg_segments s
            JOIN seg_msg_segment sm ON sm.segment_id = s.id
            JOIN messages m ON m.id = sm.msg_id
            GROUP BY s.id
            ORDER BY s.id ASC
            """
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT id, COALESCE(text, '[object]') AS text
            FROM messages
            ORDER BY id ASC
            """
        ).fetchall()
    candidates = [{"id": int(row["id"]), "text": row["text"]} for row in rows if int(row["id"]) not in seen]
    return random.choice(candidates) if candidates else None


def resolve_label(raw: str, labels: list[str]) -> str:
    if raw.isdigit():
        index = int(raw) - 1
        if 0 <= index < len(labels):
            return labels[index]
    if raw in labels:
        return raw
    raise SystemExit(f"unknown label: {raw}")


def build_row(set_name: str, item_id: int, label: str, notes: str) -> dict[str, Any]:
    if set_name == "segment_categories":
        return {
            "segment_id": item_id,
            "gold_category": None if label == "unclassified" else label,
            "gold_status": "topic_outlier" if label == "unclassified" else "classified",
            "notes": notes,
        }
    if set_name == "strain_repair":
        has_strain = input("has strain? y/N: ").strip().lower().startswith("y")
        repair = label != "none"
        return {
            "message_id": item_id,
            "has_strain": has_strain,
            "repair_in_24h": repair,
            "gold_repair_kind": label,
        }
    if set_name == "restart_openers":
        warm = input("warm low-pressure? y/N: ").strip().lower().startswith("y")
        return {
            "message_id": item_id,
            "gold_kind": label,
            "gold_warm_low_pressure": warm,
        }
    return {"message_id": item_id, "gold_kind": label, "notes": notes}


if __name__ == "__main__":
    main()
