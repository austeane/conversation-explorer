import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { classifyMove, MOVE_META, type MoveKind } from "./move-classifier";
import { resolveMessageScope } from "./scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const SILENCE_GAP_SECONDS = 6 * 60 * 60;
const FOUR_HOURS = 4 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const PRIOR_WINDOW_SECONDS = 30 * DAY_SECONDS;
const MATCHES_PER_ATTEMPT = 5;
const MIN_TREATED = 18;
const TOP_EFFECTS = 18;
const TOP_RISKS = 10;

export type Sender = "Me" | "Them";

export type CounterfactualOverview = {
  generated_at: string;
  real_messages: number;
  attempts: number;
  matched_attempts: number;
  matched_controls: number;
  unique_controls: number;
  reused_controls: number;
  weakest_balance_feature: string;
  max_abs_smd: number;
  strongest_lift: string;
  strongest_lift_delta: number;
  strongest_watchout: string;
  strongest_watchout_delta: number;
};

export type OutcomeKey =
  | "reply"
  | "live"
  | "warm"
  | "repair"
  | "reciprocal"
  | "calm"
  | "quiet"
  | "strain";

export type CounterfactualEffect = {
  key: string;
  kind: MoveKind;
  kind_label: string;
  outcome: OutcomeKey;
  outcome_label: string;
  description: string;
  treated: number;
  controls: number;
  observed_rate: number;
  matched_rate: number;
  delta: number;
  ci_low: number;
  ci_high: number;
  z_score: number;
  max_abs_smd: number;
  match_quality: MatchQuality;
  avg_messages_delta: number;
  median_reply_delta_seconds: number | null;
  breakdowns: CounterfactualBreakdown[];
  examples: CounterfactualExample[];
};

export type CounterfactualBreakdown = {
  group: "sender" | "era";
  label: string;
  treated: number;
  observed_rate: number;
  matched_rate: number;
  delta: number;
  ci_low: number;
  ci_high: number;
};

export type CounterfactualProfile = {
  kind: string;
  label: string;
  description: string;
  attempts: number;
  matched_controls: number;
  reply_rate: number;
  matched_reply_rate: number;
  live_rate: number;
  matched_live_rate: number;
  warm_rate: number;
  matched_warm_rate: number;
  quiet_rate: number;
  matched_quiet_rate: number;
  unique_controls: number;
  reused_controls: number;
  max_abs_smd: number;
  match_quality: MatchQuality;
  best_outcome: string;
  best_delta: number;
};

export type MatchQuality = "good" | "watch" | "weak";

export type CounterfactualDiagnostic = {
  kind: string;
  label: string;
  attempts: number;
  controls: number;
  unique_controls: number;
  reused_controls: number;
  max_control_reuse: number;
  max_abs_smd: number;
  worst_feature: string;
  quality: MatchQuality;
};

export type CounterfactualExample = {
  id: number;
  ts: number;
  ymd: string;
  sender: Sender;
  kind_label: string;
  preview: string;
  messages_24h: number;
  reply_seconds: number | null;
  matched_id: number;
  matched_ts: number;
  matched_ymd: string;
  matched_kind_label: string;
  matched_preview: string;
  matched_messages_24h: number;
  matched_reply_seconds: number | null;
  distance: number;
};

export type CounterfactualResult = {
  overview: CounterfactualOverview;
  effects: CounterfactualEffect[];
  profiles: CounterfactualProfile[];
  diagnostics: CounterfactualDiagnostic[];
  risks: CounterfactualEffect[];
};

type MessageRow = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  is_from_me: number;
  word_count: number;
  has_attachment: number;
  text: string | null;
};

type MessageSignals = {
  warmth: number;
  strain: number;
  repair: number;
  play: number;
};

type PrefixSignals = {
  warmth: number[];
  strain: number[];
  repair: number[];
  play: number[];
  me: number[];
  them: number[];
};

