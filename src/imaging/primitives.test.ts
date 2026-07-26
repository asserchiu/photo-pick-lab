import { describe, expect, it } from "vitest";
import {
  closeBinary,
  connectedComponents,
  histogram,
  medianAbsoluteDeviation,
  percentile,
  rgbaToLuminance,
  sobel,
} from "./primitives";

describe("imaging primitives", () => {
  it("converts RGBA and computes robust distribution values", () => {
    const luminance = rgbaToLuminance(new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ]), 3, 1);
    expect(luminance[0]).toBeCloseTo(54.213, 2);
    expect(luminance[1]).toBeCloseTo(182.376, 2);
    expect(percentile(luminance, 0.5)).toBeCloseTo(54.213, 2);
    expect(medianAbsoluteDeviation([1, 2, 2, 3, 100])).toBe(1);
    expect(histogram(luminance).reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  it("finds component geometry and closes a one-pixel hole", () => {
    const width = 7;
    const height = 7;
    const mask = new Uint8Array(width * height);
    for (let y = 1; y <= 5; y += 1) {
      for (let x = 1; x <= 5; x += 1) mask[y * width + x] = 1;
    }
    mask[3 * width + 3] = 0;
    const closed = closeBinary(mask, width, height);
    const components = connectedComponents(closed, width, height);
    expect(components).toHaveLength(1);
    expect(components[0]?.area).toBe(25);
    expect(components[0]?.bbox).toEqual({ x: 1, y: 1, width: 5, height: 5 });
    expect(components[0]?.centroid).toEqual({ x: 3, y: 3 });
    expect(components[0]?.circularity).toBeGreaterThan(0.7);
  });

  it("handles empty and degenerate Sobel inputs", () => {
    expect(rgbaToLuminance([], 0, 0)).toHaveLength(0);
    expect(percentile([], 0.5)).toBeNull();
    expect(sobel(new Float32Array(2), 2, 1).magnitude).toEqual(new Float32Array(2));
  });
});
