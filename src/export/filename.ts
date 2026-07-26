import type { ExportCropSpec } from './crop'

export interface ExportFilenameInput {
  originalName: string
  format: 'image/jpeg' | 'image/png'
  crop: ExportCropSpec
  capturedAt: string | null
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function formatCaptureDateForFilename(value: string | null): string | null {
  const match = value?.match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?=\s|$)/u)
  if (match == null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  if (day < 1 || day > (daysInMonth[month - 1] ?? 0)) return null
  return `${match[1]}${match[2]}${match[3]}`
}

function safeBaseName(originalName: string): string {
  const lastDot = originalName.lastIndexOf('.')
  const unextended = lastDot > 0 ? originalName.slice(0, lastDot) : originalName
  const invalidCharacters = '<>:"/\\|?*'
  const sanitized = Array.from(unextended.normalize('NFKC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || invalidCharacters.includes(character) ? '_' : character
  }).join('').trim().replace(/[. ]+$/u, '').slice(0, 120)
  return sanitized === '' ? 'photo' : sanitized
}

function compactNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000).replace('.', 'p')
}

function cropSuffix(crop: ExportCropSpec): string {
  if (crop.mode === 'fixed-scale') {
    return `${crop.size.width}x${crop.size.height}`
  }
  const fill = `${compactNumber(crop.options.fill * 100)}pct`
  const aspectRatio = typeof crop.options.aspectRatio === 'string'
    ? crop.options.aspectRatio.replace(':', 'x')
    : `${compactNumber(crop.options.aspectRatio)}x1`
  return `${fill}-${aspectRatio}`
}

export function buildExportFilename(input: ExportFilenameInput): string {
  const date = formatCaptureDateForFilename(input.capturedAt)
  const prefix = date == null ? '' : `${date}-`
  const extension = input.format === 'image/jpeg' ? 'jpg' : 'png'
  return `${prefix}${safeBaseName(input.originalName)}-moon-crop-${cropSuffix(input.crop)}.${extension}`
}
