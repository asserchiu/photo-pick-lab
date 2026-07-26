import type { CircleDetection, PixelCircle, Point2D } from "../../domain/types";
import { pixelCircleToNormalized } from "../../imaging/geometry";
import {
  closeBinary,
  connectedComponents,
  median,
  otsuThreshold,
  percentile,
  robustStandardDeviation,
  sobel,
  type ConnectedComponent,
} from "../../imaging/primitives";
import { fitCircleRobust, type CircleFitResult } from "./circleFit";

export interface DetectMoonOptions {
  minimumRadiusFraction?: number;
  maximumRadiusFraction?: number;
  minimumComponentArea?: number;
  thresholds?: readonly number[];
}

interface DetectionCandidate {
  detection: CircleDetection;
  score: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function thresholdMask(
  luminance: ArrayLike<number>,
  threshold: number,
  width: number,
  height: number,
): Uint8Array {
  const result = new Uint8Array(width * height);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = (luminance[index] ?? 0) >= threshold ? 1 : 0;
  }
  return result;
}

function adaptiveThresholds(luminance: ArrayLike<number>): number[] {
  const center = median(luminance) ?? 0;
  const robustDeviation = robustStandardDeviation(luminance) ?? 0;
  const otsu = otsuThreshold(luminance);
  const candidates = [
    percentile(luminance, 0.995),
    percentile(luminance, 0.98),
    percentile(luminance, 0.95),
    percentile(luminance, 0.9),
    otsu === null ? null : otsu + 1,
    center + Math.max(8, robustDeviation * 2.5),
  ];
  const unique = new Set<number>();
  for (const candidate of candidates) {
    if (candidate === null || !Number.isFinite(candidate)) continue;
    const value = Math.min(255, Math.max(center + 2, candidate));
    if (value < 255 || (percentile(luminance, 1) ?? 0) >= 255) {
      unique.add(Math.round(value * 10) / 10);
    }
  }
  return [...unique].sort((left, right) => right - left);
}

function boundaryPoints(
  component: ConnectedComponent,
  width: number,
  height: number,
  gradientMagnitude: Float32Array,
): Point2D[] {
  const membership = new Uint8Array(width * height);
  for (const index of component.pixels) membership[index] = 1;
  const raw: Array<{ point: Point2D; gradient: number }> = [];
  for (const index of component.pixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    const isBoundary = x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
      !membership[index - 1] || !membership[index + 1] ||
      !membership[index - width] || !membership[index + width];
    if (isBoundary) {
      raw.push({ point: { x: x + 0.5, y: y + 0.5 }, gradient: gradientMagnitude[index] ?? 0 });
    }
  }
  const cutoff = percentile(raw.map((entry) => entry.gradient), 0.2) ?? 0;
  let points = raw.filter((entry) => entry.gradient >= cutoff).map((entry) => entry.point);
  if (points.length < 12) points = raw.map((entry) => entry.point);
  if (points.length > 900) {
    const step = points.length / 900;
    const sampled: Point2D[] = [];
    for (let index = 0; index < 900; index += 1) {
      const point = points[Math.floor(index * step)];
      if (point !== undefined) sampled.push(point);
    }
    points = sampled;
  }
  return points;
}

