import type { PixelCircle, Point2D } from "../../domain/types";
import { median } from "../../imaging/primitives";

export interface CircleFitOptions {
  iterations?: number;
  seed?: number;
  minimumRadius?: number;
  maximumRadius?: number;
  inlierThreshold?: number;
  angularBins?: number;
}

export interface CircleFitResult {
  circle: PixelCircle;
  inlierCount: number;
  arcCoverage: number;
  medianResidual: number;
  rmsResidual: number;
  inlierIndices: Uint32Array;
}

type EvaluatedCircle = CircleFitResult;

function finitePoint(point: Point2D): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function sortedUniquePoints(points: readonly Point2D[]): Point2D[] {
  const sorted = points
    .filter(finitePoint)
    .map((point) => ({ x: point.x, y: point.y }))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  return sorted.filter((point, index) => {
    if (index === 0) return true;
    const previous = sorted[index - 1];
    return previous === undefined || point.x !== previous.x || point.y !== previous.y;
  });
}

export function circleFromTriplet(
  first: Point2D,
  second: Point2D,
  third: Point2D,
): PixelCircle | null {
  if (!finitePoint(first) || !finitePoint(second) || !finitePoint(third)) return null;
  const determinant = 2 * (
    first.x * (second.y - third.y) +
    second.x * (third.y - first.y) +
    third.x * (first.y - second.y)
  );
  const span = Math.max(
    Math.hypot(first.x - second.x, first.y - second.y),
    Math.hypot(first.x - third.x, first.y - third.y),
    Math.hypot(second.x - third.x, second.y - third.y),
  );
  // Scaling the rejection threshold by span keeps nearly straight triplets from
  // producing enormous circles regardless of coordinate units.
  if (span === 0 || Math.abs(determinant) <= 1e-8 * span * span) return null;

  const firstSquared = first.x * first.x + first.y * first.y;
  const secondSquared = second.x * second.x + second.y * second.y;
  const thirdSquared = third.x * third.x + third.y * third.y;
  const centerX = (
    firstSquared * (second.y - third.y) +
    secondSquared * (third.y - first.y) +
    thirdSquared * (first.y - second.y)
  ) / determinant;
  const centerY = (
    firstSquared * (third.x - second.x) +
    secondSquared * (first.x - third.x) +
    thirdSquared * (second.x - first.x)
  ) / determinant;
  const radius = Math.hypot(first.x - centerX, first.y - centerY);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  return { centerX, centerY, radius };
}

function createPrng(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    // xorshift32 is used only to visit RANSAC samples reproducibly.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function evaluateCircle(
  circle: PixelCircle,
  points: readonly Point2D[],
  threshold: number,
  angularBins: number,
): EvaluatedCircle | null {
  const residuals: number[] = [];
  const inlierIndices: number[] = [];
  const occupied = new Uint8Array(angularBins);
  let squaredResidualSum = 0;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const residual = Math.abs(Math.hypot(point.x - circle.centerX, point.y - circle.centerY) - circle.radius);
    if (residual > threshold) continue;
    residuals.push(residual);
    inlierIndices.push(index);
    squaredResidualSum += residual * residual;
    let angle = Math.atan2(point.y - circle.centerY, point.x - circle.centerX);
    if (angle < 0) angle += Math.PI * 2;
    const bin = Math.min(angularBins - 1, Math.floor(angle / (Math.PI * 2) * angularBins));
    occupied[bin] = 1;
  }
  if (inlierIndices.length < 3) return null;

  let occupiedCount = 0;
  for (const value of occupied) occupiedCount += value;
  return {
    circle,
    inlierCount: inlierIndices.length,
    arcCoverage: occupiedCount / angularBins,
    medianResidual: median(residuals) ?? Number.POSITIVE_INFINITY,
    rmsResidual: Math.sqrt(squaredResidualSum / inlierIndices.length),
    inlierIndices: Uint32Array.from(inlierIndices),
  };
}

function isBetter(candidate: EvaluatedCircle, incumbent: EvaluatedCircle | null): boolean {
  if (incumbent === null) return true;
  if (candidate.inlierCount !== incumbent.inlierCount) return candidate.inlierCount > incumbent.inlierCount;
  if (Math.abs(candidate.arcCoverage - incumbent.arcCoverage) > 1e-12) {
    return candidate.arcCoverage > incumbent.arcCoverage;
  }
  if (Math.abs(candidate.medianResidual - incumbent.medianResidual) > 1e-12) {
    return candidate.medianResidual < incumbent.medianResidual;
  }
  if (Math.abs(candidate.rmsResidual - incumbent.rmsResidual) > 1e-12) {
    return candidate.rmsResidual < incumbent.rmsResidual;
  }
  if (candidate.circle.centerX !== incumbent.circle.centerX) {
    return candidate.circle.centerX < incumbent.circle.centerX;
  }
  if (candidate.circle.centerY !== incumbent.circle.centerY) {
    return candidate.circle.centerY < incumbent.circle.centerY;
  }
  return candidate.circle.radius < incumbent.circle.radius;
}

