export const analysisConfig = {
  algorithmVersion: 1,
  maxFilesPerBatch: 50,
  maxFileBytes: 150 * 1024 * 1024,
  maxDecodedPixels: 80_000_000,
  searchLongEdge: 1280,
  previewLongEdge: 960,
  acceptedConfidence: 0.7,
  reviewConfidence: 0.4,
  jpegQuality: 0.9,
} as const

export const cropOptions = {
  aspectRatios: [
    { id: '1:1', label: '1:1', value: 1 },
    { id: '4:3', label: '4:3', value: 4 / 3 },
    { id: '3:2', label: '3:2', value: 3 / 2 },
    { id: '16:9', label: '16:9', value: 16 / 9 },
  ],
  fillRatios: [0.65, 0.75, 0.85, 0.95],
  defaultFillRatio: 0.85,
  fixedScaleRecommendation: {
    fill: 0.85,
    roundingIncrement: 100,
  },
} as const