type Attempt = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  sender: Sender;
  kind: MoveKind;
  kindLabel: string;
  description: string;
  preview: string;
  gapSeconds: number;
  gapBucket: string;
  year: number;
  hour: number;
  openerWords: number;
  hasAttachment: number;
  priorMessages: number;
  priorWarmthRate: number;
  priorStrainRate: number;
  priorRepairRate: number;
  vector: number[];
  outcomes: Record<OutcomeKey, boolean>;
  messages24h: number;
  messages4h: number;
  replySeconds: number | null;
};

type MatchBundle = {
  treated: Attempt[];
  controlsByAttempt: Map<number, { control: Attempt; distance: number }[]>;
};

type OutcomeDefinition = {
  key: OutcomeKey;
  label: string;
  description: string;
};

type ControlReuseStats = {
  controls: number;
  unique: number;
  reused: number;
  maxUses: number;
};

type BalanceStats = {
  maxAbsSmd: number;
  worstFeature: string;
};

const COUNTERFACTUAL_KINDS: MoveKind[] = [
  "repair",
  "care",
  "affection",
  "vulnerable",
  "logistics",
  "question",
  "play",
  "object",
  "arrival",
  "status",
];

const OUTCOMES: OutcomeDefinition[] = [
  {
    key: "reply",
    label: "Reply landed",
    description: "The other person answered within 24 hours.",
  },
  {
    key: "live",
    label: "Live exchange",
    description: "The next day became a multi-turn exchange, not just a receipt.",
  },
  {
    key: "warm",
    label: "Warm landing",
    description: "Warmth language appeared in the follow-on day.",
  },
  {
    key: "repair",
    label: "Repair landing",
    description: "The next day included apology, gratitude, understanding, or explicit repair.",
  },
  {
    key: "reciprocal",
    label: "Reciprocal day",
    description: "Both people contributed substantially in the next 24 hours.",
  },
  {
    key: "calm",
    label: "Calm follow-on",
    description: "There was follow-on conversation without a strain-heavy drift.",
  },
];

const RISK_OUTCOMES: OutcomeDefinition[] = [
  {
    key: "quiet",
    label: "Quiet miss",
    description: "The opener was followed by no reply or almost no follow-on.",
  },
  {
    key: "strain",
    label: "Strain drift",
    description: "The follow-on day contained an unusually high strain share.",
  },
];

const MATCH_FEATURES = [
  "Silence length",
  "Era",
  "Daypart sine",
  "Daypart cosine",
  "Prior volume",
  "Prior warmth",
  "Prior strain",
  "Prior repair",
  "Opener words",
  "Attachment",
] as const;

const SIGNAL_LEXICONS = {
  warmth: /\b(love|miss|proud|sweet|beautiful|cute|kiss|cuddle|hug|darling|sweetheart|angel|heart)\b/i,
  strain: /\b(sad|hurt|scared|afraid|anxious|worried|stress|stressed|overwhelmed|lonely|cry|crying|upset|mad|hard|pain)\b/i,
  repair: /\b(sorry|apologize|apologise|forgive|thank|thanks|grateful|understand|okay|safe|my bad)\b/i,
  play: /\b(lol|lmao|haha|hehe|funny|silly|wild|joke|hilarious|game|meme)\b/i,
};