function sampleNearest(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number | null {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (roundedX < 0 || roundedX >= width || roundedY < 0 || roundedY >= height) return null;
  return luminance[roundedY * width + roundedX] ?? null;
}

function radialContrast(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  circle: PixelCircle,
): number {
  const differences: number[] = [];
  for (let index = 0; index < 96; index += 1) {
    const angle = index / 96 * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const inside = sampleNearest(
      luminance,
      width,
      height,
      circle.centerX + cosine * circle.radius * 0.82,
      circle.centerY + sine * circle.radius * 0.82,
    );
    const outside = sampleNearest(
      luminance,
      width,
      height,
      circle.centerX + cosine * circle.radius * 1.18,
      circle.centerY + sine * circle.radius * 1.18,
    );
    if (inside !== null && outside !== null) differences.push(Math.max(0, inside - outside));
  }
  return clamp01((percentile(differences, 0.75) ?? 0) / 96);
}

function componentSeed(component: ConnectedComponent, threshold: number): number {
  return (
    Math.imul(component.bbox.x + 1, 73856093) ^
    Math.imul(component.bbox.y + 1, 19349663) ^
    Math.imul(component.area, 83492791) ^
    Math.round(threshold * 10)
  ) >>> 0;
}

function analyzeComponent(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  component: ConnectedComponent,
  threshold: number,
  gradientMagnitude: Float32Array,
  minimumRadius: number,
  maximumRadius: number,
): DetectionCandidate | null {
  const span = Math.max(component.bbox.width, component.bbox.height);
  if (span < minimumRadius * 1.3) return null;
  const edgePoints = boundaryPoints(component, width, height, gradientMagnitude);
  const fit = fitCircleRobust(edgePoints, {
    seed: componentSeed(component, threshold),
    iterations: 700,
    minimumRadius: Math.max(minimumRadius, span * 0.28),
    maximumRadius: Math.min(maximumRadius, span * 1.15),
    inlierThreshold: Math.max(1.35, span * 0.022),
  });

  const fallbackCircle: PixelCircle = {
    centerX: component.bbox.x + component.bbox.width / 2,
    centerY: component.bbox.y + component.bbox.height / 2,
    radius: span / 2,
  };
  const circle = fit?.circle ?? fallbackCircle;
  if (circle.radius < minimumRadius || circle.radius > maximumRadius ||
      circle.centerX < 0 || circle.centerX > width ||
      circle.centerY < 0 || circle.centerY > height) {
    return null;
  }
  const normalized = pixelCircleToNormalized(circle, { width, height });
  if (normalized === null) return null;

  const contrast = radialContrast(luminance, width, height, circle);
  const residualRatio = fit === null ? null : fit.medianResidual / circle.radius;
  const fitQuality = residualRatio === null ? 0.18 : Math.exp(-residualRatio / 0.045);
  const coverage = fit?.arcCoverage ?? 0;
  const aspect = Math.min(component.bbox.width, component.bbox.height) / span;
  const circularity = clamp01(component.circularity / 0.82);
  const centerDistance = Math.hypot(circle.centerX / width - 0.5, circle.centerY / height - 0.5) / Math.SQRT1_2;
  const centerPrior = 1 - clamp01(centerDistance);
  const touchesBorder = circle.centerX - circle.radius <= 1 || circle.centerX + circle.radius >= width - 1 ||
    circle.centerY - circle.radius <= 1 || circle.centerY + circle.radius >= height - 1;
  const shapeSupport = circularity * 0.6 + aspect * 0.4;
  let confidence = 0.42 * fitQuality + 0.3 * coverage + 0.2 * contrast + 0.08 * shapeSupport;
  if (touchesBorder) confidence *= 0.78;
  confidence = clamp01(confidence);
  const score = 0.38 * fitQuality + 0.27 * coverage + 0.2 * contrast +
    0.12 * shapeSupport + 0.03 * centerPrior;
  const warnings: string[] = [];
  if (fit === null) warnings.push("circle-fit-fallback");
  if (coverage < 0.35) warnings.push("limited-arc-coverage");
  if (contrast < 0.12) warnings.push("low-radial-contrast");
  if (touchesBorder) warnings.push("circle-near-border");
  if (confidence < 0.5) warnings.push("manual-confirmation-recommended");

  return {
    score,
    detection: {
      circle: normalized,
      confidence,
      method: fit === null ? "component-bounds" : "circle-fit",
      fitResidual: residualRatio,
      arcCoverage: coverage,
      radialContrast: contrast,
      touchesBorder,
      diagnostics: {
        threshold,
        componentArea: component.area,
        componentCircularity: component.circularity,
        candidateScore: score,
        edgePointCount: edgePoints.length,
        inlierCount: fit?.inlierCount ?? 0,
        warnings,
      },
    },
  };
}

function betterCandidate(left: DetectionCandidate, right: DetectionCandidate | null): boolean {
  if (right === null) return true;
  if (Math.abs(left.score - right.score) > 1e-12) return left.score > right.score;
  if (left.detection.diagnostics.inlierCount !== right.detection.diagnostics.inlierCount) {
    return left.detection.diagnostics.inlierCount > right.detection.diagnostics.inlierCount;
  }
  if (left.detection.circle.radius !== right.detection.circle.radius) {
    return left.detection.circle.radius > right.detection.circle.radius;
  }
  if (left.detection.circle.centerY !== right.detection.circle.centerY) {
    return left.detection.circle.centerY < right.detection.circle.centerY;
  }
  return left.detection.circle.centerX < right.detection.circle.centerX;
}

export function detectMoon(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  options: DetectMoonOptions = {},
): CircleDetection | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 ||
      luminance.length < width * height) {
    return null;
  }
  const shorterSide = Math.min(width, height);
  const minimumRadius = shorterSide * (options.minimumRadiusFraction ?? 0.015);
  const maximumRadius = shorterSide * (options.maximumRadiusFraction ?? 0.48);
  if (minimumRadius <= 0 || maximumRadius <= minimumRadius) return null;
  const minimumArea = Math.max(6, options.minimumComponentArea ?? width * height * 0.00004);
  const thresholds = options.thresholds === undefined
    ? adaptiveThresholds(luminance)
    : [...options.thresholds].filter(Number.isFinite).sort((left, right) => right - left);
  if (thresholds.length === 0) return null;

  const gradientMagnitude = sobel(luminance, width, height).magnitude;
  let best: DetectionCandidate | null = null;
  for (const threshold of thresholds) {
    const closed = closeBinary(thresholdMask(luminance, threshold, width, height), width, height, 1);
    const components = connectedComponents(closed, width, height);
    for (const component of components) {
      if (component.area < minimumArea || component.area > width * height * 0.55) continue;
      if (component.bbox.width < 3 || component.bbox.height < 3) continue;
      const candidate = analyzeComponent(
        luminance,
        width,
        height,
        component,
        threshold,
        gradientMagnitude,
        minimumRadius,
        maximumRadius,
      );
      if (candidate !== null && betterCandidate(candidate, best)) best = candidate;
    }
  }
  return best?.detection ?? null;
}

export type { CircleFitResult };
