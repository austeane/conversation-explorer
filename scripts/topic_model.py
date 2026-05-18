"""
Stage 4 — Topic modeling with BERTopic.

Inputs:
  data/embeddings_msg.npy / *_ids.npy
  seg_segments / seg_msg_segment    (in data/runtime/conversation.db)

Outputs (SQLite):
  seg_topics(id PK, n_segments, top_words, top_phrases, representative_segment_id, label)
  seg_segments.topic_id  (updated)
  seg_segments.umap_x / umap_y  (2D coords for the explorer)
  seg_topic_keywords(topic_id, word, score)  (longer-form keyword storage)

Also dumps reps to data/topic_reps.json so labelling can be done offline.
"""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
EMB_PATH = ROOT / "data" / "embeddings_msg.npy"
IDS_PATH = ROOT / "data" / "embeddings_msg_ids.npy"
TOPIC_REPS = ROOT / "data" / "topic_reps.json"
UMAP2_PATH = ROOT / "data" / "segment_umap2.npy"
SEG_EMB_PATH = ROOT / "data" / "segment_embeddings.npy"
SEG_IDS_PATH = ROOT / "data" / "segment_ids.npy"


def stopwords() -> list[str]:
    """Build a stopword list mirroring the WORD_STOP set in src/server/queries.ts
    plus generic English stopwords."""
    base = {
        "the","a","an","and","or","but","if","so","of","in","on","at","to","for","with","by",
        "is","are","was","were","be","been","being","have","has","had","do","does","did",
        "i","you","we","they","he","she","it","me","my","your","our","their","his","her","its",
        "this","that","these","those","as","not","no","yes","ok","okay","oh","um","uh","like","just",
        "really","very","up","down","out","off","over","there","here","then","than","when","where","what","which","who",
        "from","into","about","also","too","can","will","would","could","should",
        "u","ur","ya","yeah","yep","yup","ima","gotta","ah","mm","mhm","mmm","hm","hmm","huh",
        "lol","lmao","haha","hehe","nah","yo","hi","hey","hello","well","got","get","gets","getting","gotten",
        "go","goes","going","went","gone","good","bad","sure","right","fine","one","two","three",
        "im","ive","ill","id",
        "dont","doesnt","didnt","cant","wont","aint",
        "thats","theres","whats","heres",
        "youre","youve","youll","youd",
        "shes","hes","theyre","weve",
        "gonna","wanna","kinda","sorta","didn","doesn","wasn","isn",
        "wouldn","couldn","shouldn","haven","hadn","hasn",
        # additional fillers in iMessage chatter
        "thing","things","stuff","much","many","little","big","new","old","still","want","wanted",
        "know","think","thought","say","said","tell","told","make","made","ever","never","always",
        "now","today","tomorrow","yesterday","morning","tonight","night","day","week","weekend",
        "back","time","times","actually","probably","maybe","ya","ok","alright","alrighty","cool",
        "love","need","needed","feeling","feel","feels","felt","also","though","mean","means","meant",
        "way","ways","might","let","lets","seems","seem","seemed","look","looking","looked","looks",
        "doing","done","making","day","days","next","last",
        "people","someone","something","anything","everyone","everything","nothing",
        "lot","wow","oof","aw","aww","awe","yay","fr","tho","bc","cuz","bro","sis","dude",
        "amp","quot","apos",
    }
    # also include sklearn's english list
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS
    base.update(ENGLISH_STOP_WORDS)
    return sorted(base)


CUR_TEXT_RE = re.compile(r"[‘’‚ʼʻ']")