export const getCounterfactuals = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<CounterfactualResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`counterfactuals:${JSON.stringify(resolved)}`, () => {
      const scanScope: MessageScope = { ...resolved, sender: "both" };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ym, m.ymd, m.is_from_me, m.word_count, m.has_attachment, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const signals = rows.map(signalForMessage);
      const prefixes = buildPrefixes(rows, signals);
      const attempts = buildAttempts(rows, signals, prefixes).filter((attempt) => senderMatches(attempt.sender, resolved.sender));
      const matchBundles = new Map<MoveKind, MatchBundle>();
      const eligibleKinds = COUNTERFACTUAL_KINDS.filter(
        (kind) => attempts.filter((attempt) => attempt.kind === kind).length >= MIN_TREATED,
      );

      for (const kind of eligibleKinds) {
        matchBundles.set(kind, buildMatchesForKind(attempts, kind));
      }

      const diagnostics = buildDiagnostics(matchBundles);
      const effects = buildEffects(matchBundles, OUTCOMES)
        .filter(passesEffectGate)
        .sort((a, b) => scoreEffect(b) - scoreEffect(a))
        .slice(0, TOP_EFFECTS);
      const risks = buildEffects(matchBundles, RISK_OUTCOMES)
        .filter(passesEffectGate)
        .sort((a, b) => scoreEffect(b) - scoreEffect(a))
        .slice(0, TOP_RISKS);
      const profiles = buildProfiles(matchBundles);
      const matchedControls = [...matchBundles.values()].reduce(
        (total, bundle) =>
          total + [...bundle.controlsByAttempt.values()].reduce((sum, controls) => sum + controls.length, 0),
        0,
      );
      const controlStats = controlReuseStats([...matchBundles.values()]);
      const worstDiagnostic = diagnostics.reduce<CounterfactualDiagnostic | null>(
        (worst, item) => (!worst || item.max_abs_smd > worst.max_abs_smd ? item : worst),
        null,
      );
      const topEffect = effects[0];
      const topRisk = risks[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.filter((row) => senderMatches(senderFor(row), resolved.sender)).length,
          attempts: attempts.length,
          matched_attempts: [...matchBundles.values()].reduce((total, bundle) => total + bundle.treated.length, 0),
          matched_controls: matchedControls,
          unique_controls: controlStats.unique,
          reused_controls: controlStats.reused,
          weakest_balance_feature: worstDiagnostic?.worst_feature ?? "n/a",
          max_abs_smd: worstDiagnostic?.max_abs_smd ?? 0,
          strongest_lift: topEffect ? `${topEffect.kind_label} -> ${topEffect.outcome_label}` : "n/a",
          strongest_lift_delta: topEffect?.delta ?? 0,
          strongest_watchout: topRisk ? `${topRisk.kind_label} -> ${topRisk.outcome_label}` : "n/a",
          strongest_watchout_delta: topRisk?.delta ?? 0,
        },
        effects,
        profiles,
        diagnostics,
        risks,
      };
    });
  });

function buildAttempts(rows: MessageRow[], signals: MessageSignals[], prefixes: PrefixSignals): Attempt[] {
  const timestamps = rows.map((row) => row.ts);
  const attempts: Attempt[] = [];

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const previous = rows[index - 1];
    const gapSeconds = row.ts - previous.ts;
    if (gapSeconds < SILENCE_GAP_SECONDS) continue;

    const priorStart = lowerBound(timestamps, row.ts - PRIOR_WINDOW_SECONDS);
    const future24End = upperBound(timestamps, row.ts + DAY_SECONDS);
    const future4End = upperBound(timestamps, row.ts + FOUR_HOURS);
    const priorMessages = index - priorStart;
    const sender = senderFor(row);
    const kindDefinition = classifyMove(row);
    const replySeconds = firstReplySeconds(rows, index, future24End, sender);
    const followStart = index + 1;
    const messages24h = Math.max(0, future24End - followStart);
    const messages4h = Math.max(0, future4End - followStart);
    const futureSignals = signalWindow(prefixes, followStart, future24End);
    const futureSenderCounts = senderWindow(prefixes, followStart, future24End);
    const handoffs24h = countHandoffs(rows, index, future24End);
    const priorWarmthRate = safeRate(prefixes.warmth[index] - prefixes.warmth[priorStart], priorMessages);
    const priorStrainRate = safeRate(prefixes.strain[index] - prefixes.strain[priorStart], priorMessages);
    const priorRepairRate = safeRate(prefixes.repair[index] - prefixes.repair[priorStart], priorMessages);
    const ym = bucket(row.ts, "ym");
    const ymd = bucket(row.ts, "ymd");
    const year = Number(ym.slice(0, 4));
    const hour = Number(bucket(row.ts, "hour"));
    const futureStrainRate = safeRate(futureSignals.strain, messages24h);
    const meShare = safeRate(futureSenderCounts.me, futureSenderCounts.me + futureSenderCounts.them);
    const quiet = replySeconds == null || messages24h <= 1;
    const live = replySeconds != null && (messages4h >= 5 || messages24h >= 10 || handoffs24h >= 3);

    attempts.push({
      id: row.id,
      ts: row.ts,
      ym,
      ymd,
      sender,
      kind: kindDefinition.kind,
      kindLabel: kindDefinition.label,
      description: kindDefinition.description,
      preview: cleanPreview(row.text),
      gapSeconds,
      gapBucket: bucketGap(gapSeconds),
      year,
      hour,
      openerWords: row.word_count,
      hasAttachment: row.has_attachment,
      priorMessages,
      priorWarmthRate,
      priorStrainRate,
      priorRepairRate,
      vector: [
        Math.log1p(gapSeconds) / Math.log1p(30 * DAY_SECONDS),
        (year - 2019) / 7,
        Math.sin((hour / 24) * Math.PI * 2),
        Math.cos((hour / 24) * Math.PI * 2),
        Math.log1p(priorMessages) / Math.log1p(900),
        priorWarmthRate * 12,
        priorStrainRate * 12,
        priorRepairRate * 12,
        Math.log1p(row.word_count) / Math.log1p(90),
        row.has_attachment ? 1 : 0,
      ],
      outcomes: {
        reply: replySeconds != null,
        live,
        warm: futureSignals.warmth >= 2,
        repair: futureSignals.repair >= 1,
        reciprocal: messages24h >= 7 && meShare >= 0.32 && meShare <= 0.68 && handoffs24h >= 3,
        calm: messages24h >= 2 && futureStrainRate < 0.08,
        quiet,
        strain: futureSignals.strain >= 2 && futureStrainRate >= 0.055,
      },
      messages24h,
      messages4h,
      replySeconds,
    });
  }

  return attempts.filter((attempt) => attempt.preview.length > 0);
}

