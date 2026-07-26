#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback
}

const sampleRoot = resolve(argument('--root', `${process.env.HOME}/moon-samples`))
const outputPath = argument('--output')
if (outputPath == null) {
  throw new Error('Usage: node tests/tools/classify-moon-samples.mjs --root <dir> --output <file.json>')
}

async function jpgFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return jpgFiles(path)
    return entry.isFile() && /\.jpe?g$/iu.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}

async function allowedMetadata(root) {
  const fields = [
    'Make',
    'Model',
    'LensModel',
    'FocalLength',
    'FocalLengthIn35mmFormat',
    'ImageWidth',
    'ImageHeight',
    'DateTimeOriginal',
    'DigitalZoomRatio',
    'ExposureTime',
    'FNumber',
    'ISO',
  ]
  const { stdout } = await execFileAsync('exiftool', [
    '-json',
    '-r',
    '-ext', 'JPG',
    ...fields.map((field) => `-${field}`),
    root,
  ], { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout)
}

function metadataByPath(rows) {
  return new Map(rows.map((row) => [resolve(row.SourceFile), {
    make: row.Make ?? null,
    model: row.Model ?? null,
    lensModel: row.LensModel ?? null,
    focalLength: row.FocalLength ?? null,
    focalLength35mm: row.FocalLengthIn35mmFormat ?? null,
    width: row.ImageWidth ?? null,
    height: row.ImageHeight ?? null,
    capturedAt: row.DateTimeOriginal ?? null,
    digitalZoomRatio: row.DigitalZoomRatio ?? null,
    exposureTime: row.ExposureTime ?? null,
    fNumber: row.FNumber ?? null,
    iso: row.ISO ?? null,
  }]))
}

function percentileRank(rows, value, selector, highIsBad) {
  const values = rows
    .map(selector)
    .filter((candidate) => typeof candidate === 'number' && Number.isFinite(candidate))
    .sort((left, right) => left - right)
  if (values.length < 2 || typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  const below = values.filter((candidate) => candidate < value).length
  const equal = values.filter((candidate) => candidate === value).length
  const rank = (below + equal * 0.5) / values.length
  return highIsBad ? rank : 1 - rank
}

function equipmentKey(record) {
  const metadata = record.metadata
  return [
    metadata.model ?? 'unknown-camera',
    metadata.lensModel ?? 'unknown-lens',
    metadata.focalLength ?? 'unknown-focal',
    `${metadata.width ?? '?'}x${metadata.height ?? '?'}`,
    record.phase.bucket,
  ].join('|')
}

function addCloudClassification(records) {
  const detected = records.filter((record) => record.status === 'detected')
  const groups = new Map()
  for (const record of detected) {
    const key = equipmentKey(record)
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }

  for (const record of detected) {
    const lowRadialContrast = record.detection.warnings.includes('low-radial-contrast')
    record.validity = lowRadialContrast
      ? 'non-moon-suspect'
      : record.detection.confidence < 0.7
        ? 'manual-review'
        : 'rankable'
    if (lowRadialContrast) {
      record.cloud = {
        score: null,
        classification: 'not-applicable-non-moon-suspect',
        basis: 'low-radial-contrast',
      }
      continue
    }

    const peerGroup = groups.get(equipmentKey(record)) ?? detected
    const peers = peerGroup.length >= 5 ? peerGroup : detected.filter((candidate) =>
      candidate.phase.bucket === record.phase.bucket)
    const cloudScore = 100 * (
      0.38 * percentileRank(peers, record.quality.hazePenalty, (item) => item.quality.hazePenalty, true) +
      0.24 * percentileRank(peers, record.quality.textureSharpness, (item) => item.quality.textureSharpness, false) +
      0.18 * percentileRank(peers, record.quality.limbSharpness, (item) => item.quality.limbSharpness, false) +
      0.12 * percentileRank(peers, record.detection.radialContrast, (item) => item.detection.radialContrast, false) +
      0.08 * percentileRank(peers, record.phase.illuminatedContrast, (item) => item.phase.illuminatedContrast, false)
    )
    const haze = record.quality.hazePenalty ?? 0
    const radialContrast = record.detection.radialContrast
    record.cloud = {
      score: Math.round(cloudScore * 10) / 10,
      classification: haze >= 0.18 && radialContrast < 0.8
        ? 'cloud-likely'
        : haze >= 0.08 && radialContrast < 0.92
          ? 'cloud-possible'
          : 'clearer-reference',
      basis: 'absolute-haze-and-limb-gate-plus-relative-score',
    }
  }
}

function summarize(records) {
  const countBy = (selector) => Object.fromEntries([...records.reduce((counts, record) => {
    const key = selector(record)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map()).entries()].sort((left, right) => String(left[0]).localeCompare(String(right[0]))))

  return {
    files: records.length,
    detection: countBy((record) => record.status),
    phase: countBy((record) => record.phase?.label ?? 'unclassified'),
    phaseBucket: countBy((record) => record.phase?.bucket ?? 'unclassified'),
    illuminatedSide: countBy((record) => record.phase?.illuminatedSide ?? 'unclassified'),
    cloud: countBy((record) => record.cloud?.classification ?? 'unclassified'),
    reviewRequired: records.filter((record) =>
      record.status !== 'detected' || record.detection.confidence < 0.7 ||
      record.detection.warnings.length > 0).length,
  }
}

const files = (await jpgFiles(sampleRoot)).sort()
const metadata = metadataByPath(await allowedMetadata(sampleRoot))
const server = await createServer({
  root: projectRoot,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const url = server.resolvedUrls?.local[0]
if (url == null) throw new Error('Vite did not expose a local URL')

const browser = await chromium.launch()
const page = await browser.newPage()
const records = []

try {
  await page.goto(url)
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'local-classifier-input'
    input.hidden = true
    document.body.append(input)
  })
  const input = page.locator('#local-classifier-input')

  for (const [index, path] of files.entries()) {
    await input.setInputFiles(path)
    const analysis = await page.evaluate(async () => {
      const fileInput = document.querySelector('#local-classifier-input')
      const file = fileInput instanceof HTMLInputElement ? fileInput.files?.[0] : null
      if (file == null) throw new Error('Classifier input is empty')

      const [{ detectMoon }, { evaluateMoonQuality }, ingest, geometry] = await Promise.all([
        import('/src/modes/moon/detectMoon.ts'),
        import('/src/modes/moon/quality.ts'),
        import('/src/ingest/photo.ts'),
        import('/src/imaging/geometry.ts'),
      ])
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      try {
        const sourceSize = { width: bitmap.width, height: bitmap.height }
        const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
        const width = Math.max(1, Math.round(bitmap.width * scale))
        const height = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context == null) throw new Error('Canvas unavailable')
        context.drawImage(bitmap, 0, 0, width, height)
        const luminance = ingest.imageDataToLuminance(context.getImageData(0, 0, width, height))
        const detection = detectMoon(luminance, width, height)
        if (detection == null) {
          return { status: 'no-detection', sourceSize }
        }
        const circle = geometry.normalizedCircleToPixels(detection.circle, { width, height })
        if (circle == null) {
          return { status: 'invalid-detection', sourceSize, detection }
        }
        const quality = evaluateMoonQuality(luminance, width, height, circle, { sourceSize })

        const histogramPercentile = (histogram, fraction) => {
          const total = histogram.reduce((sum, count) => sum + count, 0)
          const target = Math.max(0, Math.min(total - 1, Math.floor(total * fraction)))
          let cumulative = 0
          for (let value = 0; value < histogram.length; value += 1) {
            cumulative += histogram[value] ?? 0
            if (cumulative > target) return value
          }
          return 0
        }

        const insideHistogram = new Uint32Array(256)
        const annulusHistogram = new Uint32Array(256)
        const minX = Math.max(0, Math.floor(circle.centerX - circle.radius * 1.4))
        const maxX = Math.min(width - 1, Math.ceil(circle.centerX + circle.radius * 1.4))
        const minY = Math.max(0, Math.floor(circle.centerY - circle.radius * 1.4))
        const maxY = Math.min(height - 1, Math.ceil(circle.centerY + circle.radius * 1.4))
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const distance = Math.hypot(x + 0.5 - circle.centerX, y + 0.5 - circle.centerY) / circle.radius
            const value = Math.max(0, Math.min(255, Math.round(luminance[y * width + x] ?? 0)))
            if (distance <= 0.96) insideHistogram[value] += 1
            else if (distance >= 1.08 && distance <= 1.38) annulusHistogram[value] += 1
          }
        }
        const background = histogramPercentile(annulusHistogram, 0.65)
        const brightReference = histogramPercentile(insideHistogram, 0.92)
        const threshold = Math.min(250, background + Math.max(8, (brightReference - background) * 0.3))
        let discCount = 0
        let brightCount = 0
        let brightLeft = 0
        let brightRight = 0
        let sumBrightX = 0
        let brightSum = 0
        let darkSum = 0
        let darkCount = 0
        for (let y = Math.max(0, Math.floor(circle.centerY - circle.radius));
          y <= Math.min(height - 1, Math.ceil(circle.centerY + circle.radius)); y += 1) {
          for (let x = Math.max(0, Math.floor(circle.centerX - circle.radius));
            x <= Math.min(width - 1, Math.ceil(circle.centerX + circle.radius)); x += 1) {
            const dx = (x + 0.5 - circle.centerX) / circle.radius
            const dy = (y + 0.5 - circle.centerY) / circle.radius
            if (dx * dx + dy * dy > 0.92 * 0.92) continue
            discCount += 1
            const value = luminance[y * width + x] ?? 0
            if (value >= threshold) {
              brightCount += 1
              brightSum += value
              sumBrightX += dx
              if (dx < 0) brightLeft += 1
              else brightRight += 1
            } else {
              darkSum += value
              darkCount += 1
            }
          }
        }
        const illuminatedFraction = discCount === 0 ? 0 : brightCount / discCount
        const sideBalance = brightCount === 0 ? 0 : (brightRight - brightLeft) / brightCount
        const centroidOffsetX = brightCount === 0 ? 0 : sumBrightX / brightCount
        const illuminatedContrast = brightCount === 0
          ? 0
          : brightSum / brightCount - (darkCount === 0 ? background : darkSum / darkCount)
        const bucket = illuminatedFraction >= 0.82
          ? 'near-full'
          : illuminatedFraction >= 0.62
            ? 'gibbous'
            : illuminatedFraction >= 0.38
              ? 'half'
              : 'crescent'
        const illuminatedSide = Math.abs(sideBalance) < 0.08
          ? 'balanced'
          : sideBalance > 0
            ? 'right-lit'
            : 'left-lit'

        return {
          status: 'detected',
          sourceSize,
          detection: {
            confidence: detection.confidence,
            method: detection.method,
            radiusSourcePixels: detection.circle.radius * Math.min(sourceSize.width, sourceSize.height),
            arcCoverage: detection.arcCoverage,
            radialContrast: detection.radialContrast,
            warnings: detection.diagnostics.warnings,
          },
          phase: {
            bucket,
            label: illuminatedSide === 'balanced' ? bucket : `${illuminatedSide}-${bucket}`,
            illuminatedSide,
            illuminatedFraction,
            sideBalance,
            centroidOffsetX,
            threshold,
            background,
            brightReference,
            illuminatedContrast,
          },
          quality: {
            textureSharpness: quality.metrics.textureSharpness.value,
            limbSharpness: quality.metrics.limbSharpness.value,
            hazePenalty: quality.metrics.hazePenalty.value,
            noisePenalty: quality.metrics.noisePenalty.value,
            clippingPenalty: quality.metrics.clippingPenalty.value,
            motionBlurPenalty: quality.metrics.motionBlurPenalty.value,
            effectiveSourcePixelDiameter: quality.effectiveSourcePixelDiameter,
          },
        }
      } finally {
        bitmap.close()
      }
    })

    records.push({
      path: relative(sampleRoot, path),
      stem: basename(path, '.JPG'),
      directory: relative(sampleRoot, dirname(path)),
      metadata: metadata.get(path) ?? {},
      ...analysis,
    })
    if ((index + 1) % 10 === 0 || index + 1 === files.length) {
      process.stderr.write(`Analyzed ${index + 1}/${files.length}\n`)
    }
  }
} finally {
  await browser.close()
  await server.close()
}

addCloudClassification(records)
const result = {
  generatedBy: 'tests/tools/classify-moon-samples.mjs',
  privacy: {
    imagesUploaded: false,
    imagePixelsWritten: false,
    gpsRead: false,
    returnedData: 'scalar features and classifications only',
  },
  sampleRoot,
  summary: summarize(records),
  records,
}
await mkdir(dirname(resolve(outputPath)), { recursive: true })
await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(result.summary, null, 2))
console.log('\nHighest cloud scores:')
for (const record of records
  .filter((item) => typeof item.cloud?.score === 'number')
  .sort((left, right) => right.cloud.score - left.cloud.score)
  .slice(0, 25)) {
  console.log(`${record.cloud.score.toFixed(1)}\t${record.cloud.classification}\t${record.phase.label}\t${record.path}`)
}
