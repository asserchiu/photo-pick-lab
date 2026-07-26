import type {
  CircleDetection,
  QualityResult,
} from "../domain/types";
import type { PhotoMetadata } from "../ingest/photo";
import type { AnalysisCompleteResponse } from "../workers/protocol";

export const testMetadata: PhotoMetadata = {
  orientation: 1,
  capturedAt: "2026:07:26 20:00:00",
  camera: "Test Camera",
  iso: 200,
  exposureTime: 0.01,
  fNumber: 8,
  focalLength: 400,
};

export function testDetection(
  confidence = 0.9,
  method: CircleDetection["method"] = "circle-fit",
): CircleDetection {
  return {
    circle: { centerX: 0.5, centerY: 0.5, radius: 0.2 },
    confidence,
    method,
    fitResidual: method === "manual" ? null : 0.01,
    arcCoverage: method === "manual" ? 0 : 0.9,
    radialContrast: method === "manual" ? 0 : 0.8,
    touchesBorder: false,
    diagnostics: {
      threshold: 180,
      componentArea: 500,
      componentCircularity: 0.9,
      candidateScore: confidence,
      edgePointCount: 80,
      inlierCount: 70,
      warnings: [],
    },
  };
}

export function testQuality(quality = 0.5): QualityResult {
  const penalty = 1 - quality;
  const metric = (value: number) => ({ value, reliability: 1 });
  return {
    metrics: {
      textureSharpness: metric(quality),
      limbSharpness: metric(quality),
      effectiveResolution: metric(quality * 1000),
      motionBlurPenalty: metric(penalty),
      clippingPenalty: metric(penalty),
      noisePenalty: metric(penalty),
      hazePenalty: metric(penalty),
    },
    sampledSurfacePixels: 100,
    sampledLimbProfiles: 100,
    effectiveSourcePixelDiameter: quality * 1000,
  };
}

export function testAnalysisResponse(
  envelope: { assetId: string; requestId: string; revision: number },
  options: { confidence?: number; quality?: number; method?: CircleDetection["method"] } = {},
): AnalysisCompleteResponse {
  return {
    type: "ANALYSIS_COMPLETE",
    ...envelope,
    metadata: testMetadata,
    sourceSize: { width: 4000, height: 3000 },
    preview: new Blob(["preview"], { type: "image/jpeg" }),
    detection: testDetection(options.confidence, options.method),
    quality: testQuality(options.quality),
  };
}