function buildMatchesForKind(attempts: Attempt[], kind: MoveKind): MatchBundle {
  const treated = attempts.filter((attempt) => attempt.kind === kind);
  const controlsByAttempt = new Map<number, { control: Attempt; distance: number }[]>();

  for (const attempt of treated) {
    let candidates = attempts.filter(
      (candidate) =>
        candidate.kind !== kind &&
        candidate.sender === attempt.sender &&
        candidate.gapBucket === attempt.gapBucket &&
        Math.abs(candidate.year - attempt.year) <= 2,
    );
    if (candidates.length < MATCHES_PER_ATTEMPT) {
      candidates = attempts.filter(
        (candidate) => candidate.kind !== kind && candidate.sender === attempt.sender && candidate.gapBucket === attempt.gapBucket,
      );
    }
    if (candidates.length < MATCHES_PER_ATTEMPT) {
      candidates = attempts.filter((candidate) => candidate.kind !== kind && candidate.sender === attempt.sender);
    }

    const controls = candidates
      .map((control) => ({ control, distance: vectorDistance(attempt.vector, control.vector) }))
      .sort((a, b) => a.distance - b.distance || Math.abs(a.control.ts - attempt.ts) - Math.abs(b.control.ts - attempt.ts))
      .slice(0, MATCHES_PER_ATTEMPT);

    if (controls.length) controlsByAttempt.set(attempt.id, controls);
  }

  return {
    treated: treated.filter((attempt) => controlsByAttempt.has(attempt.id)),
    controlsByAttempt,
  };
}

