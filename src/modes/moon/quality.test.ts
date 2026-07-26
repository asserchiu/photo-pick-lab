import { describe, expect, it } from "vitest";
import { addDeterministicNoise, boxBlur, syntheticMoon } from "../../test/fixtures";
import { evaluateMoonQuality } from "./quality";

function value(metric: { value: number | null }): number {
  if (metric.value === null) throw new Error("expected measured metric");
  return metric.value;
}

describe("moon quality metrics", () => {
  it("decreases texture and limb sharpness as blur increases", () => {
    const fixture = syntheticMoon({ texture: 30 });
    const sharp = evaluateMoonQuality(fixture.luminance, fixture.width, fixture.height, fixture.circle);
    const blurredData = boxBlur(fixture.luminance, fixture.width, fixture.height, 3);
    const blurred = evaluateMoonQuality(blurredData, fixture.width, fixture.height, fixture.circle);
    expect(value(blurred.metrics.textureSharpness)).toBeLessThan(value(sharp.metrics.textureSharpness));
    expect(value(blurred.metrics.limbSharpness)).toBeLessThan(value(sharp.metrics.limbSharpness));
  });

  it("raises clipping and noise penalties in the expected direction", () => {
    const exposed = syntheticMoon({ surfaceLevel: 220, texture: 0 });
    const clipped = syntheticMoon({ surfaceLevel: 255, texture: 0 });
    const exposedQuality = evaluateMoonQuality(exposed.luminance, exposed.width, exposed.height, exposed.circle);
    const clippedQuality = evaluateMoonQuality(clipped.luminance, clipped.width, clipped.height, clipped.circle);
    expect(value(clippedQuality.metrics.clippingPenalty)).toBeGreaterThan(
      value(exposedQuality.metrics.clippingPenalty),
    );

    const noisyData = addDeterministicNoise(exposed.luminance, 24, 19);
    const noisyQuality = evaluateMoonQuality(noisyData, exposed.width, exposed.height, exposed.circle);
    expect(value(noisyQuality.metrics.noisePenalty)).toBeGreaterThan(
      value(exposedQuality.metrics.noisePenalty),
    );
  });

  it("detects directional blur and reports source-pixel diameter", () => {
    const fixture = syntheticMoon({ texture: 30 });
    const baseline = evaluateMoonQuality(fixture.luminance, fixture.width, fixture.height, fixture.circle, {
      sourceSize: { width: fixture.width * 4, height: fixture.height * 4 },
    });
    const motionData = boxBlur(fixture.luminance, fixture.width, fixture.height, 4, true);
    const motion = evaluateMoonQuality(motionData, fixture.width, fixture.height, fixture.circle);
    expect(value(motion.metrics.motionBlurPenalty)).toBeGreaterThan(
      value(baseline.metrics.motionBlurPenalty),
    );
    expect(baseline.effectiveSourcePixelDiameter).toBeCloseTo(fixture.circle.radius * 8, 8);
  });

  it("uses null rather than zero when a metric cannot be measured", () => {
    const result = evaluateMoonQuality(new Float32Array(), 0, 0, { centerX: 0, centerY: 0, radius: 0 });
    expect(result.metrics.textureSharpness).toEqual({ value: null, reliability: 0 });
    expect(result.metrics.limbSharpness.value).toBeNull();
  });
});
