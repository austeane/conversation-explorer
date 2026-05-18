"""Shared Python analysis helpers mirrored from src/lib/conversation."""

from __future__ import annotations

import re

APOSTROPHES = str.maketrans({"‘": "'", "’": "'", "‛": "'", "ʼ": "'"})


def normalize_apostrophes(text: str) -> str:
    return text.translate(APOSTROPHES)


def tokenize(
    text: str,
    *,
    lowercase: bool = True,
    strip_quotes: bool = True,
    min_len: int = 1,
    max_len: int = 40,
) -> list[str]:
    normalized = normalize_apostrophes(text.lower() if lowercase else text)
    normalized = re.sub(r"[^a-z0-9' ]+", " ", normalized, flags=re.IGNORECASE)
    tokens: list[str] = []
    for raw in re.split(r"\s+", normalized):
        token = raw.strip("'") if strip_quotes else raw
        if not token:
            continue
        if len(token) < min_len or len(token) > max_len:
            continue
        tokens.append(token)
    return tokens