function buildEffects(matchBundles: Map<MoveKind, MatchBundle>, outcomes: OutcomeDefinition[]): CounterfactualEffect[] {
  const effects: CounterfactualEffect[] = [];
  for (const [kind, bundle] of matchBundles) {
    const definition = definitionForKind(kind);
    if (!definition || bundle.treated.length < MIN_TREATED) continue;
    const balance = balanceStats(bundle);
    const quality = matchQuality(balance.maxAbsSmd);

    for (const outcome of outcomes) {
      const treatedValues: number[] = [];
      const matchedValues: number[] = [];
      const pairedDeltas: number[] = [];
      const messageDeltas: number[] = [];
      const treatedReplies: number[] = [];
      const controlReplies: number[] = [];
      let controls = 0;

      for (const attempt of bundle.treated) {
        const matched = bundle.controlsByAttempt.get(attempt.id) ?? [];
        if (!matched.length) continue;
        const treatedValue = attempt.outcomes[outcome.key] ? 1 : 0;
        const matchedValue = avg(matched.map(({ control }) => (control.outcomes[outcome.key] ? 1 : 0)));
        const matchedMessages = avg(matched.map(({ control }) => control.messages24h));
        treatedValues.push(treatedValue);
        matchedValues.push(matchedValue);
        pairedDeltas.push(treatedValue - matchedValue);
        messageDeltas.push(attempt.messages24h - matchedMessages);
        if (attempt.replySeconds != null) treatedReplies.push(attempt.replySeconds);
        controls += matched.length;
        for (const { control } of matched) {
          if (control.replySeconds != null) controlReplies.push(control.replySeconds);
        }
      }

      const observedRate = avg(treatedValues);
      const matchedRate = avg(matchedValues);
      const delta = avg(pairedDeltas);
      const ci = bootstrapMeanCi(pairedDeltas, `${kind}:${outcome.key}`);
      const zScore = zForPairedDeltas(pairedDeltas);
      effects.push({
        key: `${kind}-${outcome.key}`,
        kind,
        kind_label: definition.label,
        outcome: outcome.key,
        outcome_label: outcome.label,
        description: outcome.description,
        treated: treatedValues.length,
        controls,
        observed_rate: round(observedRate),
        matched_rate: round(matchedRate),
        delta: round(delta),
        ci_low: round(ci.low),
        ci_high: round(ci.high),
        z_score: round(zScore),
        max_abs_smd: round(balance.maxAbsSmd),
        match_quality: quality,
        avg_messages_delta: round(avg(messageDeltas)),
        median_reply_delta_seconds: replyDelta(treatedReplies, controlReplies),
        breakdowns: effectBreakdowns(bundle, outcome.key, `${kind}:${outcome.key}`),
        examples: examplesForEffect(bundle, outcome.key),
      });
    }
  }
  return effects;
}

function passesEffectGate(effect: CounterfactualEffect) {
  return effect.delta > 0.025 && effect.ci_low > 0;
}

function effectBreakdowns(bundle: MatchBundle, outcome: OutcomeKey, seedKey: string): CounterfactualBreakdown[] {
  const groups = [
    ...(["Me", "Them"] as const).map((sender) => ({
      group: "sender" as const,
      label: sender,
      attempts: bundle.treated.filter((attempt) => attempt.sender === sender),
    })),
    ...eraGroups(bundle.treated).map(([label, attempts]) => ({
      group: "era" as const,
      label,
      attempts,
    })),
  ];

  return groups
    .map((group) => summarizeBreakdown(group.group, group.label, group.attempts, bundle, outcome, seedKey))
    .filter((item): item is CounterfactualBreakdown => item != null);
}

function summarizeBreakdown(
  group: "sender" | "era",
  label: string,
  attempts: Attempt[],
  bundle: MatchBundle,
  outcome: OutcomeKey,
  seedKey: string,
): CounterfactualBreakdown | null {
  const treatedValues: number[] = [];
  const matchedValues: number[] = [];
  const deltas: number[] = [];

  for (const attempt of attempts) {
    const matched = bundle.controlsByAttempt.get(attempt.id) ?? [];
    if (!matched.length) continue;
    const treatedValue = attempt.outcomes[outcome] ? 1 : 0;
    const matchedValue = avg(matched.map(({ control }) => (control.outcomes[outcome] ? 1 : 0)));
    treatedValues.push(treatedValue);
    matchedValues.push(matchedValue);
    deltas.push(treatedValue - matchedValue);
  }

  if (deltas.length < 5) return null;
  const ci = bootstrapMeanCi(deltas, `${seedKey}:${group}:${label}`);
  return {
    group,
    label,
    treated: deltas.length,
    observed_rate: round(avg(treatedValues)),
    matched_rate: round(avg(matchedValues)),
    delta: round(avg(deltas)),
    ci_low: round(ci.low),
    ci_high: round(ci.high),
  };
}

