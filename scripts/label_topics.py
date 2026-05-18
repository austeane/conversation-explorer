"""
Stage 5 — Broad-category labelling for each topic.

Approach (LLM preferred, NLI fallback):
  * If ANTHROPIC_API_KEY is set -> call claude-haiku-4-5 with a tight prompt.
  * Else -> zero-shot via facebook/bart-large-mnli (HuggingFace).

Reads data/topic_reps.json (representative segments per topic).
Writes seg_topic_categories(topic_id PK, category, confidence, method)
       and an initial seg_segment_categories table with explicit category
       status fields.

Run scripts/refine_categories.py after this step. The refinement stage scores
the actual messages inside each segment, splits intimacy into
romantic_intimacy and sexual_intimacy, and derives final topic labels from the
segment-level majority. Runtime pages should rely on the refined tables.
"""
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
TOPIC_REPS = ROOT / "data" / "topic_reps.json"

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
]

CATEGORY_HYPOTHESES = {
    "logistics": "Errands, scheduling, drop-offs, picking up items, paying bills.",
    "planning": "Choosing what to do later, making plans for an event or activity.",
    "small_talk": "Casual chatter about nothing in particular, idle banter.",
    "romantic_intimacy": "Romantic affection, cuddling, missing each other, declarations of love.",
    "sexual_intimacy": "Sexting, erotic desire, explicit sexual talk, kink, arousal, or sexual photos.",
    "conflict": "An argument, frustration, disagreement, or tension between the two people.",
    "emotional_support": "One person is upset and the other is comforting them.",
    "humor": "Jokes, teasing, memes, silly nonsense, making each other laugh.",
    "work_school": "Office work, classes, meetings, deadlines, projects, professors, bosses.",
    "family": "Mothers, fathers, siblings, in-laws, cousins, family events.",
    "daily_check_in": "Good morning, good night, what are you up to, how was your day.",
    "photo_sharing": "Sending pictures, reacting to photos, asking about images.",
    "memes_links": "Sharing internet videos, articles, TikToks, viral links.",
    "food": "Cooking, eating, meals, restaurants, recipes, hunger, dinner ideas.",
    "travel": "Flights, road trips, hotels, vacations, being away from home, travel plans.",
}


def via_anthropic(reps: dict) -> dict:
    import anthropic
    client = anthropic.Anthropic()
    out = {}
    cat_list = ", ".join(CATEGORIES)
    for tid, info in reps.items():
        sample_text = "\n---\n".join(s["text"] for s in info["samples"])[:3000]
        prompt = (
            "Pick the single best category for this excerpt of an SMS conversation. "
            f"Categories: {cat_list}. "
            "Respond with only the category name, nothing else.\n\nExcerpt:\n" + sample_text
        )
        msg = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=20,
            messages=[{"role": "user", "content": prompt}],
        )
        cat = msg.content[0].text.strip().lower()
        if cat not in CATEGORIES:
            cat = "small_talk"
        out[tid] = (cat, 0.9)
    return out


def via_nli(reps: dict) -> dict:
    """Use facebook/bart-large-mnli zero-shot — runs locally.

    Picks the highest-scoring category but applies a soft prior that down-weights
    categories already overpopulated, so the zero-shot model doesn't collapse onto
    one or two attractor labels. We score *topic keywords* + truncated sample text
    rather than the full sample (the keywords are far more discriminative because
    they're already been TF-IDF'd by BERTopic).
    """
    from transformers import pipeline
    import torch
    device = 0 if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else -1)
    print(f"[label] zero-shot NLI device={device}")
    clf = pipeline(
        "zero-shot-classification",
        model="facebook/bart-large-mnli",
        device=device,
    )
    hyp_template = "{}"  # full hypothesis sentences
    out = {}
    cats = list(CATEGORIES)
    hyps = [CATEGORY_HYPOTHESES[c] for c in cats]

    # First pass: score everything, then apply prior shifts iteratively.
    raw_scores: dict[str, dict[str, float]] = {}
    items = list(reps.items())
    for k, (tid, info) in enumerate(items):
        kws = info.get("top_words") or []
        kw_text = ", ".join(kws[:12])
        sample_text = "\n".join(s["text"] for s in info["samples"][:3])[:1200]
        text = f"Keywords: {kw_text}\nExcerpt: {sample_text}"
        if not text.strip():
            raw_scores[tid] = {c: 0.0 for c in cats}
            continue
        try:
            r = clf(text, candidate_labels=hyps, hypothesis_template=hyp_template, multi_label=True)
            sc = {cats[hyps.index(lbl)]: float(s) for lbl, s in zip(r["labels"], r["scores"])}
        except Exception as exc:
            print(f"[label]   topic {tid} fallback: {exc}")
            sc = {c: 0.0 for c in cats}
            sc["small_talk"] = 1.0
        raw_scores[tid] = sc
        if (k + 1) % 10 == 0 or k == len(items) - 1:
            print(f"[label]   scored {k+1}/{len(items)}")

    # Soft greedy assignment: pick categories one topic at a time, in order of
    # decreasing best-score margin. Apply a soft cap penalty so each category
    # absorbs at most ~ceil(N / len(CATEGORIES) * 2.5) topics.
    n = len(items)
    soft_cap = max(3, int(n / len(cats) * 2.5))
    assigned: dict[str, str] = {}
    cat_count: dict[str, int] = {c: 0 for c in cats}

    # Order topics by margin (top - second) so the highest-confidence get assigned first.
    def margin(tid: str) -> float:
        sc = sorted(raw_scores[tid].values(), reverse=True)
        return (sc[0] - (sc[1] if len(sc) > 1 else 0))

    order = sorted(raw_scores.keys(), key=lambda t: -margin(t))
    for tid in order:
        scores = raw_scores[tid]
        # Apply per-category penalty proportional to how full it is
        adj = {
            c: scores.get(c, 0.0) - 0.2 * max(0, cat_count[c] - soft_cap)
            for c in cats
        }
        cat = max(adj, key=adj.get)
        assigned[tid] = cat
        cat_count[cat] += 1
        out[tid] = (cat, float(scores.get(cat, 0.0)))
    return out


