import {
  CROP_ASPECT_RATIOS,
  CROP_ERROR_CODES,
  type CropOptions,
  type CropResult,
  type NormalizedCircle,
  type PixelCircle,
  type Point2D,
  type Rect,
  type Size,
} from "../domain/types";

const EPSILON = 1e-9;

export function isValidSize(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) &&
    size.width > 0 && size.height > 0;
}

export function normalizedCircleToPixels(
  circle: NormalizedCircle,
  size: Size,
): PixelCircle | null {
  if (!isValidSize(size) || !isValidNormalizedCircle(circle)) return null;
  return {
    centerX: circle.centerX * size.width,
    centerY: circle.centerY * size.height,
    radius: circle.radius * Math.min(size.width, size.height),
  };
}

export function pixelCircleToNormalized(
  circle: PixelCircle,
  size: Size,
): NormalizedCircle | null {
  if (!isValidSize(size) || !isValidPixelCircle(circle)) return null;
  return {
    centerX: circle.centerX / size.width,
    centerY: circle.centerY / size.height,
    radius: circle.radius / Math.min(size.width, size.height),
  };
}

export function mapCircleBetweenSizes(
  circle: PixelCircle,
  sourceSize: Size,
  targetSize: Size,
): PixelCircle | null {
  const normalized = pixelCircleToNormalized(circle, sourceSize);
  return normalized === null ? null : normalizedCircleToPixels(normalized, targetSize);
}

export function isValidNormalizedCircle(circle: NormalizedCircle): boolean {
  return Number.isFinite(circle.centerX) && Number.isFinite(circle.centerY) &&
    Number.isFinite(circle.radius) && circle.centerX >= 0 && circle.centerX <= 1 &&
    circle.centerY >= 0 && circle.centerY <= 1 && circle.radius > 0;
}

export function isValidPixelCircle(circle: PixelCircle): boolean {
  return Number.isFinite(circle.centerX) && Number.isFinite(circle.centerY) &&
    Number.isFinite(circle.radius) && circle.radius > 0;
}

export function containFitRect(sourceSize: Size, container: Rect): Rect | null {
  if (!isValidSize(sourceSize) || !isValidSize(container) ||
      !Number.isFinite(container.x) || !Number.isFinite(container.y)) {
    return null;
  }
  const scale = Math.min(container.width / sourceSize.width, container.height / sourceSize.height);
  const width = sourceSize.width * scale;
  const height = sourceSize.height * scale;
  return {
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    width,
    height,
  };
}

export function pointerToNormalized(
  pointer: Point2D,
  renderedRect: Rect,
): Point2D | null {
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y) || !isValidSize(renderedRect)) {
    return null;
  }
  const x = (pointer.x - renderedRect.x) / renderedRect.width;
  const y = (pointer.y - renderedRect.y) / renderedRect.height;
  if (x < -EPSILON || x > 1 + EPSILON || y < -EPSILON || y > 1 + EPSILON) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export function normalizedToRendered(
  point: Point2D,
  renderedRect: Rect,
): Point2D | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !isValidSize(renderedRect)) {
    return null;
  }
  return {
    x: renderedRect.x + point.x * renderedRect.width,
    y: renderedRect.y + point.y * renderedRect.height,
  };
}

function resolveAspectRatio(options: CropOptions): number {
  return typeof options.aspectRatio === "number"
    ? options.aspectRatio
    : CROP_ASPECT_RATIOS[options.aspectRatio];
}

function cropDimensions(shortSide: number, aspectRatio: number): Size {
  return aspectRatio >= 1
    ? { width: shortSide * aspectRatio, height: shortSide }
    : { width: shortSide, height: shortSide / aspectRatio };
}

function maximumCenteredShortSide(
  circle: PixelCircle,
  sourceSize: Size,
  aspectRatio: number,
): number {
  const left = circle.centerX;
  const right = sourceSize.width - circle.centerX;
  const top = circle.centerY;
  const bottom = sourceSize.height - circle.centerY;
  if (aspectRatio >= 1) {
    return Math.max(0, Math.min(
      2 * left / aspectRatio,
      2 * right / aspectRatio,
      2 * top,
      2 * bottom,
    ));
  }
  return Math.max(0, Math.min(
    2 * left,
    2 * right,
    2 * top * aspectRatio,
    2 * bottom * aspectRatio,
  ));
}

export function centeredCrop(
  sourceSize: Size,
  circle: NormalizedCircle,
  options: CropOptions,
): CropResult {
  if (!isValidSize(sourceSize)) {
    return { ok: false, errorCode: CROP_ERROR_CODES.INVALID_SOURCE_SIZE, minimumFill: null };
  }
  const pixelCircle = normalizedCircleToPixels(circle, sourceSize);
  if (pixelCircle === null || pixelCircle.centerX < 0 || pixelCircle.centerX > sourceSize.width ||
      pixelCircle.centerY < 0 || pixelCircle.centerY > sourceSize.height) {
    return { ok: false, errorCode: CROP_ERROR_CODES.INVALID_CIRCLE, minimumFill: null };
  }
  const aspectRatio = resolveAspectRatio(options);
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { ok: false, errorCode: CROP_ERROR_CODES.INVALID_ASPECT_RATIO, minimumFill: null };
  }
  if (!Number.isFinite(options.fill) || options.fill <= 0 || options.fill > 1) {
    return { ok: false, errorCode: CROP_ERROR_CODES.INVALID_FILL, minimumFill: null };
  }

  const diameter = pixelCircle.radius * 2;
  const maximumShortSide = maximumCenteredShortSide(pixelCircle, sourceSize, aspectRatio);
  const minimumFill = maximumShortSide > 0 ? diameter / maximumShortSide : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(minimumFill) || options.fill + EPSILON < minimumFill) {
    return {
      ok: false,
      errorCode: CROP_ERROR_CODES.CROP_EXCEEDS_SOURCE,
      minimumFill: Number.isFinite(minimumFill) ? minimumFill : null,
    };
  }

  const shortSide = diameter / options.fill;
  const dimensions = cropDimensions(shortSide, aspectRatio);
  return {
    ok: true,
    rect: {
      x: pixelCircle.centerX - dimensions.width / 2,
      y: pixelCircle.centerY - dimensions.height / 2,
      width: dimensions.width,
      height: dimensions.height,
    },
    aspectRatio,
    requestedFill: options.fill,
    actualFill: diameter / Math.min(dimensions.width, dimensions.height),
    minimumFill,
  };
}
