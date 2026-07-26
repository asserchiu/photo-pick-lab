import ExifReader from "exifreader";

import { analysisConfig } from "../config/analysis";
import type { Size } from "../domain/types";
import { rgbaToLuminance } from "../imaging/primitives";

export type PhotoFormat = "image/jpeg" | "image/png";

export interface PhotoMetadata {
  orientation: number | null;
  capturedAt: string | null;
  camera: string | null;
  iso: number | null;
  exposureTime: number | null;
  fNumber: number | null;
  focalLength: number | null;
}

export function formatCapturedAt(value: string | null): string | null {
  return value?.replace(/^(\d{4}):(\d{2}):(\d{2})(?=\s|$)/u, "$1-$2-$3") ?? null;
}

export const PHOTO_ERROR_CODES = {
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  DECODE_FAILED: "DECODE_FAILED",
  DECODED_IMAGE_TOO_LARGE: "DECODED_IMAGE_TOO_LARGE",
  INVALID_IMAGE_SIZE: "INVALID_IMAGE_SIZE",
  CANVAS_UNAVAILABLE: "CANVAS_UNAVAILABLE",
  CANVAS_CONTEXT_UNAVAILABLE: "CANVAS_CONTEXT_UNAVAILABLE",
  IMAGE_DATA_FAILED: "IMAGE_DATA_FAILED",
  PREVIEW_FAILED: "PREVIEW_FAILED",
} as const;

export type PhotoErrorCode =
  (typeof PHOTO_ERROR_CODES)[keyof typeof PHOTO_ERROR_CODES];

const PHOTO_ERROR_MESSAGES: Record<PhotoErrorCode, string> = {
  UNSUPPORTED_FORMAT: "The file is not a supported JPEG or PNG image.",
  FILE_TOO_LARGE: "The file exceeds the 150 MiB size limit.",
  DECODE_FAILED: "The browser could not decode this image with its EXIF orientation applied.",
  DECODED_IMAGE_TOO_LARGE: "The decoded image exceeds the 80 megapixel limit.",
  INVALID_IMAGE_SIZE: "The decoded image has invalid dimensions.",
  CANVAS_UNAVAILABLE: "This browser does not provide the required OffscreenCanvas API.",
  CANVAS_CONTEXT_UNAVAILABLE: "The browser could not create a 2D image-processing context.",
  IMAGE_DATA_FAILED: "The browser could not read pixels from the decoded image.",
  PREVIEW_FAILED: "The browser could not create an image preview.",
};

export class PhotoPipelineError extends Error {
  readonly code: PhotoErrorCode;

  constructor(code: PhotoErrorCode, cause?: unknown) {
    super(PHOTO_ERROR_MESSAGES[code], { cause });
    this.name = "PhotoPipelineError";
    this.code = code;
  }
}

interface ExifLoadOptions {
  async: true;
  computed: true;
  includeTags: {
    exif: string[];
  };
}

export interface ExifReaderAdapter {
  load(file: File, options: ExifLoadOptions): Promise<unknown>;
}

const exifOptions: ExifLoadOptions = {
  async: true,
  computed: true,
  // Request an explicit allowlist so GPS and unrelated raw EXIF never enter the adapter result.
  includeTags: {
    exif: [
      "Orientation",
      "DateTimeOriginal",
      "DateTimeDigitized",
      "DateTime",
      "Make",
      "Model",
      "ISOSpeedRatings",
      "ExposureTime",
      "FNumber",
      "FocalLength",
    ],
  },
};

const defaultExifReader: ExifReaderAdapter = {
  load: async (file, options) => ExifReader.load(file, options),
};

const emptyMetadata = (): PhotoMetadata => ({
  orientation: null,
  capturedAt: null,
  camera: null,
  iso: null,
  exposureTime: null,
  fNumber: null,
  focalLength: null,
});

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? value as UnknownRecord
    : null;
}

function tagCandidate(tag: unknown): unknown[] {
  const record = asRecord(tag);
  if (record === null) return [];
  return [record.computed, record.value, record.description];
}

function finiteNumber(tag: unknown): number | null {
  for (const candidate of tagCandidate(tag)) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (Array.isArray(candidate)) {
      if (candidate.length === 2) {
        const numerator = candidate[0];
        const denominator = candidate[1];
        if (typeof numerator === "number" && typeof denominator === "number" &&
            Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
          return numerator / denominator;
        }
      }
      const first = candidate[0];
      if (typeof first === "number" && Number.isFinite(first)) return first;
    }
  }
  return null;
}

function textValue(tag: unknown): string | null {
  for (const candidate of tagCandidate(tag)) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    if (Array.isArray(candidate) && candidate.every((part) => typeof part === "string")) {
      const text = candidate.join(" ").trim();
      if (text !== "") return text;
    }
  }
  return null;
}

function cameraName(make: string | null, model: string | null): string | null {
  if (make === null) return model;
  if (model === null) return make;
  return model.toLocaleLowerCase().startsWith(make.toLocaleLowerCase())
    ? model
    : `${make} ${model}`;
}

export async function detectPhotoFormat(file: Blob): Promise<PhotoFormat> {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  if (bytes.length >= pngSignature.length &&
      pngSignature.every((value, index) => bytes[index] === value)) {
    return "image/png";
  }
  throw new PhotoPipelineError(PHOTO_ERROR_CODES.UNSUPPORTED_FORMAT);
}

const jpegStartOfFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

async function readByte(file: Blob, offset: number): Promise<number | null> {
  const bytes = new Uint8Array(await file.slice(offset, offset + 1).arrayBuffer());
  return bytes[0] ?? null;
}

