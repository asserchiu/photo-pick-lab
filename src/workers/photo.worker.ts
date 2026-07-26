import { analysisConfig } from "../config/analysis";
import type { CircleDetection, NormalizedCircle, Size } from "../domain/types";
import { fixedSizeCrop } from "../export/crop";
import { buildExportFilename } from "../export/filename";
import {
  centeredCrop,
  isValidNormalizedCircle,
  normalizedCircleToPixels,
} from "../imaging/geometry";
import {
  bitmapToImageData,
  createCanvas2D,
  createPreviewBlob,
  decodeUprightBitmap,
  detectPhotoFormat,
  imageDataToLuminance,
  PHOTO_ERROR_CODES,
  PhotoPipelineError,
  readEncodedSize,
  readPhotoMetadata,
  validateDecodedSize,
  validateFileSize,
} from "../ingest/photo";
import { detectMoon } from "../modes/moon/detectMoon";
import { evaluateMoonQuality } from "../modes/moon/quality";
import type {
  AnalyzeFileRequest,
  ExportFileRequest,
  ExportResult,
  ReanalyzeCircleRequest,
  WorkerProgressStage,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

const WORKER_ERROR_CODES = {
  INVALID_MANUAL_CIRCLE: "INVALID_MANUAL_CIRCLE",
  INVALID_DETECTION: "INVALID_DETECTION",
  EXPORT_ENCODE_FAILED: "EXPORT_ENCODE_FAILED",
  INVALID_EXPORT_RECT: "INVALID_EXPORT_RECT",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

class WorkerOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorkerOperationError";
    this.code = code;
  }
}

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
}

const workerScope = globalThis as unknown as WorkerScope;

type AnalysisRequest = AnalyzeFileRequest | ReanalyzeCircleRequest;

function postProgress(
  request: WorkerRequest,
  stage: WorkerProgressStage,
  value: number,
): void {
  workerScope.postMessage({
    type: "PROGRESS",
    assetId: request.assetId,
    requestId: request.requestId,
    revision: request.revision,
    stage,
    value,
  });
}

function manualDetection(circle: NormalizedCircle, placeholder: boolean): CircleDetection {
  return {
    circle,
    confidence: placeholder ? 0 : 1,
    method: "manual",
    fitResidual: null,
    arcCoverage: 0,
    radialContrast: 0,
    touchesBorder: false,
    diagnostics: {
      threshold: 0,
      componentArea: 0,
      componentCircularity: 0,
      candidateScore: 0,
      edgePointCount: 0,
      inlierCount: 0,
      warnings: placeholder
        ? ["moon-detection-failed-manual-placeholder"]
        : ["manual-circle"],
    },
  };
}

async function analyze(request: AnalysisRequest): Promise<void> {
  validateFileSize(request.file);
  const format = await detectPhotoFormat(request.file);
  const encodedSize = await readEncodedSize(request.file, format);
  if (encodedSize !== null) validateDecodedSize(encodedSize);
  postProgress(request, "metadata", 0.1);
  const metadata = await readPhotoMetadata(request.file);

  postProgress(request, "decode", 0.25);
  const bitmap = await decodeUprightBitmap(request.file);
  try {
    const sourceSize: Size = { width: bitmap.width, height: bitmap.height };
    // Recheck after orientation-aware decode as defense in depth against
    // malformed headers and browser-specific dimension handling.
    validateDecodedSize(sourceSize);
    const searchImage = bitmapToImageData(bitmap, analysisConfig.searchLongEdge);
    const searchSize: Size = {
      width: searchImage.width,
      height: searchImage.height,
    };
    const luminance = imageDataToLuminance(searchImage);

    let detection: CircleDetection;
    if (request.type === "REANALYZE_CIRCLE") {
      if (!isValidNormalizedCircle(request.circle)) {
        throw new WorkerOperationError(
          WORKER_ERROR_CODES.INVALID_MANUAL_CIRCLE,
          "The manual moon circle is invalid.",
        );
      }
      detection = manualDetection(request.circle, false);
    } else {
      postProgress(request, "detect", 0.5);
      detection = detectMoon(luminance, searchSize.width, searchSize.height) ??
        manualDetection({ centerX: 0.5, centerY: 0.5, radius: 0.18 }, true);
    }

    postProgress(request, "measure", 0.75);
    const pixelCircle = normalizedCircleToPixels(detection.circle, searchSize);
    if (pixelCircle === null) {
      throw new WorkerOperationError(
        WORKER_ERROR_CODES.INVALID_DETECTION,
        "The detected moon circle could not be mapped onto the analysis image.",
      );
    }
    const quality = evaluateMoonQuality(
      luminance,
      searchSize.width,
      searchSize.height,
      pixelCircle,
      { sourceSize },
    );

    postProgress(request, "preview", 0.9);
    const preview = await createPreviewBlob(bitmap, analysisConfig.previewLongEdge);
    workerScope.postMessage({
      type: "ANALYSIS_COMPLETE",
      assetId: request.assetId,
      requestId: request.requestId,
      revision: request.revision,
      metadata,
      sourceSize,
      preview,
      detection,
      quality,
    });
  } finally {
    bitmap.close();
  }
}

