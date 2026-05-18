// Minimal NSAttributedString typedstream reader.
// iMessage stores rich text in `attributedBody` (NSKeyedArchiver typedstream).
// We only need the first NSString's bytes — attribute spans aren't needed.
//
// Layout we look for inside the typedstream:
//   ...NSString class chain...  '+'  <length-prefix>  <utf8 bytes>
// where length-prefix is one of:
//   0x00..0x7f         → 1-byte length (n = b)
//   0x81 LL LL         → 2-byte LE length
//   0x82 LL LL LL LL   → 4-byte LE length

const NS_STRING = Buffer.from("NSString", "utf8");

export function decodeAttributedBody(blob: Buffer | null | undefined): string | null {
  if (!blob || blob.length < 16) return null;

  // Find the last "NSString" reference followed by '+' within ~16 bytes.
  // We scan repeatedly because the typedstream may include multiple
  // NSString class references; the actual body text follows '+' then the length prefix.
  let searchFrom = 0;
  while (searchFrom < blob.length) {
    const idx = blob.indexOf(NS_STRING, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + NS_STRING.length;

    // Look for '+' shortly after
    const plusIdx = blob.indexOf(0x2b, searchFrom);
    if (plusIdx < 0 || plusIdx > searchFrom + 16) continue;

    let p = plusIdx + 1;
    if (p >= blob.length) continue;

    const b0 = blob[p];
    let n = 0;
    if (b0 === 0x81) {
      if (p + 3 > blob.length) continue;
      n = blob.readUInt16LE(p + 1);
      p += 3;
    } else if (b0 === 0x82) {
      if (p + 5 > blob.length) continue;
      n = blob.readUInt32LE(p + 1);
      p += 5;
    } else if (b0 < 0x80) {
      n = b0;
      p += 1;
    } else {
      continue;
    }

    if (n === 0) {
      // Empty NSString — keep scanning for a non-empty one.
      continue;
    }
    if (n > blob.length - p) continue;

    const slice = blob.subarray(p, p + n);
    const text = slice.toString("utf8");
    // Sanity: reject if it contains control chars more than ~1% (likely binary fallthrough)
    let bad = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x09 || (c > 0x0d && c < 0x20)) bad++;
    }
    if (bad > Math.max(2, text.length / 50)) continue;
    return text;
  }

  // Fallback: scan for printable ASCII/UTF-8 runs and pick the longest > 4 chars
  // that doesn't look like a known classname.
  const ignore = new Set([
    "NSString",
    "NSAttributedString",
    "NSDictionary",
    "NSObject",
    "NSNumber",
    "NSMutableString",
    "NSMutableAttributedString",
    "streamtyped",
  ]);
  let best = "";
  let cur = "";
  for (let i = 0; i < blob.length; i++) {
    const b = blob[i];
    if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
    else {
      if (cur.length > best.length && !ignore.has(cur)) best = cur;
      cur = "";
    }
  }
  if (cur.length > best.length && !ignore.has(cur)) best = cur;
  return best.length >= 2 ? best : null;
}
