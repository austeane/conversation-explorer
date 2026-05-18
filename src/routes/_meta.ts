import type { MethodKind } from "~/lib/method";

export type Mode =
  | "overview"
  | "browse"
  | "language"
  | "dynamics"
  | "connection"
  | "topics"
  | "sensitive";

export type InsightFraming = "changed" | "repeats" | "helps" | "missed" | "discuss";

export type RouteMeta = {
  path: string;
  label: string;
  eyebrow: string;
  description: string;
  mode: Mode;
  method: MethodKind;
  sensitive?: boolean;
  addedRoute?: boolean;
  insightFraming?: InsightFraming;
};

export const MODES: Array<{ id: Mode; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "Start with summary, change, and method context." },
  { id: "browse", label: "Browse", description: "Move from claims into messages, segments, and artifacts." },
  { id: "language", label: "Language", description: "Shared vocabulary, repeated phrases, and callbacks." },
  { id: "dynamics", label: "Dynamics", description: "Tempo, reply moves, mirroring, and signal flow." },
  { id: "connection", label: "Connection", description: "Repair, bids, open loops, affect, and forecasts." },
  { id: "topics", label: "Topics", description: "Semantic maps, lifecycles, recurrence, and rhythms." },
  { id: "sensitive", label: "Sensitive", description: "Intimacy surfaces kept out of general discovery." },
];

