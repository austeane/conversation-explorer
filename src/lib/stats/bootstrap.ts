export type BootstrapCi = {
  low: number;
  high: number;
};

export type BootstrapAucResult = {
  auc: number;
  ci: BootstrapCi;
};

export function bootstrapAUC(
  scores: number[],
  labels: Array<boolean | number>,
  n = 500,
  blockSize = 14,
): BootstrapAucResult {
  const numericLabels = labels.map((label) => (label === true || label === 1 ? 1 : 0));
  const point = aucScore(scores, numericLabels);
  if (scores.length === 0) return { auc: point, ci: { low: point, high: point } };

  const random = mulberry32(seedFor(scores, numericLabels));
  const bootstraps: number[] = [];
  for (let sample = 0; sample < n; sample += 1) {
    const resampledScores: number[] = [];
    const resampledLabels: number[] = [];
    while (resampledScores.length < scores.length) {
      const start = Math.floor(random() * scores.length);
      for (let offset = 0; offset < blockSize && resampledScores.length < scores.length; offset += 1) {
        const index = (start + offset) % scores.length;
        resampledScores.push(scores[index]);
        resampledLabels.push(numericLabels[index]);
      }
    }
    bootstraps.push(aucScore(resampledScores, resampledLabels));
  }

  bootstraps.sort((a, b) => a - b);
  return {
    auc: point,
    ci: {
      low: quantileSorted(bootstraps, 0.025),
      high: quantileSorted(bootstraps, 0.975),
    },
  };
}

function aucScore(scores: number[], labels: number[]) {
  const positives = labels.filter(Boolean).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  const paired = scores
    .map((score, index) => ({ score, label: labels[index] }))
    .sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let index = 0; index < paired.length; index += 1) {
    if (paired[index].label === 1) rankSum += index + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function seedFor(scores: number[], labels: number[]) {
  let seed = 0x811c9dc5;
  for (let index = 0; index < scores.length; index += 1) {
    seed ^= Math.round(scores[index] * 1_000_000) + labels[index] * 17 + index;
    seed = Math.imul(seed, 0x01000193);
  }
  return seed >>> 0;
}

function mulberry32(seed: number) {
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileSorted(values: number[], q: number) {
  if (values.length === 0) return 0.5;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * q)));
  return values[index];
}
