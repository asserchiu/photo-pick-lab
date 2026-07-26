import type {
  CircleDetection,
  NormalizedCircle,
  QualityResult,
  Size,
} from "../domain/types";
import type { ExportCropSpec } from "../export/crop";
import type { PhotoMetadata } from "../ingest/photo";

export type WorkerProgressStage =
  | "metadata"
  | "decode"
  | "detect"
  | "measure"
  | "preview"
  | "export";

interface WorkerEnvelope {
  assetId: string;
  requestId: string;
  revision: number;
}

export interface AnalyzeFileRequest extends WorkerEnvelope {
  type: "ANALYZE_FILE";
  file: File;
}

export interface ReanalyzeCircleRequest extends WorkerEnvelope {
  type: "REANALYZE_CIRCLE";
  file: File;
  circle: NormalizedCircle;
}

export type ExportFormat = "image/jpeg" | "image/png";

export interface ExportFileRequest extends WorkerEnvelope {
  type: "EXPORT_FILE";
  file: File;
  circle: NormalizedCircle;
  crop: ExportCropSpec;
  format: ExportFormat;
  capturedAt: string | null;
}

export type WorkerRequest =
  | AnalyzeFileRequest
  | ReanalyzeCircleRequest
  | ExportFileRequest;

export interface ProgressResponse extends WorkerEnvelope {
  type: "PROGRESS";
  stage: WorkerProgressStage;
  value: number;
}

export interface AnalysisCompleteResponse extends WorkerEnvelope {
  type: "ANALYSIS_COMPLETE";
  metadata: PhotoMetadata;
  sourceSize: Size;
  preview: Blob;
  detection: CircleDetection;
  quality: QualityResult;
}

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  filename: string;
  warnings: string[];
}

export interface ExportCompleteResponse extends WorkerEnvelope, ExportResult {
  type: "EXPORT_COMPLETE";
}

export interface WorkerError {
  code: string;
  message: string;
}

export interface ErrorResponse extends WorkerEnvelope {
  type: "ERROR";
  error: WorkerError;
}

export type WorkerResponse =
  | ProgressResponse
  | AnalysisCompleteResponse
  | ExportCompleteResponse
  | ErrorResponse;