def main() -> None:
    if not TOPIC_REPS.exists():
        raise SystemExit("run scripts/topic_model.py first")
    reps = json.loads(TOPIC_REPS.read_text())
    print(f"[label] {len(reps)} topics")

    use_llm = bool(os.environ.get("ANTHROPIC_API_KEY"))
    if use_llm:
        print("[label] using Anthropic claude-haiku-4-5")
        labels = via_anthropic(reps)
        method = "claude-haiku-4-5"
    else:
        print("[label] using local zero-shot facebook/bart-large-mnli")
        labels = via_nli(reps)
        method = "bart-mnli-zeroshot"

    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        DROP TABLE IF EXISTS seg_topic_categories;
        DROP TABLE IF EXISTS seg_segment_categories;
        CREATE TABLE seg_topic_categories (
            topic_id INTEGER PRIMARY KEY,
            category TEXT NOT NULL,
            confidence REAL NOT NULL,
            method TEXT NOT NULL
        );
        CREATE TABLE seg_segment_categories (
            segment_id INTEGER PRIMARY KEY,
            category TEXT,
            confidence REAL NOT NULL,
            category_status TEXT NOT NULL,
            category_reason TEXT NOT NULL,
            secondary_category TEXT,
            secondary_score REAL
        );
        CREATE INDEX seg_segment_categories_cat_idx ON seg_segment_categories(category);
        CREATE INDEX seg_segment_categories_status_idx ON seg_segment_categories(category_status);
        """
    )
    for tid, (cat, conf) in labels.items():
        conn.execute(
            "INSERT INTO seg_topic_categories (topic_id, category, confidence, method) VALUES (?,?,?,?)",
            (int(tid), cat, conf, method),
        )
        # Also update topic label field
        conn.execute("UPDATE seg_topics SET label=? WHERE id=?", (cat, int(tid)))
    conn.commit()

    # Propagate to segments. HDBSCAN outliers (topic_id NULL) are explicit
    # topic outliers, not fake small talk.
    conn.execute("""
        INSERT INTO seg_segment_categories (
            segment_id, category, confidence, category_status, category_reason, secondary_category, secondary_score
        )
        SELECT s.id,
               tc.category,
               COALESCE(tc.confidence, 0.0),
               CASE
                   WHEN s.topic_id IS NULL THEN 'topic_outlier'
                   WHEN tc.category IS NULL THEN 'low_signal'
                   ELSE 'classified'
               END,
               CASE
                   WHEN s.topic_id IS NULL THEN 'hdbscan_outlier'
                   WHEN tc.category IS NULL THEN 'fallback'
                   ELSE 'topic_majority'
               END,
               NULL,
               NULL
        FROM seg_segments s
        LEFT JOIN seg_topic_categories tc ON tc.topic_id = s.topic_id
    """)
    conn.commit()

    # Update topic_reps file with labels for posterity
    for tid, (cat, conf) in labels.items():
        if tid in reps:
            reps[tid]["label"] = cat
            reps[tid]["confidence"] = conf
    TOPIC_REPS.write_text(json.dumps(reps, indent=2))

    counts = list(conn.execute(
        """
        SELECT COALESCE(category, category_status) AS category, COUNT(*) AS n
        FROM seg_segment_categories
        GROUP BY COALESCE(category, category_status)
        ORDER BY n DESC
        """
    ))
    print("[label] segments per category:")
    for r in counts:
        print(f"   {r[0]:<20} {r[1]:,}")
    conn.close()


if __name__ == "__main__":
    sys.exit(main())
