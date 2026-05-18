#!/usr/bin/env python3
"""Run the ID-only evaluation sets against the current classifiers.

Defaults to data/fixtures/tiny.db so CI never touches the private archive. To
run against the local archive, pass --db data/runtime/conversation.db after labeling real IDs.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import struct
import subprocess
import sys
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from _shared import tokenize

EVAL_DIR = ROOT / "data" / "eval"
DEFAULT_DB = ROOT / "data" / "fixtures" / "tiny.db"
REPORT_PATH = EVAL_DIR / "report.json"
CONFUSION_PATH = EVAL_DIR / "confusion-matrix.png"

STRAIN_WORDS = {"sad", "anxious", "anxiety", "worried", "hurt", "crying", "upset", "stressed", "hard", "tired", "overwhelmed", "frustrated"}
CARE_WORDS = {"rest", "eat", "safe", "okay", "ok", "food"}
AFFECTION_WORDS = {"love", "miss", "cuddle", "kiss", "sweetheart", "darling"}
PLAY_WORDS = {"lol", "lmao", "haha", "hehe", "funny", "silly"}
LOGISTICS_WORDS = {"dinner", "tonight", "tomorrow", "plan", "plans", "schedule", "calendar"}
REPAIR_WORDS = {"sorry", "apologize", "apologise", "forgive", "misunderstood"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite DB to evaluate")
    parser.add_argument("--report", default=str(REPORT_PATH), help="JSON report output")
    parser.add_argument("--confusion", default=str(CONFUSION_PATH), help="PNG confusion matrix output")
    args = parser.parse_args()

    db_path = Path(args.db)
    if db_path == DEFAULT_DB and not db_path.exists():
        subprocess.run([sys.executable, str(ROOT / "scripts" / "eval" / "build-fixtures.py")], check=True)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    suites = [
        evaluate_segment_categories(conn),
        evaluate_turn_moves(conn),
        evaluate_strain_repair(conn),
        evaluate_restart_openers(conn),
    ]
    suites = [suite for suite in suites if suite["total"] > 0]
    overall = overall_summary(suites)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "db_path": display_path(db_path),
        "summary": f"{len(suites)} suites, {overall['total']} labels, macro F1 {overall['macro_f1']:.3f}",
        "overall": overall,
        "suites": suites,
    }

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    previous = read_report(report_path)
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    confusion_path = Path(args.confusion)
    confusion_path.parent.mkdir(parents=True, exist_ok=True)
    write_confusion_png(confusion_path, suites)
    print(f"[eval] {report['summary']}")
    if previous is not None:
        previous_f1 = float(previous.get("overall", {}).get("macro_f1", 0.0))
        delta = overall["macro_f1"] - previous_f1
        print(f"[eval] macro F1 delta vs prior {delta:+.3f}")
    print(f"[eval] wrote {display_path(report_path)}")
    print(f"[eval] wrote {display_path(confusion_path)}")


def evaluate_segment_categories(conn: sqlite3.Connection) -> dict[str, Any]:
    gold = read_jsonl(EVAL_DIR / "segment_categories.jsonl")
    pairs: list[tuple[str, str]] = []
    for row in gold:
        segment_id = int(row["segment_id"])
        actual = conn.execute(
            """
            SELECT category, category_status
            FROM seg_segment_categories
            WHERE segment_id = ?
            """,
            (segment_id,),
        ).fetchone()
        if actual is None:
            continue
        gold_label = category_label(row.get("gold_category"), row.get("gold_status"))
        predicted = category_label(actual["category"], actual["category_status"])
        pairs.append((gold_label, predicted))
    return suite_summary("segment_categories", pairs)


def evaluate_turn_moves(conn: sqlite3.Connection) -> dict[str, Any]:
    gold = read_jsonl(EVAL_DIR / "turn_moves.jsonl")
    pairs: list[tuple[str, str]] = []
    for row in gold:
        message = get_message(conn, int(row["message_id"]))
        if message is None:
            continue
        pairs.append((str(row["gold_kind"]), classify_move(message)))
    return suite_summary("turn_moves", pairs)


def evaluate_strain_repair(conn: sqlite3.Connection) -> dict[str, Any]:
    gold = read_jsonl(EVAL_DIR / "strain_repair.jsonl")
    pairs: list[tuple[str, str]] = []
    for row in gold:
        message = get_message(conn, int(row["message_id"]))
        if message is None:
            continue
        pairs.append((bool_label(bool(row["has_strain"])), bool_label(has_strain(message["text"] or ""))))
        repair = repair_after(conn, message)
        pairs.append((bool_label(bool(row["repair_in_24h"])), bool_label(repair["repair_in_24h"])))
        pairs.append((str(row["gold_repair_kind"]), repair["kind"]))
    return suite_summary("strain_repair", pairs)


def evaluate_restart_openers(conn: sqlite3.Connection) -> dict[str, Any]:
    gold = read_jsonl(EVAL_DIR / "restart_openers.jsonl")
    pairs: list[tuple[str, str]] = []
    for row in gold:
        message = get_message(conn, int(row["message_id"]))
        if message is None:
            continue
        kind = classify_move(message)
        pairs.append((str(row["gold_kind"]), kind))
        pairs.append((bool_label(bool(row["gold_warm_low_pressure"])), bool_label(kind in {"affection", "care", "play"})))
    return suite_summary("restart_openers", pairs)


def suite_summary(name: str, pairs: list[tuple[str, str]]) -> dict[str, Any]:
    labels = sorted({label for pair in pairs for label in pair})
    per_label = []
    for label in labels:
        tp = sum(1 for gold, pred in pairs if gold == label and pred == label)
        fp = sum(1 for gold, pred in pairs if gold != label and pred == label)
        fn = sum(1 for gold, pred in pairs if gold == label and pred != label)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_label.append(
            {
                "label": label,
                "tp": tp,
                "fp": fp,
                "fn": fn,
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "f1": round(f1, 4),
            }
        )
    total = len(pairs)
    correct = sum(1 for gold, pred in pairs if gold == pred)
    macro_f1 = sum(row["f1"] for row in per_label) / len(per_label) if per_label else 0.0
    confusion = [
        {"gold": gold, "predicted": pred, "n": n}
        for (gold, pred), n in sorted(Counter(pairs).items())
    ]
    return {
        "name": name,
        "total": total,
        "accuracy": round(correct / total, 4) if total else 0.0,
        "macro_f1": round(macro_f1, 4),
        "labels": per_label,
        "confusion": confusion,
    }


def overall_summary(suites: list[dict[str, Any]]) -> dict[str, Any]:
    total = sum(int(suite["total"]) for suite in suites)
    if total == 0:
        return {"total": 0, "accuracy": 0.0, "macro_f1": 0.0}
    accuracy = sum(float(suite["accuracy"]) * int(suite["total"]) for suite in suites) / total
    macro_f1 = sum(float(suite["macro_f1"]) for suite in suites) / len(suites)
    return {"total": total, "accuracy": round(accuracy, 4), "macro_f1": round(macro_f1, 4)}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def get_message(conn: sqlite3.Connection, message_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, ts, is_from_me, text, has_attachment FROM messages WHERE id = ?",
        (message_id,),
    ).fetchone()


def classify_move(message: sqlite3.Row) -> str:
    text = (message["text"] or "").lower()
    tokens = set(tokenize(text))
    if not text and int(message["has_attachment"] or 0):
        return "object"
    if tokens & CARE_WORDS or "are you okay" in text or "feel better" in text:
        return "care"
    if "?" in text:
        return "question"
    if tokens & AFFECTION_WORDS:
        return "affection"
    if tokens & PLAY_WORDS:
        return "play"
    if tokens & STRAIN_WORDS:
        return "vulnerable"
    if tokens & REPAIR_WORDS:
        return "repair"
    if tokens & LOGISTICS_WORDS:
        return "logistics"
    return "status"


def has_strain(text: str) -> bool:
    return bool(set(tokenize(text.lower())) & STRAIN_WORDS)


def repair_after(conn: sqlite3.Connection, message: sqlite3.Row) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT id, ts, is_from_me, text, has_attachment
        FROM messages
        WHERE ts > ? AND ts <= ? AND is_from_me != ?
        ORDER BY ts ASC
        """,
        (int(message["ts"]), int(message["ts"]) + 24 * 60 * 60, int(message["is_from_me"])),
    ).fetchall()
    for row in rows:
        kind = classify_move(row)
        if kind in {"care", "repair", "affection"}:
            return {"repair_in_24h": True, "kind": kind}
    return {"repair_in_24h": False, "kind": "none"}


