import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

import { analysisConfig } from "../config/analysis";
import type { NormalizedCircle } from "../domain/types";
import type { ExportCropSpec } from "../export/crop";
import { isValidNormalizedCircle } from "../imaging/geometry";
import type {
  ExportFormat,
  ExportResult,
  WorkerRequest,
  WorkerResponse,
} from "../workers/protocol";
import {
  analysisReducer,
  createAssetRecord,
  initialAnalysisState,
  selectRankedAssets,
  type AnalysisAction,
  type AssetError,
  type AssetRecord,
} from "./state";

export interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerRequest): void;
  terminate(): void;
}

export interface UseAnalysisQueueOptions {
  workerFactory?: () => WorkerLike;
  idFactory?: () => string;
}

export interface AddFileRejection {
  file: File;
  error: AssetError;
}

export interface AddFilesResult {
  addedIds: string[];
  queuedIds: string[];
  rejected: AddFileRejection[];
}

export interface ExportAssetOptions {
  crop: ExportCropSpec;
  format: ExportFormat;
}

export const QUEUE_ERROR_CODES = {
  MAX_FILES_EXCEEDED: "MAX_FILES_EXCEEDED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  WORKER_CRASH: "WORKER_CRASH",
  WORKER_MESSAGE_ERROR: "WORKER_MESSAGE_ERROR",
  WORKER_POST_FAILED: "WORKER_POST_FAILED",
  PREVIEW_URL_FAILED: "PREVIEW_URL_FAILED",
  EXPORT_NOT_IDLE: "EXPORT_NOT_IDLE",
  EXPORT_ASSET_NOT_READY: "EXPORT_ASSET_NOT_READY",
  EXPORT_CANCELLED: "EXPORT_CANCELLED",
} as const;

export class AnalysisQueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AnalysisQueueError";
    this.code = code;
  }
}

interface ActiveBase {
  assetId: string;
  requestId: string;
  revision: number;
}

interface ActiveAnalysis extends ActiveBase {
  kind: "analysis" | "manual";
}

interface ActiveExport extends ActiveBase {
  kind: "export";
  resolve: (result: ExportResult) => void;
  reject: (error: AnalysisQueueError) => void;
}

type ActiveRequest = ActiveAnalysis | ActiveExport;

let fallbackId = 0;

function defaultIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackId += 1;
  return `asset-${fallbackId}`;
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("../workers/photo.worker.ts", import.meta.url), { type: "module" });
}

function guardedFileError(file: File): AssetError | null {
  if (file.size > analysisConfig.maxFileBytes) {
    return {
      code: QUEUE_ERROR_CODES.FILE_TOO_LARGE,
      message: "The file exceeds the 150 MiB size limit.",
    };
  }
  return null;
}

function revokeUrl(url: string | null): void {
  if (url !== null) URL.revokeObjectURL(url);
}

