// Quick CLI sanity check — replicates getIconicWords / lift logic from queries.ts
// to confirm the baseline integration works end-to-end before browser smoke test.
//
// Usage: node scripts/inspect-iconic.mjs

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB = join(process.cwd(), "data/runtime/conversation.db");
const BASELINE = JSON.parse(
  readFileSync(join(process.cwd(), "data/baseline-frequencies.json"), "utf-8"),
).frequencies;

const WORD_STOP = new Set([
  "the","a","an","and","or","but","if","so","of","in","on","at","to","for","with","by",
  "is","are","was","were","be","been","being","have","has","had","do","does","did",
  "i","you","we","they","he","she","it","me","my","your","our","their","his","her","its",
  "this","that","these","those","as","not","no","yes","ok","okay","oh","um","uh","like","just",
  "really","very","up","down","out","off","over","there","here","then","than","when","where","what","which","who",
  "from","into","about","also","too","can","will","would","could","should",
  "u","ur","ya","yeah","yep","yup","ima","gotta","ah","mm","mhm","mmm","hm","hmm","huh",
  "lol","lmao","haha","hehe","nah","yo","hi","hey","hello","well","got","get","gets","getting","gotten",
  "go","goes","going","went","gone","good","bad","sure","right","fine","one","two","three",
  "im","i'm","ive","i've","ill","i'll","id","i'd",
  "dont","don't","doesnt","doesn't","didnt","didn't","cant","can't","wont","won't","aint","ain't",
  "thats","that's","theres","there's","whats","what's","heres","here's","its","it's",
  "youre","you're","youve","you've","youll","you'll","youd","you'd",
  "shes","she's","hes","he's","theyre","they're","weve","we've","were","we're",
  "gonna","wanna","kinda","sorta","didn","doesn","wasn","wasn't","isn","isn't",
  "wouldn","wouldn't","couldn","couldn't","shouldn","shouldn't","haven","haven't","hadn","hadn't","hasn","hasn't",
]);

const db = new Database(DB, { readonly: true });
const counts = [new Map(), new Map()];
let nMe = 0, nThem = 0;

for (const r of db.prepare(
  `SELECT is_from_me, text FROM messages WHERE text IS NOT NULL AND text != ''`,
).iterate()) {
  const t = r.text
    .toLowerCase()
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[^a-z' ]+/g, " ");
  for (const raw of t.split(/\s+/)) {
    if (!raw) continue;
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 3 || w.length > 20) continue;
    if (WORD_STOP.has(w)) continue;
    counts[r.is_from_me].set(w, (counts[r.is_from_me].get(w) ?? 0) + 1);
    if (r.is_from_me === 1) nMe++;
    else nThem++;
  }
}

const N = nMe + nThem;
const ALPHA0 = 100;
const MIN_COMBINED = 10;
const UNKNOWN_ZIPF = 1.0;
const zipfToRate = (z) => Math.pow(10, z - 9);

const vocab = new Set([...counts[0].keys(), ...counts[1].keys()]);
const rows = [];
for (const w of vocab) {
  const yMe = counts[1].get(w) ?? 0;
  const yThem = counts[0].get(w) ?? 0;
  const yW = yMe + yThem;
  if (yW < MIN_COMBINED) continue;
  if (yMe === 0 || yThem === 0) continue;

  const alphaW = ALPHA0 * (yW / N);
  const lo_me = Math.log((yMe + alphaW) / (nMe + ALPHA0 - yMe - alphaW));
  const lo_them = Math.log((yThem + alphaW) / (nThem + ALPHA0 - yThem - alphaW));
  const variance = 1 / (yMe + alphaW) + 1 / (yThem + alphaW);
  const z = (lo_me - lo_them) / Math.sqrt(variance);

  const baselineZipf = (BASELINE[w] && BASELINE[w] !== 0) ? BASELINE[w] : UNKNOWN_ZIPF;
  const baseRate = zipfToRate(baselineZipf);
  const lift_me = (yMe / nMe) / baseRate;
  const lift_them = (yThem / nThem) / baseRate;
  const minLift = Math.min(lift_me, lift_them);
  const iconic = Math.log10(minLift);

  rows.push({ w, yMe, yThem, yW, z, baselineZipf, lift_me, lift_them, minLift, iconic });
}

console.log(`vocab: ${vocab.size} types, ${rows.length} candidates after combined ≥ ${MIN_COMBINED} + both-sided`);
console.log(`tokens: me=${nMe} them=${nThem}`);

// Default thresholds — same as the route's loader call:
const cands = rows.filter((r) => Math.abs(r.z) <= 1.5 && r.iconic >= 1.0)
  .sort((a, b) => b.iconic - a.iconic);
console.log(`\n--- TOP 25 ICONIC (|z| ≤ 1.5, iconic_score ≥ 1.0) ---`);
console.log("word            n     me    them    z    zipf  ×lift_me ×lift_them  iconic");
for (const r of cands.slice(0, 25)) {
  console.log(
    `${r.w.padEnd(15)} ${String(r.yW).padStart(4)} ${String(r.yMe).padStart(5)} ${String(r.yThem).padStart(6)} ${r.z.toFixed(2).padStart(5)}  ${r.baselineZipf.toFixed(2).padStart(4)}   ${r.lift_me.toFixed(1).padStart(6)}   ${r.lift_them.toFixed(1).padStart(7)}    ${r.iconic.toFixed(2)}`,
  );
}

// Sanity check: see what the OLD middle column (|z| < 0.5, sort by combined) would have shown.
const oldShared = rows
  .filter((r) => Math.abs(r.z) < 0.5)
  .sort((a, b) => b.yW - a.yW)
  .slice(0, 15);
console.log(`\n--- OLD SHARED-ICONIC (|z| < 0.5, top 15 by combined count) ---`);
for (const r of oldShared) {
  console.log(`${r.w.padEnd(15)} n=${r.yW}  iconic=${r.iconic.toFixed(2)}  zipf=${r.baselineZipf.toFixed(2)}`);
}

// Words that appeared in OLD middle column but DROP out of new iconic.
const newIconicSet = new Set(cands.slice(0, 30).map((r) => r.w));
const dropped = oldShared.filter((r) => !newIconicSet.has(r.w));
console.log(`\n--- OLD shared words that dropped out of new iconic (no longer surfaced) ---`);
for (const r of dropped) {
  console.log(`${r.w.padEnd(15)} zipf=${r.baselineZipf.toFixed(2)}  iconic=${r.iconic.toFixed(2)}  reason=${r.iconic < 1.0 ? "below 10× lift" : "fine"}`);
}
