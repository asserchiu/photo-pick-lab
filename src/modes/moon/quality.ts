import type { PixelCircle, QualityResult, RawMetric, Size } from "../../domain/types";
import { median, percentile, robustStandardDeviation, sobel } from "../../imaging/primitives";

export interface QualityOptions {
  sourceSize?: Size;
  clippingLevel?: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function measured(value: number | null, reliability: number): RawMetric {
  return {
    value: value !== null && Number.isFinite(value) ? value : null,
    reliability: value === null ? 0 : clamp01(reliability),
  };
}

function emptyResult(): QualityResult {
  const missing = (): RawMetric => ({ value: null, reliability: 0 });
  return {
    metrics: {
      textureSharpness: missing(),
      limbSharpness: missing(),
      effectiveResolution: missing(),
      motionBlurPenalty: missing(),
      clippingPenalty: missing(),
      noisePenalty: missing(),
      hazePenalty: missing(),
    },
    sampledSurfacePixels: 0,
    sampledLimbProfiles: 0,
    effectiveSourcePixelDiameter: null,
  };
}

function bilinearSample(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number | null {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(width - 1, left + 1);
  const bottom = Math.min(height - 1, top + 1);
  const fractionX = x - left;
  const fractionY = y - top;
  const topValue = (data[top * width + left] ?? 0) * (1 - fractionX) +
    (data[top * width + right] ?? 0) * fractionX;
  const bottomValue = (data[bottom * width + left] ?? 0) * (1 - fractionX) +
    (data[bottom * width + right] ?? 0) * fractionX;
  return topValue * (1 - fractionY) + bottomValue * fractionY;
}

interface LimbMeasurements {
  sharpness: number[];
  contrasts: number[];
  profileCount: number;
}

function measureLimb(
  data: ArrayLike<number>,
  width: number,
  height: number,
  circle: PixelCircle,
): LimbMeasurements {
  const sharpness: number[] = [];
  const contrasts: number[] = [];
  const angleCount = 120;
  const profileHalfWidth = Math.max(3, Math.min(8, circle.radius * 0.18));
  const steps = 16;

  for (let angleIndex = 0; angleIndex < angleCount; angleIndex += 1) {
    const angle = angleIndex / angleCount * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const profile: number[] = [];
    let valid = true;
    for (let step = 0; step <= steps; step += 1) {
      const offset = -profileHalfWidth + step / steps * profileHalfWidth * 2;
      const sample = bilinearSample(
        data,
        width,
        height,
        circle.centerX + cosine * (circle.radius + offset),
        circle.centerY + sine * (circle.radius + offset),
      );
      if (sample === null) {
        valid = false;
        break;
      }
      profile.push(sample);
    }
    if (!valid || profile.length !== steps + 1) continue;
    const inner = percentile(profile.slice(0, 4), 0.5) ?? 0;
    const outer = percentile(profile.slice(-4), 0.5) ?? 0;
    const contrast = inner - outer;
    if (contrast < 6) continue;
    let maximumStep = 0;
    for (let index = 1; index < profile.length; index += 1) {
      maximumStep = Math.max(maximumStep, Math.abs((profile[index] ?? 0) - (profile[index - 1] ?? 0)));
    }
    contrasts.push(contrast);
    sharpness.push(maximumStep / Math.max(contrast, 1));
  }
  return { sharpness, contrasts, profileCount: sharpness.length };
}

export function evaluateMoonQuality(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  circle: PixelCircle,
  options: QualityOptions = {},
): QualityResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 ||
      luminance.length < width * height || !Number.isFinite(circle.centerX) ||
      !Number.isFinite(circle.centerY) || !Number.isFinite(circle.radius) || circle.radius < 2) {
    return emptyResult();
  }

  const outerValues: number[] = [];
  for (let y = Math.max(0, Math.floor(circle.centerY - circle.radius * 1.35));
       y <= Math.min(height - 1, Math.ceil(circle.centerY + circle.radius * 1.35)); y += 1) {
    for (let x = Math.max(0, Math.floor(circle.centerX - circle.radius * 1.35));
         x <= Math.min(width - 1, Math.ceil(circle.centerX + circle.radius * 1.35)); x += 1) {
      const distance = Math.hypot(x + 0.5 - circle.centerX, y + 0.5 - circle.centerY) / circle.radius;
      if (distance >= 1.08 && distance <= 1.35) outerValues.push(luminance[y * width + x] ?? 0);
    }
  }
  const background = median(outerValues) ?? 0;
  const backgroundNoise = robustStandardDeviation(outerValues) ?? 0;
  const surfaceThreshold = background + Math.max(4, backgroundNoise * 1.5);
  const surfaceIndices: number[] = [];
  const surfaceValues: number[] = [];
  const { gx, gy, magnitude } = sobel(luminance, width, height);
  const gradientValues: number[] = [];
  const residualValues: number[] = [];
  let clipped = 0;
  const clippingLevel = options.clippingLevel ?? 250;

