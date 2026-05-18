"""
Per-message sentence embeddings.

Reads messages from data/runtime/conversation.db, runs BAAI/bge-small-en-v1.5 (384d) over text,
saves dense fp16 matrix to data/embeddings_msg.npy and aligned id vector to
data/embeddings_msg_ids.npy.

Skips messages with no decoded text (tapbacks, attachments-only, etc.) — those
get no embedding and won't be included in segmentation.
"""
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "runtime" / "conversation.db"
OUT_EMB = ROOT / "data" / "embeddings_msg.npy"
OUT_IDS = ROOT / "data" / "embeddings_msg_ids.npy"

MODEL_NAME = os.environ.get("MESSAGE_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
BATCH = int(os.environ.get("MESSAGE_EMBED_BATCH", "256"))
MAX_TOKENS = 96  # short messages, keeps it fast


def select_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def main() -> None:
    if OUT_EMB.exists() and OUT_IDS.exists() and not os.environ.get("MESSAGE_EMBED_FORCE"):
        print(f"[embed] reusing existing {OUT_EMB.name} (set MESSAGE_EMBED_FORCE=1 to redo)")
        return

    device = select_device()
    print(f"[embed] device={device} model={MODEL_NAME} batch={BATCH}")

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cur = conn.execute(
        """
        SELECT id, text
        FROM messages
        WHERE text IS NOT NULL
          AND length(trim(text)) > 0
          AND (associated_message_type IS NULL OR associated_message_type < 2000)
        ORDER BY ts
        """
    )
    ids: list[int] = []
    texts: list[str] = []
    for r in cur:
        t = (r["text"] or "").strip()
        if not t:
            continue
        # truncate at char level — model will tokenize anyway
        ids.append(r["id"])
        texts.append(t[:1024])
    conn.close()

    print(f"[embed] {len(ids):,} messages with text")
    if not ids:
        raise SystemExit("no messages to embed")

    model = SentenceTransformer(MODEL_NAME, device=device)
    model.max_seq_length = MAX_TOKENS

    out = np.empty((len(ids), 384), dtype=np.float32)
    t0 = time.time()
    written = 0
    with tqdm(total=len(ids), unit="msg") as bar:
        for start in range(0, len(ids), BATCH):
            end = min(start + BATCH, len(ids))
            chunk = texts[start:end]
            v = model.encode(
                chunk,
                batch_size=BATCH,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            out[start:end] = v.astype(np.float32, copy=False)
            written += end - start
            bar.update(end - start)
    dt = time.time() - t0
    print(f"[embed] done in {dt:.1f}s ({written/dt:.0f} msgs/s)")

    OUT_EMB.parent.mkdir(parents=True, exist_ok=True)
    np.save(OUT_EMB, out)
    np.save(OUT_IDS, np.array(ids, dtype=np.int64))
    print(f"[embed] wrote {OUT_EMB} ({out.nbytes/1e6:.1f} MB), {OUT_IDS}")


if __name__ == "__main__":
    sys.exit(main())
