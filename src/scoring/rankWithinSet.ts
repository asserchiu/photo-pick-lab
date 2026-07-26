import type {
  NormalizedQualityFactors,
  RankableCandidate,
  RankedCandidate,
  RawMetric,
} from "../domain/types";
import { percentile } from "../imaging/primitives";

export const QUALITY_WEIGHTS = {
  textureSharpness: 0.3,
  limbSharpness: 0.22,
  effectiveResolution: 0.13,
  motionBlur: 0.1,
  clipping: 0.1,
  noise: 0.08,
  haze: 0.07,
} as const;

type MetricName = keyof NormalizedQualityFactors;

interface Scale {
  low: number;
  high: number;
  degenerate: boolean;
}

const metricOrder: readonly MetricName[] = [
  "textureSharpness",
  "limbSharpness",
  "effectiveResolution",
  "motionBlur",
  "clipping",
  "noise",
  "haze",
];

function rawMetric(candidate: RankableCandidate, name: MetricName): RawMetric {
  switch (name) {
    case "textureSharpness": return candidate.quality.metrics.textureSharpness;
    case "limbSharpness": return candidate.quality.metrics.limbSharpness;
    case "effectiveResolution": return candidate.quality.metrics.effectiveResolution;
    case "motionBlur": return candidate.quality.metrics.motionBlurPenalty;
    case "clipping": return candidate.quality.metrics.clippingPenalty;
    case "noise": return candidate.quality.metrics.noisePenalty;
    case "haze": return candidate.quality.metrics.hazePenalty;
  }
}

function makeScale(candidates: readonly RankableCandidate[], name: MetricName): Scale {
  const values: number[] = [];
  for (const candidate of candidates) {
    const value = rawMetric(candidate, name).value;
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length < 2) return { low: 0, high: 0, degenerate: true };
  const low = percentile(values, 0.05) ?? 0;
  const high = percentile(values, 0.95) ?? low;
  const tolerance = Math.max(1e-9, Math.max(Math.abs(low), Math.abs(high)) * 1e-9);
  return { low, high, degenerate: high - low <= tolerance };
}

function normalizeMetric(metric: RawMetric, scale: Scale, penalty: boolean): number {
  if (metric.value === null || !Number.isFinite(metric.value) || scale.degenerate) return 0.5;
  const clipped = Math.min(scale.high, Math.max(scale.low, metric.value));
  const normalized = (clipped - scale.low) / (scale.high - scale.low);
  const qualityDirection = penalty ? 1 - normalized : normalized;
  const reliability = Math.min(1, Math.max(0, metric.reliability));
  return 0.5 + (qualityDirection - 0.5) * reliability;
}

function weightFor(name: MetricName): number {
  return QUALITY_WEIGHTS[name];
}

const reasonLabels: Record<MetricName, { positive: string; negative: string }> = {
  textureSharpness: { positive: "Strong surface texture", negative: "Soft surface texture" },
  limbSharpness: { positive: "Crisp lunar limb", negative: "Soft lunar limb" },
  effectiveResolution: { positive: "High source-pixel diameter", negative: "Low source-pixel diameter" },
  motionBlur: { positive: "Low directional blur", negative: "Directional blur" },
  clipping: { positive: "Highlights retain detail", negative: "Clipped highlights" },
  noise: { positive: "Low visible noise", negative: "Visible noise" },
  haze: { positive: "Clear local contrast", negative: "Low-contrast haze" },
};

function reasonsFor(normalized: NormalizedQualityFactors): string[] {
  const contributions = metricOrder.map((name, order) => ({
    name,
    order,
    delta: weightFor(name) * (normalized[name] - 0.5),
  }));
  contributions.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.order - right.order);
  const reasons: string[] = [];
  for (const contribution of contributions) {
    if (reasons.length >= 3 || Math.abs(contribution.delta) < 0.02) break;
    const labels = reasonLabels[contribution.name];
    reasons.push(contribution.delta > 0 ? labels.positive : labels.negative);
  }
  return reasons.length > 0 ? reasons : ["No decisive quality difference"];
}

export function rankWithinSet(candidates: readonly RankableCandidate[]): RankedCandidate[] {
  const scales = new Map<MetricName, Scale>();
  for (const name of metricOrder) scales.set(name, makeScale(candidates, name));

  const ranked = candidates.map((candidate): RankedCandidate => {
    const normalized: NormalizedQualityFactors = {
      textureSharpness: normalizeMetric(
        candidate.quality.metrics.textureSharpness,
        scales.get("textureSharpness") ?? { low: 0, high: 0, degenerate: true },
        false,
      ),
      limbSharpness: normalizeMetric(
        candidate.quality.metrics.limbSharpness,
        scales.get("limbSharpness") ?? { low: 0, high: 0, degenerate: true },
        false,
      ),
      effectiveResolution: normalizeMetric(
        candidate.quality.metrics.effectiveResolution,
        scales.get("effectiveResolution") ?? { low: 0, high: 0, degenerate: true },
        false,
      ),
      motionBlur: normalizeMetric(
        candidate.quality.metrics.motionBlurPenalty,
        scales.get("motionBlur") ?? { low: 0, high: 0, degenerate: true },
        true,
      ),
      clipping: normalizeMetric(
        candidate.quality.metrics.clippingPenalty,
        scales.get("clipping") ?? { low: 0, high: 0, degenerate: true },
        true,
      ),
      noise: normalizeMetric(
        candidate.quality.metrics.noisePenalty,
        scales.get("noise") ?? { low: 0, high: 0, degenerate: true },
        true,
      ),
      haze: normalizeMetric(
        candidate.quality.metrics.hazePenalty,
        scales.get("haze") ?? { low: 0, high: 0, degenerate: true },
        true,
      ),
    };
    let total = 0;
    for (const name of metricOrder) total += normalized[name] * weightFor(name);
    return {
      ...candidate,
      score: total * 100,
      normalized,
      reasons: reasonsFor(normalized),
    };
  });

  ranked.sort((left, right) =>
    right.score - left.score ||
    right.normalized.textureSharpness - left.normalized.textureSharpness ||
    right.normalized.limbSharpness - left.normalized.limbSharpness ||
    right.normalized.effectiveResolution - left.normalized.effectiveResolution ||
    left.ingestIndex - right.ingestIndex,
  );
  return ranked;
}
