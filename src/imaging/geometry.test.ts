import { describe, expect, it } from "vitest";
import { CROP_ASPECT_RATIOS, CROP_ERROR_CODES } from "../domain/types";
import {
  centeredCrop,
  containFitRect,
  mapCircleBetweenSizes,
  normalizedCircleToPixels,
  normalizedToRendered,
  pixelCircleToNormalized,
  pointerToNormalized,
} from "./geometry";

describe("geometry", () => {
  it("round-trips circles across upright source, analysis, and preview sizes", () => {
    const source = { width: 4000, height: 3000 };
    const analysis = { width: 400, height: 300 };
    const original = { centerX: 2600, centerY: 1050, radius: 360 };
    const normalized = pixelCircleToNormalized(original, source);
    expect(normalized).not.toBeNull();
    const analysisCircle = mapCircleBetweenSizes(original, source, analysis);
    expect(analysisCircle).toEqual({ centerX: 260, centerY: 105, radius: 36 });
    const restored = analysisCircle === null ? null : mapCircleBetweenSizes(analysisCircle, analysis, source);
    expect(restored).toEqual(original);
    expect(normalized === null ? null : normalizedCircleToPixels(normalized, source)).toEqual(original);
  });

  it("maps contain-fit pointers without treating letterbox bars as image", () => {
    const rendered = containFitRect(
      { width: 400, height: 200 },
      { x: 10, y: 20, width: 300, height: 300 },
    );
    expect(rendered).toEqual({ x: 10, y: 95, width: 300, height: 150 });
    if (rendered === null) throw new Error("expected a rendered rectangle");
    const normalized = pointerToNormalized({ x: 160, y: 170 }, rendered);
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(normalized === null ? null : normalizedToRendered(normalized, rendered)).toEqual({ x: 160, y: 170 });
    expect(pointerToNormalized({ x: 160, y: 40 }, rendered)).toBeNull();
  });

  it.each(Object.entries(CROP_ASPECT_RATIOS))("builds a centered %s crop with exact fill", (_name, ratio) => {
    const result = centeredCrop(
      { width: 600, height: 400 },
      { centerX: 0.5, centerY: 0.5, radius: 0.1 },
      { aspectRatio: ratio, fill: 0.5 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rect.width / result.rect.height).toBeCloseTo(ratio, 10);
    expect(result.actualFill).toBeCloseTo(0.5, 10);
    expect(result.rect.x + result.rect.width / 2).toBeCloseTo(300, 10);
    expect(result.rect.y + result.rect.height / 2).toBeCloseTo(200, 10);
  });

  it("reports the minimum feasible fill instead of shifting an edge crop", () => {
    const result = centeredCrop(
      { width: 400, height: 300 },
      { centerX: 0.15, centerY: 0.5, radius: 0.1 },
      { aspectRatio: "16:9", fill: 0.5 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(CROP_ERROR_CODES.CROP_EXCEEDS_SOURCE);
    expect(result.minimumFill).toBeCloseTo(8 / 9, 8);
  });
});
