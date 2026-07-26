import { describe, expect, it } from "vitest";
import type { Point2D } from "../../domain/types";
import { fitCircleRobust } from "./circleFit";

function arcPoints(
  centerX: number,
  centerY: number,
  radius: number,
  start: number,
  end: number,
  count: number,
): Point2D[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = start + index / Math.max(1, count - 1) * (end - start);
    const jitter = ((index * 17) % 7 - 3) * 0.025;
    return {
      x: centerX + (radius + jitter) * Math.cos(angle),
      y: centerY + (radius + jitter) * Math.sin(angle),
    };
  });
}

function outliers(count: number): Point2D[] {
  return Array.from({ length: count }, (_, index) => ({
    x: (index * 37 % 131) + 3,
    y: (index * 61 % 97) + 2,
  }));
}

describe("deterministic robust circle fit", () => {
  it("fits a complete circle despite outliers", () => {
    const points = [...arcPoints(63, 41, 24, 0, Math.PI * 2, 96), ...outliers(40)];
    const fit = fitCircleRobust(points, {
      seed: 42,
      iterations: 900,
      minimumRadius: 10,
      maximumRadius: 40,
      inlierThreshold: 0.7,
    });
    expect(fit).not.toBeNull();
    expect(fit?.circle.centerX).toBeCloseTo(63, 1);
    expect(fit?.circle.centerY).toBeCloseTo(41, 1);
    expect(fit?.circle.radius).toBeCloseTo(24, 1);
    expect(fit?.inlierCount).toBeGreaterThanOrEqual(90);
    expect(fit?.arcCoverage).toBeGreaterThan(0.8);
  });

  it("recovers a geometric center from a partial arc", () => {
    const points = [
      ...arcPoints(80, 55, 31, -0.75, 1.25, 70),
      ...outliers(18),
    ];
    const fit = fitCircleRobust(points, {
      seed: 7,
      iterations: 800,
      minimumRadius: 20,
      maximumRadius: 45,
      inlierThreshold: 0.8,
    });
    expect(fit).not.toBeNull();
    expect(fit?.circle.centerX).toBeCloseTo(80, 0);
    expect(fit?.circle.centerY).toBeCloseTo(55, 0);
    expect(fit?.circle.radius).toBeCloseTo(31, 0);
    expect(fit?.arcCoverage).toBeGreaterThan(0.25);
  });

  it("is independent of input ordering and rejects collinear points", () => {
    const points = [...arcPoints(20, 30, 12, 0, Math.PI * 2, 48), ...outliers(10)];
    const options = { seed: 99, iterations: 500, minimumRadius: 8, maximumRadius: 20 };
    expect(fitCircleRobust(points, options)).toEqual(fitCircleRobust([...points].reverse(), options));
    expect(fitCircleRobust(Array.from({ length: 12 }, (_, index) => ({ x: index, y: index * 2 })))).toBeNull();
  });
});