function integerCropBounds(
  rect: { x: number; y: number; width: number; height: number },
  sourceSize: Size,
): { x: number; y: number; width: number; height: number } | null {
  // Rounding each designed edge independently preserves the centered crop; clamps only absorb
  // sub-pixel floating error at a source edge and never translate the crop to make it fit.
  const left = Math.min(sourceSize.width, Math.max(0, Math.round(rect.x)));
  const top = Math.min(sourceSize.height, Math.max(0, Math.round(rect.y)));
  const right = Math.min(sourceSize.width, Math.max(0, Math.round(rect.x + rect.width)));
  const bottom = Math.min(sourceSize.height, Math.max(0, Math.round(rect.y + rect.height)));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function exportFile(request: ExportFileRequest): Promise<void> {
  validateFileSize(request.file);
  await detectPhotoFormat(request.file);
  postProgress(request, "decode", 0.15);
  const bitmap = await decodeUprightBitmap(request.file);
  try {
    const sourceSize: Size = { width: bitmap.width, height: bitmap.height };
    validateDecodedSize(sourceSize);
    const crop = request.crop.mode === "fill"
      ? centeredCrop(sourceSize, request.circle, request.crop.options)
      : fixedSizeCrop(sourceSize, request.circle, request.crop.size);
    if (!crop.ok) {
      throw new WorkerOperationError(
        crop.errorCode,
        `The requested centered crop cannot be exported (${crop.errorCode}).`,
      );
    }
    const bounds = integerCropBounds(crop.rect, sourceSize);
    if (bounds === null) {
      throw new WorkerOperationError(
        WORKER_ERROR_CODES.INVALID_EXPORT_RECT,
        "The requested centered crop has no exportable pixels.",
      );
    }

    postProgress(request, "export", 0.65);
    const { canvas, context } = createCanvas2D(bounds.width, bounds.height);
    context.drawImage(
      bitmap,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      bounds.width,
      bounds.height,
    );
    let blob: Blob;
    try {
      blob = await canvas.convertToBlob({
        type: request.format,
        ...(request.format === "image/jpeg" ? { quality: analysisConfig.jpegQuality } : {}),
      });
    } catch (error) {
      throw new WorkerOperationError(
        WORKER_ERROR_CODES.EXPORT_ENCODE_FAILED,
        "The browser could not encode the cropped image.",
        error,
      );
    }
    const result: ExportResult = {
      blob,
      width: bounds.width,
      height: bounds.height,
      filename: buildExportFilename({
        originalName: request.file.name,
        format: request.format,
        crop: request.crop,
        capturedAt: request.capturedAt,
      }),
      warnings: ["EXIF metadata removed", "ICC color profile removed"],
    };
    workerScope.postMessage({
      type: "EXPORT_COMPLETE",
      assetId: request.assetId,
      requestId: request.requestId,
      revision: request.revision,
      ...result,
    });
  } finally {
    bitmap.close();
  }
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof PhotoPipelineError || error instanceof WorkerOperationError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: WORKER_ERROR_CODES.UNKNOWN_ERROR,
    message: "The image operation failed unexpectedly.",
  };
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    if (request.type === "EXPORT_FILE") {
      await exportFile(request);
    } else {
      await analyze(request);
    }
  } catch (error) {
    workerScope.postMessage({
      type: "ERROR",
      assetId: request.assetId,
      requestId: request.requestId,
      revision: request.revision,
      error: errorDetails(error),
    });
  }
}

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

export { PHOTO_ERROR_CODES };
