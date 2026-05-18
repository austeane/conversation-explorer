"""
Build an English-baseline frequency reference for vocabulary lift analysis.

Pulls every distinct token from `data/runtime/conversation.db` using the SAME tokenizer the TS
code uses (curly-apostrophe → straight, drop non-[a-z' ], trim edge apostrophes,
length 3..20, drop WORD_STOP), then looks each token up in the wordfreq library
(an aggregate baseline over Wikipedia + OpenSubtitles + SUBTLEX + Reddit + Twitter
+ News + Common Crawl). Output is a per-word zipf score (log10 per-billion;
0 = unknown).

Usage: .venv-baseline/bin/python3 scripts/build-baseline.py

Output: data/baseline-frequencies.json
{
  "_meta": { "source": "wordfreq 'large' English",
             "generated_at": "...",
             "vocab_size": N,
             "covered": K,        # zipf > 0
             "coverage_pct": ... },
  "<word>": <zipf>,
  ...
}
"""

import json
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from wordfreq import zipf_frequency
except ImportError:
    sys.stderr.write(
        "wordfreq not installed. Install with:\n"
        "  .venv-baseline/bin/pip install wordfreq\n"
    )
    sys.exit(1)

PROJECT = Path(__file__).resolve().parent.parent
DB = PROJECT / "data" / "runtime" / "conversation.db"
OUT = PROJECT / "data" / "baseline-frequencies.json"

# --- WORD_STOP — must mirror src/server/queries.ts exactly. ---
# Verified against queries.ts on 2026-05-06.
WORD_STOP = {
    "the", "a", "an", "and", "or", "but", "if", "so", "of", "in", "on", "at", "to", "for", "with", "by",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "i", "you", "we", "they", "he", "she", "it", "me", "my", "your", "our", "their", "his", "her", "its",
    "this", "that", "these", "those", "as", "not", "no", "yes", "ok", "okay", "oh", "um", "uh", "like", "just",
    "really", "very", "up", "down", "out", "off", "over", "there", "here", "then", "than", "when", "where", "what", "which", "who",
    "from", "into", "about", "also", "too", "can", "will", "would", "could", "should",
    "u", "ur", "ya", "yeah", "yep", "yup", "ima", "gotta", "ah", "mm", "mhm", "mmm", "hm", "hmm", "huh",
    "lol", "lmao", "haha", "hehe", "nah", "yo", "hi", "hey", "hello", "well", "got", "get", "gets", "getting", "gotten",
    "go", "goes", "going", "went", "gone", "good", "bad", "sure", "right", "fine", "one", "two", "three",
    "im", "i'm", "ive", "i've", "ill", "i'll", "id", "i'd",
    "dont", "don't", "doesnt", "doesn't", "didnt", "didn't", "cant", "can't", "wont", "won't", "aint", "ain't",
    "thats", "that's", "theres", "there's", "whats", "what's", "heres", "here's", "its", "it's",
    "youre", "you're", "youve", "you've", "youll", "you'll", "youd", "you'd",
    "shes", "she's", "hes", "he's", "theyre", "they're", "weve", "we've", "were", "we're",
    "gonna", "wanna", "kinda", "sorta", "didn", "doesn", "wasn", "wasn't", "isn", "isn't",
    "wouldn", "wouldn't", "couldn", "couldn't", "shouldn", "shouldn't", "haven", "haven't", "hadn", "hadn't", "hasn", "hasn't",
}

# Curly / modifier-letter apostrophe variants → straight ASCII apostrophe.
# Mirrors the JS `[‘’‛ʼ]` regex in queries.ts. Also includes RIGHT SINGLE QUOTATION MARK U+2019.
APOSTROPHE_VARIANTS = "‘’‛ʼ"
APOSTROPHE_TRANSLATE = str.maketrans({c: "'" for c in APOSTROPHE_VARIANTS})

NON_WORD_RE = re.compile(r"[^a-z' ]+")
EDGE_APOS_RE = re.compile(r"^'+|'+$")


def tokenize(body: str):
    body = body.lower().translate(APOSTROPHE_TRANSLATE)
    body = NON_WORD_RE.sub(" ", body)
    out = []
    for raw in body.split():
        w = EDGE_APOS_RE.sub("", raw)
        if 3 <= len(w) <= 20 and w not in WORD_STOP:
            out.append(w)
    return out


def open_db_with_retry(path: Path, attempts: int = 8, delay: float = 0.5):
    """SQLite may be briefly locked by sibling agents. Retry with backoff."""
    last = None
    for i in range(attempts):
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10.0)
            # WAL is fine for read-only; this just sets the busy timeout in ms.
            con.execute("PRAGMA busy_timeout = 5000")
            return con
        except sqlite3.OperationalError as e:
            last = e
            time.sleep(delay * (i + 1))
    raise RuntimeError(f"could not open {path} after {attempts} attempts: {last}")


def main():
    if not DB.exists():
        sys.stderr.write(f"missing {DB}; run `pnpm extract` first\n")
        sys.exit(1)

    print(f"[baseline] reading {DB}")
    con = open_db_with_retry(DB)
    try:
        rows = con.execute(
            "SELECT text FROM messages WHERE text IS NOT NULL AND text != ''"
        )
        vocab = set()
        n_msgs = 0
        for (text,) in rows:
            n_msgs += 1
            for w in tokenize(text):
                vocab.add(w)
            if n_msgs % 50_000 == 0:
                print(f"[baseline]   tokenized {n_msgs} messages, vocab so far: {len(vocab):,}")
    finally:
        con.close()

    print(f"[baseline] tokenized {n_msgs:,} messages → {len(vocab):,} unique types")

    # Look each up. wordfreq uses the 'large' English list by default (8.4M+ tokens).
    print("[baseline] looking up zipf scores via wordfreq…")
    t0 = time.time()
    out = {}
    covered = 0
    for w in vocab:
        z = zipf_frequency(w, "en", wordlist="large")
        out[w] = z
        if z > 0.0:
            covered += 1
    elapsed = time.time() - t0
    print(f"[baseline]   done in {elapsed:.2f}s — {covered:,}/{len(vocab):,} covered ({100 * covered / max(1, len(vocab)):.1f}%)")

    # Sample peek (informative for the run log).
    samples = ["lololol", "goodnight", "snitch", "the", "haha", "hahaha", "them", "me"]
    print("[baseline] samples:")
    for s in samples:
        if s in out:
            print(f"  {s:<14} zipf = {out[s]:.2f}")

    payload = {
        "_meta": {
            "source": "wordfreq 'large' English (Wikipedia + OpenSubtitles + SUBTLEX + Reddit + Twitter + News + Common Crawl)",
            "wordfreq_version": _wordfreq_version(),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "vocab_size": len(vocab),
            "covered": covered,
            "coverage_pct": round(100 * covered / max(1, len(vocab)), 2),
            "messages_scanned": n_msgs,
            "note": "zipf=0 means not present in baseline. Treat as ~very rare (~zipf 1.0) at lookup time.",
        },
        "frequencies": out,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        # No indent: this file is loaded once into memory; flat is faster.
        json.dump(payload, f, separators=(",", ":"))

    size_kb = OUT.stat().st_size / 1024
    print(f"[baseline] wrote {OUT} ({size_kb:.1f} KB)")
    print(f"[baseline] meta: {payload['_meta']}")


def _wordfreq_version():
    try:
        from importlib.metadata import version
        return version("wordfreq")
    except Exception:
        return "unknown"


if __name__ == "__main__":
    main()