export function useAnalysisQueue(options: UseAnalysisQueueOptions = {}) {
  const workerFactoryRef = useRef(options.workerFactory ?? defaultWorkerFactory);
  const idFactoryRef = useRef(options.idFactory ?? defaultIdFactory);
  const [state, reactDispatch] = useReducer(analysisReducer, initialAnalysisState);
  const [schedulerVersion, wakeQueue] = useReducer((version: number) => version + 1, 0);
  const stateRef = useRef(state);
  const activeRef = useRef<ActiveRequest | null>(null);
  const workerRef = useRef<WorkerLike | null>(null);
  const mountedRef = useRef(false);
  const nextIngestIndexRef = useRef(0);
  const responseHandlerRef = useRef<(response: WorkerResponse) => void>(() => undefined);
  const workerFailureHandlerRef = useRef<(code: string, message: string) => void>(() => undefined);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const dispatch = useCallback((action: AnalysisAction): void => {
    // Keep imperative queue methods current even when React batches multiple calls in one tick.
    stateRef.current = analysisReducer(stateRef.current, action);
    reactDispatch(action);
  }, []);

  const detachAndTerminateWorker = useCallback((): void => {
    const worker = workerRef.current;
    if (worker === null) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    workerRef.current = null;
  }, []);

  const createWorker = useCallback((): WorkerLike => {
    const worker = workerFactoryRef.current();
    worker.onmessage = (event) => responseHandlerRef.current(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      workerFailureHandlerRef.current(
        QUEUE_ERROR_CODES.WORKER_CRASH,
        "The image worker crashed while processing this file.",
      );
    };
    worker.onmessageerror = () => {
      workerFailureHandlerRef.current(
        QUEUE_ERROR_CODES.WORKER_MESSAGE_ERROR,
        "The image worker returned an unreadable message.",
      );
    };
    workerRef.current = worker;
    return worker;
  }, []);

  const recreateWorker = useCallback((): void => {
    detachAndTerminateWorker();
    if (mountedRef.current) createWorker();
  }, [createWorker, detachAndTerminateWorker]);

  const revokeAssetPreview = useCallback((assetId: string): void => {
    const asset = stateRef.current.assets.find((candidate) => candidate.id === assetId);
    revokeUrl(asset?.previewUrl ?? null);
  }, []);

  const failActive = useCallback((
    code: string,
    message: string,
    rebuildWorker: boolean,
  ): void => {
    const active = activeRef.current;
    if (active === null) {
      if (rebuildWorker) recreateWorker();
      return;
    }
    activeRef.current = null;
    if (active.kind === "export") {
      active.reject(new AnalysisQueueError(code, message));
      wakeQueue();
    } else {
      revokeAssetPreview(active.assetId);
      dispatch({
        type: "fail",
        assetId: active.assetId,
        revision: active.revision,
        error: { code, message },
      });
    }
    if (rebuildWorker) recreateWorker();
  }, [dispatch, recreateWorker, revokeAssetPreview]);

  const handleWorkerFailure = useCallback((code: string, message: string): void => {
    failActive(code, message, true);
  }, [failActive]);

  const handleResponse = useCallback((response: WorkerResponse): void => {
    const active = activeRef.current;
    if (active === null || response.assetId !== active.assetId ||
        response.requestId !== active.requestId || response.revision !== active.revision) {
      return;
    }

    if (response.type === "PROGRESS") {
      if (active.kind !== "export") {
        dispatch({
          type: "progress",
          assetId: active.assetId,
          revision: active.revision,
          progress: { stage: response.stage, value: response.value },
        });
      }
      return;
    }

    if (response.type === "ERROR") {
      activeRef.current = null;
      if (active.kind === "export") {
        active.reject(new AnalysisQueueError(response.error.code, response.error.message));
        wakeQueue();
      } else {
        revokeAssetPreview(active.assetId);
        dispatch({
          type: "fail",
          assetId: active.assetId,
          revision: active.revision,
          error: response.error,
        });
      }
      return;
    }

    if (response.type === "EXPORT_COMPLETE") {
      if (active.kind !== "export") return;
      activeRef.current = null;
      active.resolve({
        blob: response.blob,
        width: response.width,
        height: response.height,
        filename: response.filename,
        warnings: response.warnings,
      });
      wakeQueue();
      return;
    }

    if (active.kind === "export") return;
    const asset = stateRef.current.assets.find((candidate) => candidate.id === active.assetId);
    if (asset === undefined || asset.revision !== active.revision) return;
    let previewUrl: string;
    try {
      previewUrl = URL.createObjectURL(response.preview);
    } catch {
      failActive(
        QUEUE_ERROR_CODES.PREVIEW_URL_FAILED,
        "The browser could not create a preview URL.",
        false,
      );
      return;
    }
    revokeUrl(asset.previewUrl);
    activeRef.current = null;
    dispatch({
      type: "complete",
      assetId: active.assetId,
      revision: active.revision,
      result: {
        metadata: response.metadata,
        sourceSize: response.sourceSize,
        previewUrl,
        detection: response.detection,
        quality: response.quality,
      },
    });
  }, [dispatch, failActive, revokeAssetPreview]);

  useEffect(() => {
    responseHandlerRef.current = handleResponse;
    workerFailureHandlerRef.current = handleWorkerFailure;
  }, [handleResponse, handleWorkerFailure]);

  useEffect(() => {
    mountedRef.current = true;
    createWorker();
    return () => {
      mountedRef.current = false;
      const active = activeRef.current;
      activeRef.current = null;
      if (active?.kind === "export") {
        active.reject(new AnalysisQueueError(
          QUEUE_ERROR_CODES.EXPORT_CANCELLED,
          "The export was cancelled because the analysis queue was closed.",
        ));
      }
      const urls = new Set(stateRef.current.assets.flatMap((asset) =>
        asset.previewUrl === null ? [] : [asset.previewUrl],
      ));
      for (const url of urls) URL.revokeObjectURL(url);
      detachAndTerminateWorker();
    };
  }, [createWorker, detachAndTerminateWorker]);

  useEffect(() => {
    if (activeRef.current !== null || workerRef.current === null) return;
    const asset = state.assets.find((candidate) => candidate.status === "queued");
    if (asset === undefined) return;

    const requestId = idFactoryRef.current();
    const manual = asset.manualCircle !== null;
    const active: ActiveAnalysis = {
      kind: manual ? "manual" : "analysis",
      assetId: asset.id,
      requestId,
      revision: asset.revision,
    };
    const request: WorkerRequest = manual
      ? {
        type: "REANALYZE_CIRCLE",
        assetId: asset.id,
        requestId,
        revision: asset.revision,
        file: asset.file,
        circle: asset.manualCircle as NormalizedCircle,
      }
      : {
        type: "ANALYZE_FILE",
        assetId: asset.id,
        requestId,
        revision: asset.revision,
        file: asset.file,
      };
    activeRef.current = active;
    dispatch({
      type: "progress",
      assetId: asset.id,
      revision: asset.revision,
      progress: { stage: "metadata", value: 0 },
    });
    try {
      workerRef.current.postMessage(request);
    } catch {
      failActive(
        QUEUE_ERROR_CODES.WORKER_POST_FAILED,
        "The file could not be sent to the image worker.",
        true,
      );
    }
  }, [dispatch, failActive, schedulerVersion, state.assets]);

  const addFiles = useCallback((files: readonly File[] | FileList): AddFilesResult => {
    const incoming = Array.from(files);
    const available = Math.max(
      0,
      analysisConfig.maxFilesPerBatch - stateRef.current.assets.length,
    );
    const records: AssetRecord[] = [];
    const rejected: AddFileRejection[] = [];
    const queuedIds: string[] = [];

    incoming.forEach((file, index) => {
      if (index >= available) {
        rejected.push({
          file,
          error: {
            code: QUEUE_ERROR_CODES.MAX_FILES_EXCEEDED,
            message: "A batch can contain at most 50 files.",
          },
        });
        return;
      }
      const error = guardedFileError(file);
      const record = createAssetRecord({
        id: idFactoryRef.current(),
        ingestIndex: nextIngestIndexRef.current,
        file,
        ...(error === null ? {} : { error }),
      });
      nextIngestIndexRef.current += 1;
      records.push(record);
      if (error === null) queuedIds.push(record.id);
    });
    dispatch({ type: "add", assets: records });
    return {
      addedIds: records.map((record) => record.id),
      queuedIds,
      rejected,
    };
  }, [dispatch]);

  const cancelAsset = useCallback((assetId: string): boolean => {
    const asset = stateRef.current.assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined || (asset.status !== "queued" && asset.status !== "running")) {
      return false;
    }
    revokeUrl(asset.previewUrl);
    const active = activeRef.current;
    if (active !== null && active.kind !== "export" && active.assetId === assetId) {
      activeRef.current = null;
      recreateWorker();
    }
    dispatch({ type: "cancel", assetId, revision: asset.revision });
    return true;
  }, [dispatch, recreateWorker]);

  const retryAsset = useCallback((assetId: string): boolean => {
    const asset = stateRef.current.assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined || !["failed", "cancelled", "needs-review", "ready"].includes(asset.status)) {
      return false;
    }
    revokeUrl(asset.previewUrl);
    dispatch({ type: "retry", assetId });
    return true;
  }, [dispatch]);

  const reanalyzeCircle = useCallback((
    assetId: string,
    circle: NormalizedCircle,
  ): boolean => {
    if (!isValidNormalizedCircle(circle)) return false;
    const asset = stateRef.current.assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined || (asset.status !== "needs-review" && asset.status !== "ready")) {
      return false;
    }
    dispatch({ type: "queue-manual", assetId, circle });
    return true;
  }, [dispatch]);

  const clear = useCallback((): void => {
    const urls = new Set(stateRef.current.assets.flatMap((asset) =>
      asset.previewUrl === null ? [] : [asset.previewUrl],
    ));
    for (const url of urls) URL.revokeObjectURL(url);
    const active = activeRef.current;
    activeRef.current = null;
    if (active?.kind === "export") {
      active.reject(new AnalysisQueueError(
        QUEUE_ERROR_CODES.EXPORT_CANCELLED,
        "The export was cancelled because the analysis queue was cleared.",
      ));
    }
    recreateWorker();
    nextIngestIndexRef.current = 0;
    dispatch({ type: "clear" });
  }, [dispatch, recreateWorker]);

  const exportAsset = useCallback((
    assetId: string,
    exportOptions: ExportAssetOptions,
  ): Promise<ExportResult> => {
    const busy = activeRef.current !== null || stateRef.current.assets.some((asset) =>
      asset.status === "queued" || asset.status === "running",
    );
    if (busy) {
      return Promise.reject(new AnalysisQueueError(
        QUEUE_ERROR_CODES.EXPORT_NOT_IDLE,
        "Export is only available while the analysis queue is idle.",
      ));
    }
    const asset = stateRef.current.assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined || asset.detection === null ||
        (asset.status !== "ready" && asset.status !== "needs-review")) {
      return Promise.reject(new AnalysisQueueError(
        QUEUE_ERROR_CODES.EXPORT_ASSET_NOT_READY,
        "The selected asset does not have an exportable moon circle.",
      ));
    }
    const circle = asset.detection.circle;
    const worker = workerRef.current;
    if (worker === null) {
      return Promise.reject(new AnalysisQueueError(
        QUEUE_ERROR_CODES.WORKER_CRASH,
        "The image worker is unavailable.",
      ));
    }

    return new Promise<ExportResult>((resolve, reject) => {
      const requestId = idFactoryRef.current();
      const active: ActiveExport = {
        kind: "export",
        assetId,
        requestId,
        revision: asset.revision,
        resolve,
        reject,
      };
      activeRef.current = active;
      try {
        worker.postMessage({
          type: "EXPORT_FILE",
          assetId,
          requestId,
          revision: asset.revision,
          file: asset.file,
          circle,
          crop: exportOptions.crop,
          format: exportOptions.format,
          capturedAt: asset.metadata?.capturedAt ?? null,
        });
      } catch (error) {
        activeRef.current = null;
        reject(new AnalysisQueueError(
          QUEUE_ERROR_CODES.WORKER_POST_FAILED,
          "The export could not be sent to the image worker.",
          error,
        ));
        recreateWorker();
        wakeQueue();
      }
    });
  }, [recreateWorker]);

  const ranked = useMemo(() => selectRankedAssets(state), [state]);

  return {
    state,
    assets: state.assets,
    ranked,
    addFiles,
    cancelAsset,
    retryAsset,
    reanalyzeCircle,
    clear,
    exportAsset,
  };
}