def category_label(category: Any, status: Any) -> str:
    if category:
        return str(category)
    return str(status or "unclassified")


def bool_label(value: bool) -> str:
    return "yes" if value else "no"


def display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def read_report(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_confusion_png(path: Path, suites: list[dict[str, Any]]) -> None:
    counts: Counter[tuple[str, str]] = Counter()
    labels: set[str] = set()
    for suite in suites:
        for row in suite["confusion"]:
            gold = str(row["gold"])
            pred = str(row["predicted"])
            labels.add(gold)
            labels.add(pred)
            counts[(gold, pred)] += int(row["n"])
    ordered = sorted(labels)[:18]
    if not ordered:
        ordered = ["none"]
    cell = 18
    pad = 8
    width = pad * 2 + cell * len(ordered)
    height = width
    max_count = max(counts.values() or [1])
    pixels = bytearray()
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            cx = (x - pad) // cell
            cy = (y - pad) // cell
            if x < pad or y < pad or cx < 0 or cy < 0 or cx >= len(ordered) or cy >= len(ordered):
                row.extend((247, 244, 238))
                continue
            n = counts[(ordered[cy], ordered[cx])]
            strength = int(220 * (n / max_count))
            if cx == cy:
                row.extend((60, max(95, 180 - strength // 3), 120))
            elif n:
                row.extend((190 + strength // 5, 130, max(60, 170 - strength // 2)))
            else:
                row.extend((232, 226, 216))
        pixels.extend(row)

    def chunk(name: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(pixels), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


if __name__ == "__main__":
    main()
