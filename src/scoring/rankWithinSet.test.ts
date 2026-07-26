import { describe, expect, it } from "vitest";
import type { QualityResult, RankableCandidate, RawMetric } from "../domain/types";
import { rankWithinSet } from "./rankWithinSet";

const metric = (value: number | null, reliability = 1): RawMetric => ({ value, reliability });

function quality(overrides: Partial<Record<keyof QualityResult["metrics"], RawMetric>> = {}): QualityResult {
  return {
    metrics: {
      textureSharpness: overrides.textureSharpness ?? metric(1),
      limbSharpness: overrides.limbSharpness ?? metric(1),
      effectiveResolution: overrides.effectiveResolution ?? metric(100),
      motionBlurPenalty: overrides.motionBlurPenalty ?? metric(0.2),
      clippingPenalty: overrides.clippingPenalty ?? metric(0.1),
      noisePenalty: overrides.noisePenalty ?? metric(0.1),
      hazePenalty: overrides.hazePenalty ?? metric(0.2),
    },
    sampledSurfacePixels: 100,
    sampledLimbProfiles: 50,
    effectiveSourcePixelDiameter: 100,
  };
}

function candidate(assetId: string, ingestIndex: number, result: QualityResult): RankableCandidate {
  return { assetId, ingestIndex, quality: result };
}

describe("rankWithinSet", () => {
  it("uses winsorized batch-relative normalization with neutral missing values", () => {
    const ranked = rankWithinSet([
      candidate("low", 0, quality({ textureSharpness: metric(0) })),
      candidate("missing", 1, quality({ textureSharpness: metric(null, 0) })),
      candidate("high", 2, quality({ textureSharpness: metric(10) })),
    ]);
    expect(ranked.map((entry) => entry.assetId)).toEqual(["high", "missing", "low"]);
    expect(ranked.find((entry) => entry.assetId === "missing")?.normalized.textureSharpness).toBe(0.5);
  });

  it("reverses penalty metrics and produces significant reasons", () => {
    const ranked = rankWithinSet([
      candidate("clean", 0, quality({
        motionBlurPenalty: metric(0),
        clippingPenalty: metric(0),
        noisePenalty: metric(0),
        hazePenalty: metric(0),
      })),
      candidate("damaged", 1, quality({
        motionBlurPenalty: metric(1),
        clippingPenalty: metric(1),
        noisePenalty: metric(1),
        hazePenalty: metric(1),
      })),
    ]);
    expect(ranked[0]?.assetId).toBe("clean");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
    expect(ranked[1]?.reasons.some((reason) => reason === "Directional blur" || reason === "Clipped highlights"))
      .toBe(true);
  });

  it("uses a stable ingest-order tie break and neutralizes zero ranges", () => {
    const input = [
      candidate("later", 9, quality()),
      candidate("first", 1, quality()),
      candidate("middle", 4, quality()),
    ];
    const firstRun = rankWithinSet(input);
    const secondRun = rankWithinSet(input);
    expect(firstRun).toEqual(secondRun);
    expect(firstRun.map((entry) => entry.assetId)).toEqual(["first", "middle", "later"]);
    expect(firstRun[0]?.score).toBeCloseTo(50, 12);
    expect(firstRun[0]?.normalized.textureSharpness).toBe(0.5);
  });

  it("blends unreliable observations toward neutral", () => {
    const ranked = rankWithinSet([
      candidate("low-reliability", 0, quality({ textureSharpness: metric(10, 0.2) })),
      candidate("reliable-low", 1, quality({ textureSharpness: metric(0, 1) })),
    ]);
    expect(ranked[0]?.normalized.textureSharpness).toBeCloseTo(0.6, 10);
    expect(ranked[1]?.normalized.textureSharpness).toBe(0);
  });
});