def clean_text(t: str) -> str:
    t = CUR_TEXT_RE.sub("'", t.lower())
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"[^a-z' ]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def main() -> None:
    if not EMB_PATH.exists():
        raise SystemExit("embeddings missing — run scripts/embed.py first")

    print("[topic] loading embeddings…")
    emb = np.load(EMB_PATH)
    msg_ids = np.load(IDS_PATH)
    id_to_idx = {int(i): k for k, i in enumerate(msg_ids)}

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    seg_ids: list[int] = []
    seg_text: list[str] = []
    seg_emb_list: list[np.ndarray] = []
    rep_per_seg: list[list[tuple[int, str]]] = []  # representative msgs per segment

    print("[topic] aggregating segment embeddings + text…")
    for seg in conn.execute(
        "SELECT id FROM seg_segments WHERE n_msgs >= 4 ORDER BY id"
    ):
        sid = seg["id"]
        msgs = list(
            conn.execute(
                """
                SELECT m.id, m.ts, m.text, m.is_from_me
                FROM seg_msg_segment sm
                JOIN messages m ON m.id = sm.msg_id
                WHERE sm.segment_id = ? AND m.text IS NOT NULL AND length(trim(m.text)) > 0
                ORDER BY m.ts ASC
                """,
                (sid,),
            )
        )
        if not msgs:
            continue
        rows = []
        for m in msgs:
            mi = id_to_idx.get(int(m["id"]))
            if mi is None:
                continue
            rows.append((mi, m["text"]))
        if len(rows) < 3:
            continue
        rep_per_seg.append([(mi, txt) for mi, txt in rows[:30]])
        sub = emb[[mi for mi, _ in rows]]
        seg_vec = sub.mean(axis=0)
        seg_vec /= max(np.linalg.norm(seg_vec), 1e-9)
        seg_ids.append(sid)
        seg_emb_list.append(seg_vec)
        # build doc text from up to 80 messages, stripped
        bits = [clean_text(m["text"]) for m in msgs[:80]]
        seg_text.append(" ".join([b for b in bits if b]))

    seg_emb = np.asarray(seg_emb_list, dtype=np.float32)
    print(f"[topic] {len(seg_ids):,} segments embedded")
    np.save(SEG_EMB_PATH, seg_emb)
    np.save(SEG_IDS_PATH, np.asarray(seg_ids, dtype=np.int64))

    from bertopic import BERTopic
    from sklearn.feature_extraction.text import CountVectorizer
    from umap import UMAP
    from hdbscan import HDBSCAN

    n_segments = len(seg_ids)
    # Spec calls for 30-100 topics. Force the cluster size to land us there.
    min_cluster = int(os.environ.get("MESSAGE_MIN_CLUSTER", "15"))
    print(f"[topic] running BERTopic   min_cluster_size={min_cluster}")

    umap_5d = UMAP(
        n_neighbors=15,
        n_components=5,
        min_dist=0.0,
        metric="cosine",
        random_state=42,
    )
    hdb = HDBSCAN(
        min_cluster_size=min_cluster,
        min_samples=3,
        metric="euclidean",
        cluster_selection_method="leaf",  # finer granularity than 'eom'
        prediction_data=True,
    )
    vect = CountVectorizer(stop_words=stopwords(), ngram_range=(1, 2), min_df=2, max_df=0.95)

    topic_model = BERTopic(
        embedding_model=None,
        umap_model=umap_5d,
        hdbscan_model=hdb,
        vectorizer_model=vect,
        calculate_probabilities=False,
        verbose=True,
    )
    topics, _ = topic_model.fit_transform(seg_text, embeddings=seg_emb)

    info = topic_model.get_topic_info()
    print(info.head(20))
    print(f"[topic] {len(info)} topics (incl. -1 outliers)")

    # Compute 2D UMAP coords for plotting (separately, more aggressive)
    print("[topic] computing 2D UMAP for visualization…")
    umap_2d = UMAP(n_neighbors=15, n_components=2, min_dist=0.1, metric="cosine", random_state=42)
    coords = umap_2d.fit_transform(seg_emb)
    np.save(UMAP2_PATH, coords)
    print(f"[topic] saved UMAP-2D to {UMAP2_PATH}")

    # Persist
    write_conn = sqlite3.connect(DB)
    write_conn.execute("PRAGMA journal_mode=WAL")
    write_conn.executescript(
        """
        DROP TABLE IF EXISTS seg_topics;
        DROP TABLE IF EXISTS seg_topic_keywords;
        CREATE TABLE seg_topics (
            id INTEGER PRIMARY KEY,
            n_segments INTEGER NOT NULL,
            top_words TEXT,
            top_phrases TEXT,
            representative_segment_id INTEGER,
            label TEXT
        );
        CREATE TABLE seg_topic_keywords (
            topic_id INTEGER NOT NULL,
            word TEXT NOT NULL,
            score REAL NOT NULL
        );
        CREATE INDEX seg_topic_keywords_topic_idx ON seg_topic_keywords(topic_id);
        """
    )

    rep_dump: dict[str, dict] = {}
    # For each topic, find the segment closest to the topic centroid
    for tid in info["Topic"].tolist():
        if tid == -1:
            continue
        topic_segs = [i for i, t in enumerate(topics) if t == tid]
        if not topic_segs:
            continue
        center = seg_emb[topic_segs].mean(axis=0)
        center = center / max(np.linalg.norm(center), 1e-9)
        dists = -(seg_emb[topic_segs] @ center)  # negative cos = closest first
        rep_local = topic_segs[int(np.argmin(dists))]
        rep_seg_id = seg_ids[rep_local]
        kws = topic_model.get_topic(tid) or []
        words_only = [w for (w, _) in kws[:8] if w]
        phrases_only = [w for (w, _) in kws[:8] if " " in w] or words_only
        write_conn.execute(
            "INSERT INTO seg_topics (id, n_segments, top_words, top_phrases, representative_segment_id, label) VALUES (?,?,?,?,?,?)",
            (
                int(tid),
                len(topic_segs),
                json.dumps(words_only),
                json.dumps(phrases_only),
                int(rep_seg_id),
                None,
            ),
        )
        for w, score in kws[:15]:
            write_conn.execute(
                "INSERT INTO seg_topic_keywords (topic_id, word, score) VALUES (?,?,?)",
                (int(tid), str(w), float(score)),
            )
        # collect 5 closest segments and their representative messages
        order = np.argsort(dists)[:5]
        rep_dump[str(int(tid))] = {
            "label": None,
            "top_words": words_only,
            "n_segments": len(topic_segs),
            "representative_segment_id": int(rep_seg_id),
            "samples": [
                {
                    "segment_id": int(seg_ids[topic_segs[k]]),
                    "text": " | ".join([txt[:160] for _, txt in rep_per_seg[topic_segs[k]][:8]])[:1500],
                }
                for k in order
            ],
        }

    # Update segment.topic_id + UMAP coords
    print("[topic] writing per-segment topic_id + UMAP coords…")
    for i, sid in enumerate(seg_ids):
        tid = int(topics[i])
        write_conn.execute(
            "UPDATE seg_segments SET topic_id=?, umap_x=?, umap_y=? WHERE id=?",
            (tid if tid != -1 else None, float(coords[i, 0]), float(coords[i, 1]), int(sid)),
        )
    write_conn.commit()
    write_conn.close()
    conn.close()

    TOPIC_REPS.parent.mkdir(parents=True, exist_ok=True)
    TOPIC_REPS.write_text(json.dumps(rep_dump, indent=2))
    print(f"[topic] dumped reps to {TOPIC_REPS}")


if __name__ == "__main__":
    sys.exit(main())
