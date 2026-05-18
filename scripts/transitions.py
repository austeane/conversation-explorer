"""
Stage 6 — Transition graph.

For consecutive segments (within an active period of < ACTIVE_GAP_HOURS):
  insert (from, to, gap_seconds) into seg_links
  aggregate (from_cat, to_cat, n, mean_gap) into seg_category_transitions
  materialize contiguous conversation seasons into seg_seasons
"""
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
ACTIVE_GAP_HOURS = float(os.environ.get("MESSAGE_ACTIVE_GAP_HOURS", "72"))
TARGET_SEASONS = int(os.environ.get("MESSAGE_TARGET_SEASONS", "6"))
MIN_MONTHS_PER_SEASON = int(os.environ.get("MESSAGE_MIN_MONTHS_PER_SEASON", "4"))
MIN_SEGMENTS_PER_MONTH = int(os.environ.get("MESSAGE_MIN_SEGMENTS_PER_MONTH", "8"))
VANCOUVER = ZoneInfo("America/Vancouver")
SEASON_METHOD = "monthly-mixture-dp-v1"


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        DROP TABLE IF EXISTS seg_links;
        DROP TABLE IF EXISTS seg_category_transitions;
        CREATE TABLE seg_links (
            from_segment_id INTEGER NOT NULL,
            to_segment_id   INTEGER NOT NULL,
            gap_seconds     INTEGER NOT NULL,
            from_category   TEXT,
            to_category     TEXT,
            PRIMARY KEY (from_segment_id, to_segment_id)
        );
        CREATE INDEX seg_links_from_idx ON seg_links(from_segment_id);
        CREATE TABLE seg_category_transitions (
            from_cat TEXT NOT NULL,
            to_cat   TEXT NOT NULL,
            n        INTEGER NOT NULL,
            mean_gap_seconds REAL NOT NULL,
            PRIMARY KEY (from_cat, to_cat)
        );
        """
    )

    rows = list(
        conn.execute(
            """
            SELECT s.id, s.start_ts, s.end_ts,
                   COALESCE(c.category, 'unclassified') AS category
            FROM seg_segments s
            LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
            ORDER BY s.start_ts ASC, s.id ASC
            """
        )
    )
    print(f"[transitions] {len(rows)} segments")

    cutoff = ACTIVE_GAP_HOURS * 3600.0
    pair_rows: list[tuple] = []
    for i in range(1, len(rows)):
        prev = rows[i - 1]
        cur = rows[i]
        gap = cur["start_ts"] - prev["end_ts"]
        if gap > cutoff or gap < 0:
            continue
        pair_rows.append(
            (prev["id"], cur["id"], int(gap), prev["category"], cur["category"])
        )
    conn.executemany(
        "INSERT INTO seg_links (from_segment_id, to_segment_id, gap_seconds, from_category, to_category) VALUES (?,?,?,?,?)",
        pair_rows,
    )
    print(f"[transitions] {len(pair_rows)} edges < {ACTIVE_GAP_HOURS}h")

    # aggregate
    conn.execute(
        """
        INSERT INTO seg_category_transitions (from_cat, to_cat, n, mean_gap_seconds)
        SELECT from_category, to_category, COUNT(*), AVG(gap_seconds)
        FROM seg_links
        GROUP BY from_category, to_category
        """
    )
    conn.commit()

    print("[transitions] top 20 category transitions:")
    for r in conn.execute(
        "SELECT from_cat, to_cat, n FROM seg_category_transitions ORDER BY n DESC LIMIT 20"
    ):
        print(f"   {r[0]:<20} -> {r[1]:<20} {r[2]:,}")

    materialize_seasons(conn)
    conn.close()


def materialize_seasons(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT s.start_ts,
               COALESCE(c.category, 'unclassified') AS category
        FROM seg_segments s
        LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
        ORDER BY s.start_ts ASC, s.id ASC
        """
    ).fetchall()

    month_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in rows:
        month_counts[ym_vancouver(row["start_ts"])][row["category"]] += 1

    categories = sorted({category for counts in month_counts.values() for category in counts})
    signal_categories = [category for category in categories if category not in {"small_talk", "unclassified"}]
    months = []
    for ym in sorted(month_counts):
        total = sum(month_counts[ym].values())
        if total < MIN_SEGMENTS_PER_MONTH:
            continue
        vector = [
            month_counts[ym].get(category, 0) / total
            for category in signal_categories
        ]
        months.append({"ym": ym, "total": total, "vector": vector})

    k = min(TARGET_SEASONS, len(months) // MIN_MONTHS_PER_SEASON) if months else 0
    ranges = optimal_ranges(months, max(1, k), MIN_MONTHS_PER_SEASON) if months else []
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    conn.executescript(
        """
        DROP TABLE IF EXISTS seg_seasons;
        CREATE TABLE seg_seasons (
            id INTEGER PRIMARY KEY,
            label TEXT NOT NULL,
            start_ym TEXT NOT NULL,
            end_ym TEXT NOT NULL,
            method TEXT NOT NULL,
            generated_at TEXT NOT NULL
        );
        CREATE INDEX seg_seasons_range_idx ON seg_seasons(start_ym, end_ym);
        """
    )

    season_rows = []
    for index, season_range in enumerate(ranges):
        start_ym = months[season_range["start"]]["ym"]
        end_ym = months[season_range["end"]]["ym"]
        label = f"Season {index + 1}: {start_ym} to {end_ym}"
        season_rows.append((index, label, start_ym, end_ym, SEASON_METHOD, generated_at))

    conn.executemany(
        """
        INSERT INTO seg_seasons (id, label, start_ym, end_ym, method, generated_at)
        VALUES (?,?,?,?,?,?)
        """,
        season_rows,
    )
    conn.commit()
    print(f"[transitions] materialized {len(season_rows)} seasons with {SEASON_METHOD}")


def ym_vancouver(epoch_seconds: int | float) -> str:
    return datetime.fromtimestamp(epoch_seconds, VANCOUVER).strftime("%Y-%m")


def optimal_ranges(months: list[dict], k: int, min_length: int) -> list[dict[str, int]]:
    n = len(months)
    if k <= 1 or n < k * min_length:
        return [{"start": 0, "end": n - 1}] if n else []

    cost = build_cost_matrix(months)
    dp = [[float("inf") for _ in range(n)] for _ in range(k + 1)]
    prev = [[-1 for _ in range(n)] for _ in range(k + 1)]

    for end in range(min_length - 1, n):
        dp[1][end] = cost[0][end]

    for group in range(2, k + 1):
        for end in range(group * min_length - 1, n):
            for split in range((group - 1) * min_length - 1, end - min_length + 1):
                candidate = dp[group - 1][split] + cost[split + 1][end]
                if candidate < dp[group][end]:
                    dp[group][end] = candidate
                    prev[group][end] = split

    ranges: list[dict[str, int]] = []
    end = n - 1
    for group in range(k, 0, -1):
        split = prev[group][end]
        ranges.insert(0, {"start": split + 1, "end": end})
        end = split
    return ranges


def build_cost_matrix(months: list[dict]) -> list[list[float]]:
    n = len(months)
    cost = [[0.0 for _ in range(n)] for _ in range(n)]
    for start in range(n):
        width = len(months[start]["vector"])
        means = [0.0 for _ in range(width)]
        for end in range(start, n):
            for c in range(width):
                means[c] += months[end]["vector"][c]
            length = end - start + 1
            segment_cost = 0.0
            for i in range(start, end + 1):
                for c in range(width):
                    diff = months[i]["vector"][c] - means[c] / length
                    segment_cost += diff * diff
            cost[start][end] = segment_cost
    return cost


if __name__ == "__main__":
    sys.exit(main())
