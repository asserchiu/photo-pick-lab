import { describe, expect, it } from "vitest";
import { isValidNormalizedCircle, normalizedCircleToPixels } from "../../imaging/geometry";
import { syntheticMoon } from "../../test/fixtures";
import { detectMoon } from "./detectMoon";

function brightCentroid(data: Float32Array, width: number): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 1) {
    if ((data[index] ?? 0) < 100) continue;
    sumX += index % width + 0.5;
    sumY += Math.floor(index / width) + 0.5;
    count += 1;
  }
  return { x: sumX / count, y: sumY / count };
}

describe("moon detection", () => {
  it("uses the crescent outer arc center instead of its brightness centroid", () => {
    const fixture = syntheticMoon({ centerX: 61, centerY: 47, radius: 24, crescentCut: 0.25 });
    const detection = detectMoon(fixture.luminance, fixture.width, fixture.height);
    expect(detection).not.toBeNull();
    if (detection === null) return;
    const detected = normalizedCircleToPixels(detection.circle, fixture);
    expect(detected).not.toBeNull();
    if (detected === null) return;
    const centroid = brightCentroid(fixture.luminance, fixture.width);
    const fitError = Math.hypot(detected.centerX - fixture.circle.centerX, detected.centerY - fixture.circle.centerY);
    const centroidError = Math.hypot(centroid.x - fixture.circle.centerX, centroid.y - fixture.circle.centerY);
    expect(fitError).toBeLessThan(3);
    expect(fitError).toBeLessThan(centroidError * 0.35);
    expect(detection.arcCoverage).toBeGreaterThan(0.25);
  });

  it("does not reject a strongly off-center moon", () => {
    const fixture = syntheticMoon({ centerX: 22, centerY: 27, radius: 14 });
    const detection = detectMoon(fixture.luminance, fixture.width, fixture.height);
    expect(detection).not.toBeNull();
    if (detection === null) return;
    const detected = normalizedCircleToPixels(detection.circle, fixture);
    expect(detected?.centerX).toBeCloseTo(22, 0);
    expect(detected?.centerY).toBeCloseTo(27, 0);
    expect(detected?.radius).toBeCloseTo(14, 0);
  });

  it("never returns an off-image center for a border-clipped moon", () => {
    const fixture = syntheticMoon({ centerX: -5, centerY: 47, radius: 24 });
    const detection = detectMoon(fixture.luminance, fixture.width, fixture.height);

    expect(detection === null || isValidNormalizedCircle(detection.circle)).toBe(true);
  });

  it("returns the same diagnostics for repeated analysis", () => {
    const fixture = syntheticMoon();
    expect(detectMoon(fixture.luminance, fixture.width, fixture.height)).toEqual(
      detectMoon(fixture.luminance, fixture.width, fixture.height),
    );
  });
});
