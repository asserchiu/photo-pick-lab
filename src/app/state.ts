import { analysisConfig } from "../config/analysis";
import type {
  CircleDetection,
  NormalizedCircle,
  QualityResult,
  RankedCandidate,
  Size,
} from "../domain/types";
import type { PhotoMetadata } from "../ingest/photo";
import { rankWithinSet } from "../scoring/rankWithinSet";
import type { WorkerProgressStage } from "../workers/protocol";

export type AssetStatus =
  | "queued"
  | "running"
  | "needs-review"
  | "ready"
  | "failed"
  | "cancelled";

export interface AssetProgress {
  stage: WorkerProgressStage;
  value: number;
}

export interface AssetError {
  code: string;
  message: string;
}

export interface AssetRecord {
  id: string;
  ingestIndex: number;
  revision: number;
  file: File;
  status: AssetStatus;
  progress: AssetProgress | null;
  metadata: PhotoMetadata | null;
  sourceSize: Size | null;
  previewUrl: string | null;
  detection: CircleDetection | null;
  quality: QualityResult | null;
  manualCircle: NormalizedCircle | null;
  error: AssetError | null;
}

export interface AnalysisState {
  assets: AssetRecord[];
}

export const initialAnalysisState: AnalysisState = { assets: [] };

export interface AnalysisCompletion {
  metadata: PhotoMetadata;
  sourceSize: Size;
  previewUrl: string;
  detection: CircleDetection;
  quality: QualityResult;
}

export type AnalysisAction =
  | { type: "add"; assets: AssetRecord[] }
  | {
    type: "progress";
    assetId: string;
    revision: number;
    progress: AssetProgress;
  }
  | {
    type: "complete";
    assetId: string;
    revision: number;
    result: AnalysisCompletion;
  }
  | {
    type: "fail";
    assetId: string;
    revision: number;
    error: AssetError;
  }
  | { type: "cancel"; assetId: string; revision: number }
  | { type: "retry"; assetId: string }
  | { type: "queue-manual"; assetId: string; circle: NormalizedCircle }
  | { type: "clear" };

export interface NewAssetOptions {
  id: string;
  ingestIndex: number;
  file: File;
  error?: AssetError;
}

export function createAssetRecord(options: NewAssetOptions): AssetRecord {
  return {
    id: options.id,
    ingestIndex: options.ingestIndex,
    revision: 1,
    file: options.file,
    status: options.error === undefined ? "queued" : "failed",
    progress: null,
    metadata: null,
    sourceSize: null,
    previewUrl: null,
    detection: null,
    quality: null,
    manualCircle: null,
    error: options.error ?? null,
  };
}

function updateAsset(
  state: AnalysisState,
  assetId: string,
  update: (asset: AssetRecord) => AssetRecord,
): AnalysisState {
  let changed = false;
  const assets = state.assets.map((asset) => {
    if (asset.id !== assetId) return asset;
    const next = update(asset);
    if (next !== asset) changed = true;
    return next;
  });
  return changed ? { assets } : state;
}

function responseMayComplete(asset: AssetRecord, revision: number): boolean {
  return asset.revision === revision &&
    (asset.status === "queued" || asset.status === "running");
}

export function analysisReducer(
  state: AnalysisState,
  action: AnalysisAction,
): AnalysisState {
  switch (action.type) {
    case "add":
      return action.assets.length === 0
        ? state
        : { assets: [...state.assets, ...action.assets] };
    case "progress":
      return updateAsset(state, action.assetId, (asset) => {
        if (!responseMayComplete(asset, action.revision)) return asset;
        const value = Number.isFinite(action.progress.value)
          ? Math.min(1, Math.max(0, action.progress.value))
          : 0;
        return {
          ...asset,
          status: "running",
          progress: { ...action.progress, value },
          error: null,
        };
      });
    case "complete":
      return updateAsset(state, action.assetId, (asset) => {
        if (!responseMayComplete(asset, action.revision)) return asset;
        const accepted = action.result.detection.confidence >= analysisConfig.acceptedConfidence;
        return {
          ...asset,
          status: accepted ? "ready" : "needs-review",
          progress: null,
          metadata: action.result.metadata,
          sourceSize: action.result.sourceSize,
          previewUrl: action.result.previewUrl,
          detection: action.result.detection,
          quality: action.result.quality,
          error: null,
        };
      });
    case "fail":
      return updateAsset(state, action.assetId, (asset) => {
        if (!responseMayComplete(asset, action.revision)) return asset;
        return {
          ...asset,
          status: "failed",
          progress: null,
          previewUrl: null,
          error: action.error,
        };
      });
    case "cancel":
      return updateAsset(state, action.assetId, (asset) => {
        if (asset.revision !== action.revision ||
            (asset.status !== "queued" && asset.status !== "running")) {
          return asset;
        }
        return {
          ...asset,
          status: "cancelled",
          progress: null,
          previewUrl: null,
          error: null,
        };
      });
    case "retry":
      return updateAsset(state, action.assetId, (asset) => {
        if (asset.status !== "failed" && asset.status !== "cancelled" &&
            asset.status !== "needs-review" && asset.status !== "ready") {
          return asset;
        }
        return {
          ...asset,
          revision: asset.revision + 1,
          status: "queued",
          progress: null,
          metadata: null,
          sourceSize: null,
          previewUrl: null,
          detection: null,
          quality: null,
          manualCircle: null,
          error: null,
        };
      });
    case "queue-manual":
      return updateAsset(state, action.assetId, (asset) => {
        if (asset.status !== "needs-review" && asset.status !== "ready") return asset;
        return {
          ...asset,
          revision: asset.revision + 1,
          status: "queued",
          progress: null,
          manualCircle: action.circle,
          error: null,
        };
      });
    case "clear":
      return state.assets.length === 0 ? state : initialAnalysisState;
  }
}

export function selectRankedAssets(state: AnalysisState): RankedCandidate[] {
  return rankWithinSet(state.assets.flatMap((asset) => {
    const hasProvisionalDetection = asset.status === "needs-review" &&
      asset.detection !== null &&
      asset.detection.method !== "manual" &&
      !asset.detection.diagnostics.warnings.includes("low-radial-contrast");
    return (asset.status === "ready" || hasProvisionalDetection) && asset.quality !== null
      ? [{ assetId: asset.id, ingestIndex: asset.ingestIndex, quality: asset.quality }]
      : [];
  }));
}