function solveThreeByThree(matrix: Float64Array, vector: Float64Array): Float64Array | null {
  const augmented = new Float64Array(12);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      augmented[row * 4 + column] = matrix[row * 3 + column] ?? 0;
    }
    augmented[row * 4 + 3] = vector[row] ?? 0;
  }

  for (let column = 0; column < 3; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row * 4 + column] ?? 0) >
          Math.abs(augmented[pivotRow * 4 + column] ?? 0)) {
        pivotRow = row;
      }
    }
    const pivot = augmented[pivotRow * 4 + column] ?? 0;
    if (Math.abs(pivot) < 1e-10) return null;
    if (pivotRow !== column) {
      for (let entry = column; entry < 4; entry += 1) {
        const temporary = augmented[column * 4 + entry] ?? 0;
        augmented[column * 4 + entry] = augmented[pivotRow * 4 + entry] ?? 0;
        augmented[pivotRow * 4 + entry] = temporary;
      }
    }
    const normalizedPivot = augmented[column * 4 + column] ?? 1;
    for (let entry = column; entry < 4; entry += 1) {
      augmented[column * 4 + entry] = (augmented[column * 4 + entry] ?? 0) / normalizedPivot;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row * 4 + column] ?? 0;
      for (let entry = column; entry < 4; entry += 1) {
        augmented[row * 4 + entry] =
          (augmented[row * 4 + entry] ?? 0) - factor * (augmented[column * 4 + entry] ?? 0);
      }
    }
  }
  return new Float64Array([
    augmented[3] ?? 0,
    augmented[7] ?? 0,
    augmented[11] ?? 0,
  ]);
}

function refineCircle(
  initial: EvaluatedCircle,
  points: readonly Point2D[],
  threshold: number,
  angularBins: number,
  minimumRadius: number,
  maximumRadius: number,
): EvaluatedCircle {
  let current = initial;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const normal = new Float64Array(9);
    const right = new Float64Array(3);
    for (const pointIndex of current.inlierIndices) {
      const point = points[pointIndex];
      if (point === undefined) continue;
      const dx = current.circle.centerX - point.x;
      const dy = current.circle.centerY - point.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 1e-9) continue;
      const jacobian = [dx / distance, dy / distance, -1] as const;
      const residual = distance - current.circle.radius;
      for (let row = 0; row < 3; row += 1) {
        right[row] = (right[row] ?? 0) - (jacobian[row] ?? 0) * residual;
        for (let column = 0; column < 3; column += 1) {
          const index = row * 3 + column;
          normal[index] = (normal[index] ?? 0) + (jacobian[row] ?? 0) * (jacobian[column] ?? 0);
        }
      }
    }
    const delta = solveThreeByThree(normal, right);
    if (delta === null) break;
    const circle: PixelCircle = {
      centerX: current.circle.centerX + (delta[0] ?? 0),
      centerY: current.circle.centerY + (delta[1] ?? 0),
      radius: current.circle.radius + (delta[2] ?? 0),
    };
    if (!Number.isFinite(circle.centerX) || !Number.isFinite(circle.centerY) ||
        circle.radius < minimumRadius || circle.radius > maximumRadius) break;
    const evaluated = evaluateCircle(circle, points, threshold, angularBins);
    if (evaluated === null) break;
    current = evaluated;
    if (Math.hypot(delta[0] ?? 0, delta[1] ?? 0, delta[2] ?? 0) < 1e-6) break;
  }
  return current;
}

export function fitCircleRobust(
  inputPoints: readonly Point2D[],
  options: CircleFitOptions = {},
): CircleFitResult | null {
  const points = sortedUniquePoints(inputPoints);
  if (points.length < 3) return null;
  const iterations = Math.max(1, Math.floor(options.iterations ?? 600));
  const minimumRadius = Math.max(0, options.minimumRadius ?? 1);
  const maximumRadius = Math.max(minimumRadius, options.maximumRadius ?? Number.POSITIVE_INFINITY);
  const angularBins = Math.max(8, Math.floor(options.angularBins ?? 72));
  const random = createPrng(options.seed ?? 0x51f15e);
  let best: EvaluatedCircle | null = null;

  const evaluateTriplet = (firstIndex: number, secondIndex: number, thirdIndex: number): void => {
    const first = points[firstIndex];
    const second = points[secondIndex];
    const third = points[thirdIndex];
    if (first === undefined || second === undefined || third === undefined) return;
    const circle = circleFromTriplet(first, second, third);
    if (circle === null || circle.radius < minimumRadius || circle.radius > maximumRadius) return;
    const threshold = options.inlierThreshold ?? Math.max(1.25, circle.radius * 0.018);
    const evaluated = evaluateCircle(circle, points, threshold, angularBins);
    if (evaluated !== null && isBetter(evaluated, best)) best = evaluated;
  };

  const combinationCount = points.length * (points.length - 1) * (points.length - 2) / 6;
  if (combinationCount <= iterations) {
    for (let first = 0; first < points.length - 2; first += 1) {
      for (let second = first + 1; second < points.length - 1; second += 1) {
        for (let third = second + 1; third < points.length; third += 1) {
          evaluateTriplet(first, second, third);
        }
      }
    }
  } else {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const first = Math.floor(random() * points.length);
      let second = Math.floor(random() * (points.length - 1));
      if (second >= first) second += 1;
      let third = Math.floor(random() * (points.length - 2));
      const lower = Math.min(first, second);
      const upper = Math.max(first, second);
      if (third >= lower) third += 1;
      if (third >= upper) third += 1;
      const indices = [first, second, third].sort((left, right) => left - right);
      evaluateTriplet(indices[0] ?? 0, indices[1] ?? 0, indices[2] ?? 0);
    }
  }

  // TypeScript does not include assignments made by evaluateTriplet when it
  // narrows a captured variable, so restore the declared union explicitly.
  const selected = best as EvaluatedCircle | null;
  if (selected === null) return null;
  const threshold = options.inlierThreshold ?? Math.max(1.25, selected.circle.radius * 0.018);
  return refineCircle(selected, points, threshold, angularBins, minimumRadius, maximumRadius);
}
