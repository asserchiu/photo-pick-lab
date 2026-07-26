import { act, renderHook, waitFor } from "@testing-library/react";

import { analysisConfig } from "../config/analysis";
import { testAnalysisResponse, testMetadata } from "../test/analysisFixtures";
import type { WorkerRequest, WorkerResponse } from "../workers/protocol";
import {
  QUEUE_ERROR_CODES,
  useAnalysisQueue,
  type WorkerLike,
} from "./useAnalysisQueue";

class MockWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly messages: WorkerRequest[] = [];
  terminateCount = 0;

  postMessage(message: WorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: WorkerResponse): void {
    this.onmessage?.(new MessageEvent("message", { data: message }));
  }

  emitMessageError(): void {
    this.onmessageerror?.(new MessageEvent("messageerror"));
  }
}

function file(name: string, type = "image/jpeg"): File {
  return new File([name], name, { type });
}

function sequenceIdFactory(): () => string {
  let id = 0;
  return () => {
    id += 1;
    return `id-${id}`;
  };
}

function requestAt(worker: MockWorker, index: number): WorkerRequest {
  const request = worker.messages[index];
  if (request === undefined) throw new Error(`Missing worker request ${index}`);
  return request;
}

function envelope(request: WorkerRequest) {
  return {
    assetId: request.assetId,
    requestId: request.requestId,
    revision: request.revision,
  };
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  let preview = 0;
  createObjectURL = vi.fn(() => {
    preview += 1;
    return `blob:test-${preview}`;
  });
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAnalysisQueue", () => {
  it("runs one file at a time and keeps progress and failures per file", async () => {
    const workers: MockWorker[] = [];
    const { result } = renderHook(() => useAnalysisQueue({
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: sequenceIdFactory(),
    }));

    act(() => {
      result.current.addFiles([file("first.jpg"), file("second.jpg")]);
    });
    const worker = workers[0];
    if (worker === undefined) throw new Error("Worker was not created");
    await waitFor(() => expect(worker.messages).toHaveLength(1));
    const first = requestAt(worker, 0);
    expect(first.type).toBe("ANALYZE_FILE");

    act(() => {
      worker.emit({
        type: "PROGRESS",
        ...envelope(first),
        stage: "detect",
        value: 0.55,
      });
    });
    expect(result.current.assets[0]).toMatchObject({
      status: "running",
      progress: { stage: "detect", value: 0.55 },
    });
    expect(worker.messages).toHaveLength(1);

    act(() => {
      worker.emit({
        type: "ERROR",
        ...envelope(first),
        error: { code: "DECODE_FAILED", message: "Could not decode." },
      });
    });
    await waitFor(() => expect(worker.messages).toHaveLength(2));
    expect(result.current.assets[0]).toMatchObject({
      status: "failed",
      error: { code: "DECODE_FAILED", message: "Could not decode." },
    });
    expect(result.current.assets[1]?.status).toBe("running");
    expect(workers).toHaveLength(1);
  });

  it("cancels queued work locally and recreates the worker for an active cancel", async () => {
    const workers: MockWorker[] = [];
    const { result } = renderHook(() => useAnalysisQueue({
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: sequenceIdFactory(),
    }));

    let ids: string[] = [];
    act(() => {
      ids = result.current.addFiles([
        file("active.jpg"),
        file("queued-cancel.jpg"),
        file("queued-next.jpg"),
      ]).addedIds;
    });
    const firstWorker = workers[0];
    if (firstWorker === undefined) throw new Error("Worker was not created");
    await waitFor(() => expect(firstWorker.messages).toHaveLength(1));

    act(() => {
      expect(result.current.cancelAsset(ids[1] ?? "")).toBe(true);
    });
    expect(firstWorker.terminateCount).toBe(0);
    expect(result.current.assets[1]?.status).toBe("cancelled");

    act(() => {
      expect(result.current.cancelAsset(ids[0] ?? "")).toBe(true);
    });
    expect(firstWorker.terminateCount).toBe(1);
    await waitFor(() => expect(workers).toHaveLength(2));
    const replacement = workers[1];
    if (replacement === undefined) throw new Error("Replacement worker was not created");
    await waitFor(() => expect(replacement.messages).toHaveLength(1));
    expect(requestAt(replacement, 0).assetId).toBe(ids[2]);
  });

  it("fails only the active file and rebuilds after a worker message error", async () => {
    const workers: MockWorker[] = [];
    const { result } = renderHook(() => useAnalysisQueue({
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: sequenceIdFactory(),
    }));

    act(() => {
      result.current.addFiles([file("broken.jpg"), file("next.jpg")]);
    });
    const firstWorker = workers[0];
    if (firstWorker === undefined) throw new Error("Worker was not created");
    await waitFor(() => expect(firstWorker.messages).toHaveLength(1));
    act(() => firstWorker.emitMessageError());

    expect(firstWorker.terminateCount).toBe(1);
    expect(result.current.assets[0]).toMatchObject({
      status: "failed",
      error: { code: QUEUE_ERROR_CODES.WORKER_MESSAGE_ERROR },
    });
    const replacement = workers[1];
    if (replacement === undefined) throw new Error("Replacement worker was not created");
    await waitFor(() => expect(replacement.messages).toHaveLength(1));
    expect(result.current.assets[1]?.status).toBe("running");
  });

  it("revokes replaced, cleared previews and terminates workers", async () => {
    const workers: MockWorker[] = [];
    const hook = renderHook(() => useAnalysisQueue({
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: sequenceIdFactory(),
    }));

    let assetId = "";
    act(() => {
      assetId = hook.result.current.addFiles([file("preview.jpg")]).addedIds[0] ?? "";
    });
    const worker = workers[0];
    if (worker === undefined) throw new Error("Worker was not created");
    await waitFor(() => expect(worker.messages).toHaveLength(1));
    const first = requestAt(worker, 0);
    act(() => worker.emit(testAnalysisResponse(envelope(first))));
    expect(hook.result.current.assets[0]?.previewUrl).toBe("blob:test-1");

    act(() => {
      expect(hook.result.current.reanalyzeCircle(assetId, {
        centerX: 0.48,
        centerY: 0.5,
        radius: 0.16,
      })).toBe(true);
    });
    await waitFor(() => expect(worker.messages).toHaveLength(2));
    const manual = requestAt(worker, 1);
    expect(manual.type).toBe("REANALYZE_CIRCLE");
    act(() => worker.emit(testAnalysisResponse(envelope(manual), {
      confidence: 1,
      method: "manual",
    })));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
    expect(hook.result.current.assets[0]?.previewUrl).toBe("blob:test-2");

    act(() => hook.result.current.clear());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-2");
    expect(worker.terminateCount).toBe(1);
    expect(hook.result.current.assets).toEqual([]);

    const replacement = workers[1];
    if (replacement === undefined) throw new Error("Replacement worker was not created");
    hook.unmount();
    expect(replacement.terminateCount).toBe(1);
  });

  it("applies batch guards and validates final file content in the worker", async () => {
    const workers: MockWorker[] = [];
    const { result } = renderHook(() => useAnalysisQueue({
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: sequenceIdFactory(),
    }));
    const oversized = file("oversized.jpg");
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: analysisConfig.maxFileBytes + 1,
    });
    const files = [oversized, file("wrong.gif", "image/gif")];
    for (let index = 0; index < analysisConfig.maxFilesPerBatch; index += 1) {
      files.push(file(`photo-${index}.jpg`));
    }

    let addResult: ReturnType<typeof result.current.addFiles> | undefined;
    act(() => {
      addResult = result.current.addFiles(files);
    });
    expect(addResult?.rejected).toHaveLength(2);
    expect(addResult?.rejected.every((item) =>
      item.error.code === QUEUE_ERROR_CODES.MAX_FILES_EXCEEDED)).toBe(true);
    expect(result.current.assets).toHaveLength(analysisConfig.maxFilesPerBatch);
    expect(result.current.assets[0]).toMatchObject({
      status: "failed",
      error: { code: QUEUE_ERROR_CODES.FILE_TOO_LARGE },
    });
    expect(result.current.assets[1]).toMatchObject({
      status: "running",
      error: null,
      file: { name: "wrong.gif", type: "image/gif" },
    });
    const worker = workers[0];
    if (worker === undefined) throw new Error("Worker was not created");
    await waitFor(() => expect(worker.messages).toHaveLength(1));
    expect(requestAt(worker, 0)).toMatchObject({ type: "ANALYZE_FILE", file: files[1] });
  });

  it("exports only while idle and resolves the worker export result", async () => {
    const workers: MockWorker[] = [];
    const { result } = renderHook(() => useAnalysisQueue({
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: sequenceIdFactory(),
    }));
    let assetId = "";
    act(() => {
      assetId = result.current.addFiles([file("export.jpg")]).addedIds[0] ?? "";
    });
    await expect(result.current.exportAsset(assetId, {
      crop: { mode: "fill", options: { aspectRatio: "1:1", fill: 0.75 } },
      format: "image/jpeg",
    })).rejects.toMatchObject({ code: QUEUE_ERROR_CODES.EXPORT_NOT_IDLE });

    const worker = workers[0];
    if (worker === undefined) throw new Error("Worker was not created");
    await waitFor(() => expect(worker.messages).toHaveLength(1));
    const analysis = requestAt(worker, 0);
    act(() => worker.emit(testAnalysisResponse(envelope(analysis))));

    const exportPromise = result.current.exportAsset(assetId, {
      crop: { mode: "fill", options: { aspectRatio: "1:1", fill: 0.75 } },
      format: "image/jpeg",
    });
    expect(worker.messages).toHaveLength(2);
    const exportRequest = requestAt(worker, 1);
    expect(exportRequest).toMatchObject({
      type: "EXPORT_FILE",
      capturedAt: testMetadata.capturedAt,
    });
    act(() => {
      result.current.addFiles([file("queued-during-export.jpg")]);
    });
    expect(worker.messages).toHaveLength(2);
    const output = new Blob(["crop"], { type: "image/jpeg" });
    act(() => {
      worker.emit({
        type: "EXPORT_COMPLETE",
        ...envelope(exportRequest),
        blob: output,
        width: 1200,
        height: 1200,
        filename: "export-moon-crop.jpg",
        warnings: ["EXIF metadata removed", "ICC color profile removed"],
      });
    });
    await expect(exportPromise).resolves.toEqual({
      blob: output,
      width: 1200,
      height: 1200,
      filename: "export-moon-crop.jpg",
      warnings: ["EXIF metadata removed", "ICC color profile removed"],
    });
    await waitFor(() => expect(worker.messages).toHaveLength(3));
    expect(requestAt(worker, 2).type).toBe("ANALYZE_FILE");
  });
});