  const minX = Math.max(1, Math.floor(circle.centerX - circle.radius * 0.82));
  const maxX = Math.min(width - 2, Math.ceil(circle.centerX + circle.radius * 0.82));
  const minY = Math.max(1, Math.floor(circle.centerY - circle.radius * 0.82));
  const maxY = Math.min(height - 2, Math.ceil(circle.centerY + circle.radius * 0.82));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const radiusFraction = Math.hypot(x + 0.5 - circle.centerX, y + 0.5 - circle.centerY) / circle.radius;
      if (radiusFraction > 0.8) continue;
      const index = y * width + x;
      const value = luminance[index] ?? 0;
      if (value <= surfaceThreshold) continue;
      surfaceIndices.push(index);
      surfaceValues.push(value);
      gradientValues.push(magnitude[index] ?? 0);
      if (value >= clippingLevel) clipped += 1;
      const neighborMean = (
        (luminance[index - 1] ?? value) + (luminance[index + 1] ?? value) +
        (luminance[index - width] ?? value) + (luminance[index + width] ?? value)
      ) / 4;
      residualValues.push(value - neighborMean);
    }
  }

  const expectedSurfaceArea = Math.PI * Math.pow(circle.radius * 0.8, 2);
  const surfaceCoverage = clamp01(surfaceIndices.length / Math.max(1, expectedSurfaceArea * 0.35));
  const enoughSurface = surfaceIndices.length >= 12;
  const texture = enoughSurface ? (percentile(gradientValues, 0.75) ?? 0) / 255 : null;
  const noiseScale = enoughSurface ? robustStandardDeviation(residualValues) : null;
  const noisePenalty = noiseScale === null ? null : clamp01(noiseScale / 18);
  const clippingPenalty = enoughSurface ? clipped / surfaceIndices.length : null;

  let tensorXX = 0;
  let tensorYY = 0;
  let tensorXY = 0;
  let tensorWeight = 0;
  for (const index of surfaceIndices) {
    const horizontal = gx[index] ?? 0;
    const vertical = gy[index] ?? 0;
    const weight = horizontal * horizontal + vertical * vertical;
    tensorXX += horizontal * horizontal;
    tensorYY += vertical * vertical;
    tensorXY += horizontal * vertical;
    tensorWeight += weight;
  }
  let motionBlurPenalty: number | null = null;
  if (tensorWeight > 1e-6 && surfaceIndices.length >= 20) {
    const trace = tensorXX + tensorYY;
    const discriminant = Math.hypot(tensorXX - tensorYY, 2 * tensorXY);
    motionBlurPenalty = clamp01(discriminant / Math.max(trace, 1e-9));
  }

  const limb = measureLimb(luminance, width, height, circle);
  const limbReliability = clamp01(limb.profileCount / 48);
  const limbSharpness = limb.profileCount >= 4 ? median(limb.sharpness) : null;
  const limbContrast = limb.profileCount >= 4 ? median(limb.contrasts) : null;
  const surfaceContrast = enoughSurface ? robustStandardDeviation(surfaceValues) : null;
  let hazePenalty: number | null = null;
  if (limbContrast !== null || surfaceContrast !== null) {
    const contrastEvidence = 0.7 * clamp01((limbContrast ?? 0) / 80) +
      0.3 * clamp01((surfaceContrast ?? 0) / 24);
    hazePenalty = 1 - contrastEvidence;
  }

  const sourceSize = options.sourceSize;
  const sourceScale = sourceSize !== undefined && sourceSize.width > 0 && sourceSize.height > 0
    ? Math.min(sourceSize.width, sourceSize.height) / Math.min(width, height)
    : 1;
  const effectiveDiameter = circle.radius * 2 * sourceScale;
  const resolutionReliability = clamp01(circle.radius / 8) *
    clamp01(Math.min(
      circle.centerX + circle.radius,
      width - circle.centerX + circle.radius,
      circle.centerY + circle.radius,
      height - circle.centerY + circle.radius,
    ) / Math.max(1, circle.radius * 2));

  return {
    metrics: {
      textureSharpness: measured(texture, surfaceCoverage),
      limbSharpness: measured(limbSharpness, limbReliability),
      effectiveResolution: measured(effectiveDiameter, resolutionReliability),
      motionBlurPenalty: measured(motionBlurPenalty, surfaceCoverage),
      clippingPenalty: measured(clippingPenalty, surfaceCoverage),
      noisePenalty: measured(noisePenalty, surfaceCoverage),
      hazePenalty: measured(hazePenalty, Math.max(surfaceCoverage * 0.5, limbReliability)),
    },
    sampledSurfacePixels: surfaceIndices.length,
    sampledLimbProfiles: limb.profileCount,
    effectiveSourcePixelDiameter: effectiveDiameter,
  };
}

export const analyzeMoonQuality = evaluateMoonQuality;
