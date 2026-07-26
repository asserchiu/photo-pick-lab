import { describe, expect, it } from 'vitest'
import { buildExportFilename, formatCaptureDateForFilename } from './filename'

describe('formatCaptureDateForFilename', () => {
  it('keeps only a valid capture date without converting time zones', () => {
    expect(formatCaptureDateForFilename('2026:07:26 23:59:59')).toBe('20260726')
    expect(formatCaptureDateForFilename('2024-02-29 00:00:00')).toBe('20240229')
  })

  it('rejects missing and invalid calendar dates', () => {
    expect(formatCaptureDateForFilename(null)).toBeNull()
    expect(formatCaptureDateForFilename('2025:02:29 12:00:00')).toBeNull()
    expect(formatCaptureDateForFilename('2026:13:01 12:00:00')).toBeNull()
    expect(formatCaptureDateForFilename('not-a-date')).toBeNull()
  })
})

describe('buildExportFilename', () => {
  it('prefixes the capture date and puts fill percentage before aspect ratio', () => {
    expect(buildExportFilename({
      originalName: 'DSC00001.JPG',
      format: 'image/jpeg',
      crop: { mode: 'fill', options: { aspectRatio: '1:1', fill: 0.85 } },
      capturedAt: '2026:07:26 20:15:30',
    })).toBe('20260726-DSC00001-moon-crop-85pct-1x1.jpg')
  })

  it.each([
    ['4:3', '65pct-4x3'],
    ['3:2', '75pct-3x2'],
    ['16:9', '95pct-16x9'],
  ] as const)('creates a Windows-safe %s fill suffix', (aspectRatio, suffix) => {
    expect(buildExportFilename({
      originalName: 'moon.png',
      format: 'image/png',
      crop: { mode: 'fill', options: { aspectRatio, fill: Number(suffix.slice(0, 2)) / 100 } },
      capturedAt: null,
    })).toBe(`moon-moon-crop-${suffix}.png`)
  })

  it('uses exact fixed-scale dimensions and omits a missing date', () => {
    expect(buildExportFilename({
      originalName: 'moon-large-sharp.png',
      format: 'image/png',
      crop: { mode: 'fixed-scale', size: { width: 500, height: 500 } },
      capturedAt: null,
    })).toBe('moon-large-sharp-moon-crop-500x500.png')
  })

  it('keeps the existing basename sanitization and empty-name fallback', () => {
    expect(buildExportFilename({
      originalName: ' bad<name>.jpg ',
      format: 'image/jpeg',
      crop: { mode: 'fixed-scale', size: { width: 500, height: 400 } },
      capturedAt: 'invalid',
    })).toBe('bad_name_-moon-crop-500x400.jpg')
    expect(buildExportFilename({
      originalName: '   .jpg',
      format: 'image/jpeg',
      crop: { mode: 'fixed-scale', size: { width: 100, height: 100 } },
      capturedAt: null,
    })).toBe('photo-moon-crop-100x100.jpg')
  })
})
