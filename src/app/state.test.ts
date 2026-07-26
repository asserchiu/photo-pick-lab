import { testDetection, testMetadata, testQuality } from "../test/analysisFixtures";
import {
  analysisReducer,
  createAssetRecord,
  initialAnalysisState,
  selectRankedAssets,
  type AnalysisCompletion,
  type AnalysisState,
} from "./state";

function file(name: string): File {
  return new File([name], name, { type: "image/jpeg" });
}

function completion(
  previewUrl: string,
  confidence = 0.9,
  quality = 0.5,
  method: "circle-fit" | "component-bounds" | "manual" = "circle-fit",
): AnalysisCompletion {
  return {
    metadata: testMetadata,
    sourceSize: { width: 4000, height: 3000 },
    previewUrl,
    detection: testDetection(confidence, method),
    quality: testQuality(quality),
  };
}

function addAsset(
  state: AnalysisState,
  id: string,
  ingestIndex = 0,
): AnalysisState {
  return analysisReducer(state, {
    type: "add",
    assets: [createAssetRecord({ id, ingestIndex, file: file(`${id}.jpg`) })],
  });
}

describe("analysisReducer", () => {
  it("ignores a completion from an earlier revision", () => {
    let state = addAsset(initialAnalysisState, "asset-1");
    state = analysisReducer(state, {
      type: "fail",
      assetId: "asset-1",
      revision: 1,
      error: { code: "DECODE_FAILED", message: "decode failed" },
    });
    state = analysisReducer(state, { type: "retry", assetId: "asset-1" });
    expect(state.assets[0]).toMatchObject({ revision: 2, status: "queued" });

    const afterStale = analysisReducer(state, {
      type: "complete",
      assetId: "asset-1",
      revision: 1,
      result: completion("blob:stale"),
    });
    expect(afterStale).toBe(state);
    expect(afterStale.assets[0]).toMatchObject({
      revision: 2,
      status: "queued",
      previewUrl: null,
    });
  });

  it("uses confidence for needs-review and accepts a confirmed manual circle", () => {
    let state = addAsset(initialAnalysisState, "asset-1");
    state = analysisReducer(state, {
      type: "progress",
      assetId: "asset-1",
      revision: 1,
      progress: { stage: "detect", value: 0.5 },
    });
    expect(state.assets[0]).toMatchObject({
      status: "running",
      progress: { stage: "detect", value: 0.5 },
    });

    state = analysisReducer(state, {
      type: "complete",
      assetId: "asset-1",
      revision: 1,
      result: completion("blob:placeholder", 0, 0.4, "manual"),
    });
    expect(state.assets[0]).toMatchObject({ status: "needs-review" });
    expect(selectRankedAssets(state)).toEqual([]);

    const circle = { centerX: 0.45, centerY: 0.52, radius: 0.16 };
    state = analysisReducer(state, { type: "queue-manual", assetId: "asset-1", circle });
    expect(state.assets[0]).toMatchObject({
      status: "queued",
      revision: 2,
      manualCircle: circle,
    });
    state = analysisReducer(state, {
      type: "complete",
      assetId: "asset-1",
      revision: 2,
      result: {
        ...completion("blob:manual", 1, 0.7, "manual"),
        detection: { ...testDetection(1, "manual"), circle },
      },
    });
    expect(state.assets[0]).toMatchObject({ status: "ready", previewUrl: "blob:manual" });
  });

  it("keeps failures and cancellation explicit instead of assigning scores", () => {
    let state = addAsset(initialAnalysisState, "failed");
    state = addAsset(state, "cancelled", 1);
    state = analysisReducer(state, {
      type: "fail",
      assetId: "failed",
      revision: 1,
      error: { code: "UNSUPPORTED_FORMAT", message: "unsupported" },
    });
    state = analysisReducer(state, { type: "cancel", assetId: "cancelled", revision: 1 });

    expect(state.assets.map((asset) => asset.status)).toEqual(["failed", "cancelled"]);
    expect(selectRankedAssets(state)).toEqual([]);
  });
});

describe("selectRankedAssets", () => {
  it("ranks ready assets together with provisional automatic detections", () => {
    let state = addAsset(initialAnalysisState, "lower", 0);
    state = addAsset(state, "higher", 1);
    state = addAsset(state, "review", 2);
    state = analysisReducer(state, {
      type: "complete",
      assetId: "lower",
      revision: 1,
      result: completion("blob:lower", 0.9, 0.2),
    });
    state = analysisReducer(state, {
      type: "complete",
      assetId: "higher",
      revision: 1,
      result: completion("blob:higher", 0.9, 0.9),
    });
    state = analysisReducer(state, {
      type: "complete",
      assetId: "review",
      revision: 1,
      result: completion("blob:review", 0.69, 1),
    });

    const ranked = selectRankedAssets(state);
    expect(ranked.map((candidate) => candidate.assetId)).toEqual(["review", "higher", "lower"]);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? Number.POSITIVE_INFINITY);
  });

  it("does not provisionally rank a low-contrast false positive", () => {
    let state = addAsset(initialAnalysisState, "stars", 0);
    const result = completion("blob:stars", 0.58, 0.9);
    result.detection.diagnostics.warnings.push("low-radial-contrast");
    state = analysisReducer(state, {
      type: "complete",
      assetId: "stars",
      revision: 1,
      result,
    });

    expect(state.assets[0]?.status).toBe("needs-review");
    expect(selectRankedAssets(state)).toEqual([]);
  });
});