export const ROUTES: RouteMeta[] = [
  {
    path: "/insights",
    label: "Insights",
    eyebrow: "So what",
    description: "A reflective feed organized by change, repetition, repair, missed signals, and discussion prompts.",
    mode: "overview",
    method: "observational",
    addedRoute: true,
    insightFraming: "changed",
  },
  {
    path: "/",
    label: "Stats",
    eyebrow: "Baseline",
    description: "Totals, cadence, top words, top emoji, and the archive span.",
    mode: "overview",
    method: "descriptive",
  },
  {
    path: "/timeline",
    label: "Timeline",
    eyebrow: "Cadence",
    description: "Monthly volume, daily drill-downs, and hour by weekday heatmap.",
    mode: "overview",
    method: "descriptive",
  },
  {
    path: "/turning-points",
    label: "Turning points",
    eyebrow: "Inflections",
    description: "Months where categories and topics break from their recent baseline.",
    mode: "overview",
    method: "observational",
    insightFraming: "changed",
  },
  {
    path: "/seasons",
    label: "Seasons",
    eyebrow: "Phases",
    description: "Conversation eras inferred from monthly category mixtures.",
    mode: "overview",
    method: "heuristic",
    insightFraming: "changed",
  },
  {
    path: "/outliers",
    label: "Outliers",
    eyebrow: "Anomaly scan",
    description: "Eventful days across volume, affect, novelty, tempo, and topic entropy.",
    mode: "overview",
    method: "heuristic",
    insightFraming: "changed",
  },
  {
    path: "/comparisons",
    label: "Comparisons",
    eyebrow: "Audience",
    description: "How Me messages Them compared with other high-volume one-on-one chats.",
    mode: "overview",
    method: "observational",
  },
  {
    path: "/methods",
    label: "Methods",
    eyebrow: "Trust",
    description: "Route methods, data freshness, eval availability, caveats, and migration status.",
    mode: "overview",
    method: "descriptive",
    addedRoute: true,
  },
  {
    path: "/browse",
    label: "Browse",
    eyebrow: "Archive",
    description: "Full-text search, date jumps, filters, and message-level evidence.",
    mode: "browse",
    method: "descriptive",
  },
  {
    path: "/ask",
    label: "Ask",
    eyebrow: "Retrieval",
    description: "Natural-language archive search with cited segment and message matches.",
    mode: "browse",
    method: "descriptive",
    addedRoute: true,
  },
  {
    path: "/attachments",
    label: "Attachments",
    eyebrow: "Media",
    description: "Locally cached image attachments from the thread.",
    mode: "browse",
    method: "descriptive",
  },
  {
    path: "/conversations",
    label: "Conversations",
    eyebrow: "Segments",
    description: "Topic space, categories, segment browser, and category transitions.",
    mode: "browse",
    method: "heuristic",
  },
  {
    path: "/capsules",
    label: "Capsules",
    eyebrow: "Reading path",
    description: "A diverse set of high-salience episodes selected for revisiting.",
    mode: "browse",
    method: "heuristic",
  },
  {
    path: "/vocabulary",
    label: "Vocabulary",
    eyebrow: "Words",
    description: "Distinctive and shared word use with lift against an English baseline.",
    mode: "language",
    method: "observational",
  },
  {
    path: "/phrases",
    label: "Phrases",
    eyebrow: "N-grams",
    description: "Collocations, repeated language, distinctive phrases, and sentence stats.",
    mode: "language",
    method: "observational",
  },
  {
    path: "/entrainment",
    label: "Entrainment",
    eyebrow: "Convergence",
    description: "Vocabulary adoption, shared words, and language crossover.",
    mode: "language",
    method: "observational",
    insightFraming: "repeats",
  },
  {
    path: "/echoes",
    label: "Echoes",
    eyebrow: "Callbacks",
    description: "Private phrases that disappear, return later, and become shared callbacks.",
    mode: "language",
    method: "heuristic",
    insightFraming: "repeats",
  },
  {
    path: "/dynamics",
    label: "Dynamics",
    eyebrow: "Tempo",
    description: "Reply speed, restarts after silence, long lulls, and sender runs.",
    mode: "dynamics",
    method: "descriptive",
  },
  {
    path: "/bids",
    label: "Bids",
    eyebrow: "Attention",
    description: "Questions, invitations, care checks, repairs, and response timing.",
    mode: "dynamics",
    method: "heuristic",
    insightFraming: "missed",
  },
  {
    path: "/mirrors",
    label: "Mirrors",
    eyebrow: "Adaptation",
    description: "Whether replies mirror length, affect, emoji, objects, questions, and repair.",
    mode: "dynamics",
    method: "observational",
  },
  {
    path: "/resonance",
    label: "Resonance",
    eyebrow: "Replies",
    description: "What each source move tends to evoke from the next opposite-person reply.",
    mode: "dynamics",
    method: "observational",
  },
  {
    path: "/choreography",
    label: "Choreography",
    eyebrow: "Sequences",
    description: "Recurring three-move conversational paths and transition lift.",
    mode: "dynamics",
    method: "heuristic",
    insightFraming: "repeats",
  },
  {
    path: "/information",
    label: "Information",
    eyebrow: "Channel",
    description: "Reply entropy, mutual information, and high-information cues.",
    mode: "dynamics",
    method: "observational",
  },
  {
    path: "/gestures",
    label: "Gestures",
    eyebrow: "Backchannels",
    description: "Tapbacks, threaded replies, games, links, media, and message effects.",
    mode: "dynamics",
    method: "descriptive",
  },
  {
    path: "/repair",
    label: "Repair",
    eyebrow: "Recovery",
    description: "Strain episodes, recovery landings, first moves, and still-open loops.",
    mode: "connection",
    method: "heuristic",
    insightFraming: "helps",
  },
  {
    path: "/open-loops",
    label: "Open loops",
    eyebrow: "Obligations",
    description: "Questions, repairs, invitations, and tasks that close, hang, or reopen.",
    mode: "connection",
    method: "heuristic",
    insightFraming: "missed",
  },
  {
    path: "/ignition",
    label: "Ignition",
    eyebrow: "Momentum",
    description: "Which first messages after silence restart live exchange.",
    mode: "connection",
    method: "observational",
    insightFraming: "helps",
  },
  {
    path: "/counterfactuals",
    label: "Counterfactuals",
    eyebrow: "What if",
    description: "Matched observational lift after different silence reopeners.",
    mode: "connection",
    method: "observational",
    insightFraming: "helps",
  },
  {
    path: "/forecasts",
    label: "Forecasts",
    eyebrow: "Prediction",
    description: "Holdout-scored next-48-hour conversation state models.",
    mode: "connection",
    method: "predictive",
  },
  {
    path: "/weather",
    label: "Weather",
    eyebrow: "Affect",
    description: "Warmth, strain, repair, gratitude, care, humor, and support after stress.",
    mode: "connection",
    method: "heuristic",
    insightFraming: "helps",
  },
  {
    path: "/rituals",
    label: "Rituals",
    eyebrow: "Routines",
    description: "Habitual clocks, named routines, phrase anchors, and silence reopeners.",
    mode: "connection",
    method: "heuristic",
    insightFraming: "repeats",
  },
  {
    path: "/omens",
    label: "Omens",
    eyebrow: "Precursors",
    description: "Language patterns before surges, quiet spells, storms, and repair weeks.",
    mode: "connection",
    method: "observational",
  },
  {
    path: "/atlas",
    label: "Atlas",
    eyebrow: "Map",
    description: "A UMAP map of semantic neighborhoods, topic islands, and bridges.",
    mode: "topics",
    method: "heuristic",
  },
  {
    path: "/lifecycles",
    label: "Lifecycles",
    eyebrow: "Topic ecology",
    description: "Topic birth, dormancy, returns, fading, and evergreen subjects.",
    mode: "topics",
    method: "heuristic",
    insightFraming: "changed",
  },
  {
    path: "/constellations",
    label: "Constellations",
    eyebrow: "Graph",
    description: "Topic-transition graph communities, corridors, and bridge subjects.",
    mode: "topics",
    method: "heuristic",
  },
  {
    path: "/gravity",
    label: "Gravity",
    eyebrow: "Ownership",
    description: "Who starts topics, who sustains them, and where handoffs pull.",
    mode: "topics",
    method: "observational",
  },
  {
    path: "/recurrence",
    label: "Recurrence",
    eyebrow: "Returns",
    description: "Distant weeks that fall back into similar conversation states.",
    mode: "topics",
    method: "heuristic",
    insightFraming: "repeats",
  },
  {
    path: "/attractors",
    label: "Attractors",
    eyebrow: "State-space",
    description: "Weekly conversation basins, transitions, and escapes.",
    mode: "topics",
    method: "heuristic",
    insightFraming: "repeats",
  },
  {
    path: "/arcs",
    label: "Arcs",
    eyebrow: "Motifs",
    description: "Recurring five-day shapes and transitions between mini-stories.",
    mode: "topics",
    method: "heuristic",
  },
  {
    path: "/rhythms",
    label: "Rhythms",
    eyebrow: "Cycles",
    description: "Periodograms, lead-lag coupling, and phase-locked windows.",
    mode: "topics",
    method: "observational",
    insightFraming: "repeats",
  },
  {
    path: "/desire",
    label: "Desire",
    eyebrow: "Intimacy",
    description: "Sexual texting evolution, modes, direction, and episodes.",
    mode: "sensitive",
    method: "heuristic",
    sensitive: true,
  },
  {
    path: "/desire-patterns",
    label: "Patterns",
    eyebrow: "Taxonomy",
    description: "Types of sexual texting, kink motifs, and representative excerpts.",
    mode: "sensitive",
    method: "heuristic",
    sensitive: true,
    insightFraming: "repeats",
  },
  {
    path: "/desire-evolution",
    label: "Evolution",
    eyebrow: "Change",
    description: "How sexual texting modes, motifs, and reciprocal sessions shift by year.",
    mode: "sensitive",
    method: "heuristic",
    sensitive: true,
    insightFraming: "changed",
  },
  {
    path: "/desire-sessions",
    label: "Sessions",
    eyebrow: "Back and forth",
    description: "Longest horny sessions by opposite-person replies and full back-and-forth cycles.",
    mode: "sensitive",
    method: "heuristic",
    sensitive: true,
    insightFraming: "repeats",
  },
];

export function routesForMode(mode: Mode) {
  return ROUTES.filter((route) => route.mode === mode);
}

export function routeForPath(pathname: string) {
  return ROUTES.find((route) => route.path === pathname || (route.path !== "/" && pathname.startsWith(`${route.path}/`)));
}

export function modeForPath(pathname: string): Mode {
  return routeForPath(pathname)?.mode ?? "overview";
}

export function primaryRouteForMode(mode: Mode) {
  return routesForMode(mode)[0] ?? ROUTES[0];
}
