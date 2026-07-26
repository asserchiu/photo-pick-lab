import type { CropOptions, NormalizedCircle, Rect, Size } from '../domain/types'
import { isValidSize, normalizedCircleToPixels } from '../imaging/geometry'

export type CropMode = 'fill' | 'fixed-scale'

export type ExportCropSpec =
  | { mode: 'fill'; options: CropOptions }
  | { mode: 'fixed-scale'; size: Size }

export interface FixedSquareRecommendationOptions {
  fill: number
  roundingIncrement: number
}

export const FIXED_CROP_ERROR_CODES = {
  INVALID_SOURCE_SIZE: 'INVALID_SOURCE_SIZE',
  INVALID_TARGET_SIZE: 'INVALID_TARGET_SIZE',
  INVALID_CIRCLE: 'INVALID_CIRCLE',
  TARGET_CLIPS_MOON: 'TARGET_CLIPS_MOON',
  TARGET_EXCEEDS_SOURCE: 'TARGET_EXCEEDS_SOURCE',
} as const

export type FixedCropErrorCode =
  (typeof FIXED_CROP_ERROR_CODES)[keyof typeof FIXED_CROP_ERROR_CODES]

export interface FixedCropSuccess {
  ok: true
  rect: Rect
  outputSize: Size
  actualFill: number
}

export interface FixedCropFailure {
  ok: false
  errorCode: FixedCropErrorCode
  minimumShortSide: number | null
  maximumCenteredSize: Size | null
}

export type FixedCropResult = FixedCropSuccess | FixedCropFailure

function failure(
  errorCode: FixedCropErrorCode,
  minimumShortSide: number | null = null,
  maximumCenteredSize: Size | null = null,
): FixedCropFailure {
  return { ok: false, errorCode, minimumShortSide, maximumCenteredSize }
}

/**
 * Keeps one output pixel equal to one upright source pixel. Using the same
 * target size for photos from the same camera/focal length preserves visible
 * moon-size differences instead of normalizing every moon to a fill ratio.
 */
export function fixedSizeCrop(
  sourceSize: Size,
  circle: NormalizedCircle,
  requestedSize: Size,
): FixedCropResult {
  if (!isValidSize(sourceSize)) {
    return failure(FIXED_CROP_ERROR_CODES.INVALID_SOURCE_SIZE)
  }
  if (!Number.isInteger(requestedSize.width) || !Number.isInteger(requestedSize.height) ||
      requestedSize.width <= 0 || requestedSize.height <= 0) {
    return failure(FIXED_CROP_ERROR_CODES.INVALID_TARGET_SIZE)
  }

  const pixelCircle = normalizedCircleToPixels(circle, sourceSize)
  if (pixelCircle == null) return failure(FIXED_CROP_ERROR_CODES.INVALID_CIRCLE)

  const minimumShortSide = Math.ceil(pixelCircle.radius * 2)
  const maximumCenteredSize = {
    width: Math.max(0, Math.floor(2 * Math.min(
      pixelCircle.centerX,
      sourceSize.width - pixelCircle.centerX,
    ))),
    height: Math.max(0, Math.floor(2 * Math.min(
      pixelCircle.centerY,
      sourceSize.height - pixelCircle.centerY,
    ))),
  }

  if (Math.min(requestedSize.width, requestedSize.height) < minimumShortSide) {
    return failure(
      FIXED_CROP_ERROR_CODES.TARGET_CLIPS_MOON,
      minimumShortSide,
      maximumCenteredSize,
    )
  }
  if (requestedSize.width > maximumCenteredSize.width ||
      requestedSize.height > maximumCenteredSize.height) {
    return failure(
      FIXED_CROP_ERROR_CODES.TARGET_EXCEEDS_SOURCE,
      minimumShortSide,
      maximumCenteredSize,
    )
  }

  return {
    ok: true,
    rect: {
      x: pixelCircle.centerX - requestedSize.width / 2,
      y: pixelCircle.centerY - requestedSize.height / 2,
      width: requestedSize.width,
      height: requestedSize.height,
    },
    outputSize: requestedSize,
    actualFill: pixelCircle.radius * 2 / Math.min(requestedSize.width, requestedSize.height),
  }
}

export function recommendFixedSquareSize(
  sourceSize: Size,
  circle: NormalizedCircle,
  options: FixedSquareRecommendationOptions,
): Size | null {
  if (!isValidSize(sourceSize) || !Number.isFinite(options.fill) ||
      options.fill <= 0 || options.fill > 1 ||
      !Number.isInteger(options.roundingIncrement) || options.roundingIncrement <= 0) {
    return null
  }

  const pixelCircle = normalizedCircleToPixels(circle, sourceSize)
  if (pixelCircle == null) return null
  const rawSide = pixelCircle.radius * 2 / options.fill
  const scaledSide = rawSide / options.roundingIncrement
  const nearestIncrement = Math.round(scaledSide)
  // Absorb floating error at an exact increment so 500.00000000000006 does not jump to 600.
  const incrementCount = Math.abs(scaledSide - nearestIncrement) <= 1e-9
    ? nearestIncrement
    : Math.ceil(scaledSide)
  const desiredSide = Math.max(1, incrementCount * options.roundingIncrement)
  const desired = { width: desiredSide, height: desiredSide }
  const desiredCrop = fixedSizeCrop(sourceSize, circle, desired)
  if (desiredCrop.ok) return desired

  const maximum = desiredCrop.maximumCenteredSize
  if (maximum == null) return null
  const maximumSquareSide = Math.min(maximum.width, maximum.height)
  const fallback = { width: maximumSquareSide, height: maximumSquareSide }
  return fixedSizeCrop(sourceSize, circle, fallback).ok ? fallback : desired
}
