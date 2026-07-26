export interface Size {
  width: number;
  height: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface Rect extends Point2D, Size {}

/** Center coordinates use each axis; radius uses the image's shorter side. */
export interface NormalizedCircle {
  centerX: number;
  centerY: number;
  radius: number;
}

export interface PixelCircle {
  centerX: number;
  centerY: number;
  radius: number;
}

export type DetectionMethod = "circle-fit" | "component-bounds" | "manual";

export interface DetectionDiagnostics {
  threshold: number;
  componentArea: number;
  componentCircularity: number;
  candidateScore: number;
  edgePointCount: number;
  inlierCount: number;
  warnings: string[];
}

export interface CircleDetection {
  circle: NormalizedCircle;
  confidence: number;
  method: DetectionMethod;
  fitResidual: number | null;
  arcCoverage: number;
  radialContrast: number;
  touchesBorder: boolean;
  diagnostics: DetectionDiagnostics;
}

export interface RawMetric {
  /** Null means that the metric could not be measured; it is not a zero. */
  value: number | null;
  reliability: number;
}

export interface QualityMetrics {
  textureSharpness: RawMetric;
  limbSharpness: RawMetric;
  effectiveResolution: RawMetric;
  motionBlurPenalty: RawMetric;
  clippingPenalty: RawMetric;
  noisePenalty: RawMetric;
  hazePenalty: RawMetric;
}

export interface QualityResult {
  metrics: QualityMetrics;
  sampledSurfacePixels: number;
  sampledLimbProfiles: number;
  effectiveSourcePixelDiameter: number | null;
}

export interface RankableCandidate {
  assetId: string;
  ingestIndex: number;
  quality: QualityResult;
}

export interface NormalizedQualityFactors {
  textureSharpness: number;
  limbSharpness: number;
  effectiveResolution: number;
  motionBlur: number;
  clipping: number;
  noise: number;
  haze: number;
}

export interface RankedCandidate extends RankableCandidate {
  score: number;
  normalized: NormalizedQualityFactors;
  reasons: string[];
}

export const CROP_ASPECT_RATIOS = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:2": 3 / 2,
  "16:9": 16 / 9,
} as const;

export type CropAspectRatio = keyof typeof CROP_ASPECT_RATIOS;

export interface CropOptions {
  aspectRatio: CropAspectRatio | number;
  /** Moon diameter divided by the crop's shorter side. */
  fill: number;
}

export const CROP_ERROR_CODES = {
  INVALID_SOURCE_SIZE: "INVALID_SOURCE_SIZE",
  INVALID_CIRCLE: "INVALID_CIRCLE",
  INVALID_ASPECT_RATIO: "INVALID_ASPECT_RATIO",
  INVALID_FILL: "INVALID_FILL",
  CROP_EXCEEDS_SOURCE: "CROP_EXCEEDS_SOURCE",
} as const;

export type CropErrorCode =
  (typeof CROP_ERROR_CODES)[keyof typeof CROP_ERROR_CODES];

export interface CropSuccess {
  ok: true;
  rect: Rect;
  aspectRatio: number;
  requestedFill: number;
  actualFill: number;
  minimumFill: number;
}

export interface CropFailure {
  ok: false;
  errorCode: CropErrorCode;
  minimumFill: number | null;
}

export type CropResult = CropSuccess | CropFailure;