function eraGroups(attempts: Attempt[]): Array<[string, Attempt[]]> {
  const groups = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const label = eraLabel(attempt.year);
    const rows = groups.get(label) ?? [];
    rows.push(attempt);
    groups.set(label, rows);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function eraLabel(year: number) {
  if (year <= 2020) return "2019-2020";
  if (year <= 2022) return "2021-2022";
  if (year <= 2024) return "2023-2024";
  return "2025+";
}

function buildProfiles(matchBundles: Map<MoveKind, MatchBundle>): CounterfactualProfile[] {
  return [...matchBundles.entries()]
    .map(([kind, bundle]) => {
      const definition = definitionForKind(kind);
      const reuse = controlReuseStats([bundle]);
      const balance = balanceStats(bundle);
      const reply = effectForProfile(bundle, "reply");
      const live = effectForProfile(bundle, "live");
      const warm = effectForProfile(bundle, "warm");
      const quiet = effectForProfile(bundle, "quiet");
      const candidates = [
        { label: "Reply landed", delta: reply.observed - reply.matched },
        { label: "Live exchange", delta: live.observed - live.matched },
        { label: "Warm landing", delta: warm.observed - warm.matched },
        { label: "Avoided quiet", delta: quiet.matched - quiet.observed },
      ].sort((a, b) => b.delta - a.delta);
      return {
        kind,
        label: definition?.label ?? kind,
        description: definition?.description ?? "",
        attempts: bundle.treated.length,
        matched_controls: reply.controls,
        reply_rate: round(reply.observed),
        matched_reply_rate: round(reply.matched),
        live_rate: round(live.observed),
        matched_live_rate: round(live.matched),
        warm_rate: round(warm.observed),
        matched_warm_rate: round(warm.matched),
        quiet_rate: round(quiet.observed),
        matched_quiet_rate: round(quiet.matched),
        unique_controls: reuse.unique,
        reused_controls: reuse.reused,
        max_abs_smd: round(balance.maxAbsSmd),
        match_quality: matchQuality(balance.maxAbsSmd),
        best_outcome: candidates[0]?.label ?? "n/a",
        best_delta: round(candidates[0]?.delta ?? 0),
      };
    })
    .filter((profile) => profile.attempts >= MIN_TREATED)
    .sort((a, b) => b.best_delta - a.best_delta || b.attempts - a.attempts);
}

function buildDiagnostics(matchBundles: Map<MoveKind, MatchBundle>): CounterfactualDiagnostic[] {
  return [...matchBundles.entries()]
    .map(([kind, bundle]) => {
      const definition = definitionForKind(kind);
      const reuse = controlReuseStats([bundle]);
      const balance = balanceStats(bundle);
      return {
        kind,
        label: definition?.label ?? kind,
        attempts: bundle.treated.length,
        controls: reuse.controls,
        unique_controls: reuse.unique,
        reused_controls: reuse.reused,
        max_control_reuse: reuse.maxUses,
        max_abs_smd: round(balance.maxAbsSmd),
        worst_feature: balance.worstFeature,
        quality: matchQuality(balance.maxAbsSmd),
      };
    })
    .filter((diagnostic) => diagnostic.attempts >= MIN_TREATED)
    .sort((a, b) => b.max_abs_smd - a.max_abs_smd || b.reused_controls - a.reused_controls);
}

function controlReuseStats(bundles: MatchBundle[]): ControlReuseStats {
  const uses = new Map<number, number>();
  let controls = 0;
  for (const bundle of bundles) {
    for (const matched of bundle.controlsByAttempt.values()) {
      for (const { control } of matched) {
        controls++;
        uses.set(control.id, (uses.get(control.id) ?? 0) + 1);
      }
    }
  }
  const maxUses = Math.max(0, ...uses.values());
  return {
    controls,
    unique: uses.size,
    reused: controls - uses.size,
    maxUses,
  };
}

function balanceStats(bundle: MatchBundle): BalanceStats {
  let maxAbsSmd = 0;
  let worstFeature = "n/a";

  for (let index = 0; index < MATCH_FEATURES.length; index++) {
    const treated: number[] = [];
    const matchedMeans: number[] = [];
    for (const attempt of bundle.treated) {
      const matched = bundle.controlsByAttempt.get(attempt.id) ?? [];
      if (!matched.length) continue;
      treated.push(attempt.vector[index]);
      matchedMeans.push(avg(matched.map(({ control }) => control.vector[index])));
    }
    const smd = Math.abs(standardizedMeanDifference(treated, matchedMeans));
    if (smd > maxAbsSmd) {
      maxAbsSmd = smd;
      worstFeature = MATCH_FEATURES[index];
    }
  }

  return { maxAbsSmd, worstFeature };
}

function matchQuality(maxAbsSmd: number): MatchQuality {
  if (maxAbsSmd <= 0.1) return "good";
  if (maxAbsSmd <= 0.25) return "watch";
  return "weak";
}

function effectForProfile(bundle: MatchBundle, outcome: OutcomeKey) {
  const treated: number[] = [];
  const matchedMeans: number[] = [];
  let controls = 0;
  for (const attempt of bundle.treated) {
    const matched = bundle.controlsByAttempt.get(attempt.id) ?? [];
    if (!matched.length) continue;
    treated.push(attempt.outcomes[outcome] ? 1 : 0);
    matchedMeans.push(avg(matched.map(({ control }) => (control.outcomes[outcome] ? 1 : 0))));
    controls += matched.length;
  }
  return {
    observed: avg(treated),
    matched: avg(matchedMeans),
    controls,
  };
}

function examplesForEffect(bundle: MatchBundle, outcome: OutcomeKey): CounterfactualExample[] {
  return bundle.treated
    .map((attempt) => {
      const controls = bundle.controlsByAttempt.get(attempt.id) ?? [];
      const best = controls.find(({ control }) => !control.outcomes[outcome]) ?? controls[0];
      return best
        ? {
            attempt,
            control: best.control,
            distance: best.distance,
            useful: attempt.outcomes[outcome] && !best.control.outcomes[outcome],
          }
        : null;
    })
    .filter((item): item is { attempt: Attempt; control: Attempt; distance: number; useful: boolean } => item != null)
    .sort((a, b) => Number(b.useful) - Number(a.useful) || b.attempt.messages24h - a.attempt.messages24h || a.distance - b.distance)
    .slice(0, 2)
    .map(({ attempt, control, distance }) => ({
      id: attempt.id,
      ts: attempt.ts,
      ymd: attempt.ymd,
      sender: attempt.sender,
      kind_label: attempt.kindLabel,
      preview: attempt.preview,
      messages_24h: attempt.messages24h,
      reply_seconds: attempt.replySeconds,
      matched_id: control.id,
      matched_ts: control.ts,
      matched_ymd: control.ymd,
      matched_kind_label: control.kindLabel,
      matched_preview: control.preview,
      matched_messages_24h: control.messages24h,
      matched_reply_seconds: control.replySeconds,
      distance: round(distance),
    }));
}

function buildPrefixes(rows: MessageRow[], signals: MessageSignals[]): PrefixSignals {
  const prefixes: PrefixSignals = {
    warmth: [0],
    strain: [0],
    repair: [0],
    play: [0],
    me: [0],
    them: [0],
  };

  for (let index = 0; index < rows.length; index++) {
    prefixes.warmth.push(prefixes.warmth[index] + signals[index].warmth);
    prefixes.strain.push(prefixes.strain[index] + signals[index].strain);
    prefixes.repair.push(prefixes.repair[index] + signals[index].repair);
    prefixes.play.push(prefixes.play[index] + signals[index].play);
    prefixes.me.push(prefixes.me[index] + (rows[index].is_from_me ? 1 : 0));
    prefixes.them.push(prefixes.them[index] + (rows[index].is_from_me ? 0 : 1));
  }

  return prefixes;
}

function signalWindow(prefixes: PrefixSignals, start: number, end: number): MessageSignals {
  return {
    warmth: prefixes.warmth[end] - prefixes.warmth[start],
    strain: prefixes.strain[end] - prefixes.strain[start],
    repair: prefixes.repair[end] - prefixes.repair[start],
    play: prefixes.play[end] - prefixes.play[start],
  };
}

function senderWindow(prefixes: PrefixSignals, start: number, end: number) {
  return {
    me: prefixes.me[end] - prefixes.me[start],
    them: prefixes.them[end] - prefixes.them[start],
  };
}

function signalForMessage(row: MessageRow): MessageSignals {
  const text = row.text ?? "";
  return {
    warmth: SIGNAL_LEXICONS.warmth.test(text) ? 1 : 0,
    strain: SIGNAL_LEXICONS.strain.test(text) ? 1 : 0,
    repair: SIGNAL_LEXICONS.repair.test(text) ? 1 : 0,
    play: SIGNAL_LEXICONS.play.test(text) ? 1 : 0,
  };
}

function definitionForKind(kind: MoveKind) {
  return MOVE_META[kind];
}

function firstReplySeconds(rows: MessageRow[], start: number, end: number, sender: Sender) {
  for (let index = start + 1; index < end; index++) {
    if (senderFor(rows[index]) !== sender) return rows[index].ts - rows[start].ts;
  }
  return null;
}

function countHandoffs(rows: MessageRow[], start: number, end: number) {
  let handoffs = 0;
  let last = senderFor(rows[start]);
  for (let index = start + 1; index < end; index++) {
    const sender = senderFor(rows[index]);
    if (sender !== last) handoffs++;
    last = sender;
  }
  return handoffs;
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me ? "Me" : "Them";
}

function senderMatches(sender: Sender, filter: MessageScope["sender"]) {
  return filter === "both" || (filter === "me" ? sender === "Me" : sender === "Them");
}

function bucketGap(seconds: number) {
  if (seconds < DAY_SECONDS) return "6h-1d";
  if (seconds < 3 * DAY_SECONDS) return "1d-3d";
  if (seconds < 10 * DAY_SECONDS) return "3d-10d";
  return "10d+";
}

function lowerBound(values: number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(values: number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function vectorDistance(left: number[], right: number[]) {
  const weights = [1.3, 0.8, 0.35, 0.35, 0.9, 1.1, 1.25, 1.05, 0.65, 0.9];
  let total = 0;
  for (let index = 0; index < left.length; index++) {
    total += ((left[index] - right[index]) * weights[index]) ** 2;
  }
  return Math.sqrt(total);
}

function zForPairedDeltas(values: number[]) {
  if (values.length < 2) return 0;
  const se = standardDeviation(values) / Math.sqrt(values.length);
  if (se <= 0.0001) return 0;
  return Math.abs(avg(values) / se);
}

function bootstrapMeanCi(values: number[], seedKey: string) {
  if (!values.length) return { low: 0, high: 0 };
  if (values.length === 1) return { low: values[0], high: values[0] };
  const random = seededRandom(hashSeed(seedKey));
  const estimates: number[] = [];
  const iterations = 400;
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) {
      total += values[Math.floor(random() * values.length)];
    }
    estimates.push(total / values.length);
  }
  estimates.sort((a, b) => a - b);
  return {
    low: percentile(estimates, 0.025),
    high: percentile(estimates, 0.975),
  };
}

function standardizedMeanDifference(treated: number[], matched: number[]) {
  if (!treated.length || !matched.length) return 0;
  const diff = avg(treated) - avg(matched);
  const variance = (varianceOf(treated) + varianceOf(matched)) / 2;
  if (variance <= 0.000001) return diff === 0 ? 0 : diff / 0.001;
  return diff / Math.sqrt(variance);
}

function replyDelta(treatedReplies: number[], controlReplies: number[]) {
  const treatedMedian = median(treatedReplies);
  const controlMedian = median(controlReplies);
  if (treatedMedian == null || controlMedian == null) return null;
  return Math.round(treatedMedian - controlMedian);
}

function scoreEffect(effect: CounterfactualEffect) {
  return effect.delta * Math.log1p(effect.treated) * Math.min(effect.z_score, 4);
}

function cleanPreview(text: string | null) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function safeRate(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  return Math.sqrt(varianceOf(values));
}

function varianceOf(values: number[]) {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
}

function percentile(sortedValues: number[], p: number) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(p * (sortedValues.length - 1))));
  return sortedValues[index];
}

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let state = seed || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