async function readJpegEncodedSize(file: Blob): Promise<Size | null> {
  let offset = 2;
  // JPEG dimensions live before the first scan. Skip segment payloads by their
  // declared lengths so a large EXIF block is never copied into memory.
  for (let segmentCount = 0; segmentCount < 512 && offset < file.size; segmentCount += 1) {
    const prefix = await readByte(file, offset);
    offset += 1;
    if (prefix !== 0xff) return null;

    let marker = await readByte(file, offset);
    offset += 1;
    let paddingBytes = 0;
    while (marker === 0xff && offset < file.size && paddingBytes < 16) {
      marker = await readByte(file, offset);
      offset += 1;
      paddingBytes += 1;
    }
    if (marker === null || marker === 0xff || marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;

    const header = new Uint8Array(await file.slice(offset, offset + 7).arrayBuffer());
    if (header.length < 2) return null;
    const segmentLength = (header[0] ?? 0) * 256 + (header[1] ?? 0);
    if (segmentLength < 2) return null;
    if (jpegStartOfFrameMarkers.has(marker)) {
      if (header.length < 7) return null;
      return {
        width: (header[5] ?? 0) * 256 + (header[6] ?? 0),
        height: (header[3] ?? 0) * 256 + (header[4] ?? 0),
      };
    }
    offset += segmentLength;
  }
  return null;
}

export async function readEncodedSize(file: Blob, format: PhotoFormat): Promise<Size | null> {
  if (format === "image/jpeg") return readJpegEncodedSize(file);
  const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  if (header.length < 24 || String.fromCharCode(...header.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export async function readPhotoMetadata(
  file: File,
  adapter: ExifReaderAdapter = defaultExifReader,
): Promise<PhotoMetadata> {
  try {
    const tags = asRecord(await adapter.load(file, exifOptions));
    if (tags === null) return emptyMetadata();
    const orientationValue = finiteNumber(tags.Orientation);
    const orientation = orientationValue !== null && Number.isInteger(orientationValue) &&
      orientationValue >= 1 && orientationValue <= 8
      ? orientationValue
      : null;
    const make = textValue(tags.Make);
    const model = textValue(tags.Model);
    return {
      orientation,
      capturedAt: textValue(tags.DateTimeOriginal) ??
        textValue(tags.DateTimeDigitized) ?? textValue(tags.DateTime),
      camera: cameraName(make, model),
      iso: finiteNumber(tags.ISOSpeedRatings),
      exposureTime: finiteNumber(tags.ExposureTime),
      fNumber: finiteNumber(tags.FNumber),
      focalLength: finiteNumber(tags.FocalLength),
    };
  } catch {
    // Missing or malformed metadata must not turn an otherwise valid photo into a failed asset.
    return emptyMetadata();
  }
}

export function validateFileSize(file: Blob): void {
  if (file.size > analysisConfig.maxFileBytes) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.FILE_TOO_LARGE);
  }
}

export function validateDecodedSize(size: Size): void {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) ||
      size.width <= 0 || size.height <= 0) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.INVALID_IMAGE_SIZE);
  }
  if (size.width * size.height > analysisConfig.maxDecodedPixels) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.DECODED_IMAGE_TOO_LARGE);
  }
}

export async function decodeUprightBitmap(file: File): Promise<ImageBitmap> {
  if (typeof globalThis.createImageBitmap !== "function") {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.DECODE_FAILED);
  }
  try {
    // Omitting this option would silently analyze sensor orientation in partial implementations.
    return await globalThis.createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.DECODE_FAILED, error);
  }
}

function scaledSize(source: Size, maximumLongEdge: number): Size {
  if (!Number.isFinite(maximumLongEdge) || maximumLongEdge <= 0) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.INVALID_IMAGE_SIZE);
  }
  const scale = Math.min(1, maximumLongEdge / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

export interface Canvas2D {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
}

export function createCanvas2D(width: number, height: number): Canvas2D {
  if (typeof globalThis.OffscreenCanvas !== "function") {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.CANVAS_UNAVAILABLE);
  }
  const canvas = new globalThis.OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.CANVAS_CONTEXT_UNAVAILABLE);
  }
  return { canvas, context };
}

function drawScaledBitmap(bitmap: ImageBitmap, maximumLongEdge: number): Canvas2D {
  const size = scaledSize(
    { width: bitmap.width, height: bitmap.height },
    maximumLongEdge,
  );
  const rendered = createCanvas2D(size.width, size.height);
  rendered.context.drawImage(bitmap, 0, 0, size.width, size.height);
  return rendered;
}

export function bitmapToImageData(
  bitmap: ImageBitmap,
  maximumLongEdge: number,
): ImageData {
  const { context } = drawScaledBitmap(bitmap, maximumLongEdge);
  try {
    return context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  } catch (error) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.IMAGE_DATA_FAILED, error);
  }
}

export function imageDataToLuminance(imageData: ImageData): Float32Array {
  return rgbaToLuminance(imageData.data, imageData.width, imageData.height);
}

export async function createPreviewBlob(
  bitmap: ImageBitmap,
  maximumLongEdge = analysisConfig.previewLongEdge,
): Promise<Blob> {
  const { canvas } = drawScaledBitmap(bitmap, maximumLongEdge);
  try {
    return await canvas.convertToBlob({
      type: "image/jpeg",
      quality: analysisConfig.jpegQuality,
    });
  } catch (error) {
    throw new PhotoPipelineError(PHOTO_ERROR_CODES.PREVIEW_FAILED, error);
  }
}
