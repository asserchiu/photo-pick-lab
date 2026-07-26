import { describe, expect, it } from 'vitest'
import {
  FIXED_CROP_ERROR_CODES,
  fixedSizeCrop,
  recommendFixedSquareSize,
} from './crop'

const source = { width: 6000, height: 4000 }

describe('fixedSizeCrop', () => {
  it('keeps the requested source-pixel dimensions and exposes the derived fill', () => {
    const result = fixedSizeCrop(
      source,
      { centerX: 0.5, centerY: 0.5, radius: 0.05 },
      { width: 1920, height: 1080 },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rect).toEqual({ x: 2040, y: 1460, width: 1920, height: 1080 })
    expect(result.outputSize).toEqual({ width: 1920, height: 1080 })
    expect(result.actualFill).toBeCloseTo(400 / 1080)
  })

  it('preserves different apparent moon sizes at the same target dimensions', () => {
    const small = fixedSizeCrop(
      source,
      { centerX: 0.5, centerY: 0.5, radius: 0.04 },
      { width: 1920, height: 1080 },
    )
    const large = fixedSizeCrop(
      source,
      { centerX: 0.5, centerY: 0.5, radius: 0.05 },
      { width: 1920, height: 1080 },
    )

    expect(small.ok && large.ok).toBe(true)
    if (!small.ok || !large.ok) return
    expect(large.actualFill / small.actualFill).toBeCloseTo(1.25)
  })

  it('rejects a target that would clip the moon', () => {
    const result = fixedSizeCrop(
      source,
      { centerX: 0.5, centerY: 0.5, radius: 0.1 },
      { width: 700, height: 700 },
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: FIXED_CROP_ERROR_CODES.TARGET_CLIPS_MOON,
      minimumShortSide: 800,
    })
  })

  it('rejects a centered target that exceeds a nearby source edge', () => {
    const result = fixedSizeCrop(
      source,
      { centerX: 0.1, centerY: 0.5, radius: 0.03 },
      { width: 1920, height: 1080 },
    )

    expect(result).toMatchObject({
      ok: false,
      errorCode: FIXED_CROP_ERROR_CODES.TARGET_EXCEEDS_SOURCE,
      maximumCenteredSize: { width: 1200, height: 4000 },
    })
  })
})

describe('recommendFixedSquareSize', () => {
  const options = { fill: 0.85, roundingIncrement: 100 }

  it('rounds an 85% square up to the next hundred pixels', () => {
    expect(recommendFixedSquareSize(
      source,
      { centerX: 0.5, centerY: 0.5, radius: 0.05 },
      options,
    )).toEqual({ width: 500, height: 500 })
  })

  it('does not add another hundred at a floating-point increment boundary', () => {
    expect(recommendFixedSquareSize(
      source,
      { centerX: 0.5, centerY: 0.5, radius: 0.053125 },
      options,
    )).toEqual({ width: 500, height: 500 })
  })

  it('uses the largest valid square when hundred-pixel rounding crosses an edge', () => {
    expect(recommendFixedSquareSize(
      { width: 1000, height: 1000 },
      { centerX: 0.24, centerY: 0.5, radius: 0.2 },
      options,
    )).toEqual({ width: 480, height: 480 })
  })

  it('uses the largest valid square when 85% fill itself cannot fit', () => {
    expect(recommendFixedSquareSize(
      { width: 1000, height: 1000 },
      { centerX: 0.23, centerY: 0.5, radius: 0.2 },
      options,
    )).toEqual({ width: 460, height: 460 })
  })

  it('keeps the rounded recommendation when no centered square can contain the moon', () => {
    const recommendation = recommendFixedSquareSize(
      { width: 1000, height: 1000 },
      { centerX: 0.15, centerY: 0.5, radius: 0.2 },
      options,
    )

    expect(recommendation).toEqual({ width: 500, height: 500 })
    expect(fixedSizeCrop(
      { width: 1000, height: 1000 },
      { centerX: 0.15, centerY: 0.5, radius: 0.2 },
      recommendation ?? { width: 0, height: 0 },
    ).ok).toBe(false)
  })

  it('uses the upright source short edge for portrait photos', () => {
    expect(recommendFixedSquareSize(
      { width: 4000, height: 6000 },
      { centerX: 0.5, centerY: 0.5, radius: 0.05 },
      options,
    )).toEqual({ width: 500, height: 500 })
  })

  it('rejects invalid recommendation settings', () => {
    expect(recommendFixedSquareSize(source, {
      centerX: 0.5,
      centerY: 0.5,
      radius: 0.05,
    }, { fill: 0, roundingIncrement: 100 })).toBeNull()
  })
})
