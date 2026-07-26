import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const fixture = (name: string) => resolve(process.cwd(), 'tests/fixtures/generated', name)

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function withExifOrientation(jpeg: Uint8Array, orientation: number): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || orientation < 1 || orientation > 8) {
    throw new Error('Invalid JPEG or EXIF orientation')
  }
  const app1 = Buffer.concat([
    Buffer.from([
      0xff, 0xe1, 0x00, 0x42,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x02, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
      orientation, 0x00, 0x00, 0x00,
      0x32, 0x01, 0x02, 0x00, 0x14, 0x00, 0x00, 0x00,
      0x26, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]),
    Buffer.from('2026:07:26 20:00:00\0', 'ascii'),
  ])
  return Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), app1, Buffer.from(jpeg.subarray(2))])
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ])
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    offset += 2
    if (startOfFrame.has(marker)) {
      return {
        height: (bytes[offset + 3] ?? 0) * 256 + (bytes[offset + 4] ?? 0),
        width: (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0),
      }
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0)
    if (length < 2) break
    offset += length
  }
  throw new Error('JPEG dimensions not found')
}

async function browserMoonJpeg(page: Page, orientation = 6): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 200
    const context = canvas.getContext('2d')
    if (context == null) throw new Error('Canvas unavailable')
    context.fillStyle = '#03040a'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#d8d5c8'
    context.beginPath()
    context.arc(100, 100, 58, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#77766f'
    for (const [x, y, radius] of [[78, 82, 9], [119, 75, 7], [110, 122, 12]] as const) {
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.fill()
    }
    const markers = [
      [0, 0, '#e62828'],
      [canvas.width - 30, 0, '#28d228'],
      [0, canvas.height - 30, '#2850e6'],
      [canvas.width - 30, canvas.height - 30, '#e6d228'],
    ] as const
    for (const [x, y, color] of markers) {
      context.fillStyle = color
      context.fillRect(x, y, 30, 30)
    }
    const blob = await new Promise<Blob>((resolveBlob, rejectBlob) => {
      canvas.toBlob((value) => value == null ? rejectBlob(new Error('JPEG encode failed')) : resolveBlob(value), 'image/jpeg', 0.94)
    })
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  return withExifOrientation(Uint8Array.from(bytes), orientation)
}

async function previewCornerLabels(page: Page): Promise<string[]> {
  const preview = page.getByAltText('選取照片的月亮偵測預覽')
  await expect(preview).toBeVisible()
  return preview.evaluate(async (element) => {
    const image = element as HTMLImageElement
    await image.decode()
    const bitmap = await createImageBitmap(image)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (context == null) throw new Error('Canvas unavailable')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const references = {
      R: [230, 40, 40],
      G: [40, 210, 40],
      B: [40, 80, 230],
      Y: [230, 210, 40],
    } as const
    const positions = [
      [15, 15],
      [canvas.width - 15, 15],
      [15, canvas.height - 15],
      [canvas.width - 15, canvas.height - 15],
    ] as const
    return positions.map(([x, y]) => {
      const pixel = context.getImageData(x, y, 1, 1).data
      return Object.entries(references).reduce((best, [label, color]) => {
        const distance = Math.hypot(
          (pixel[0] ?? 0) - color[0],
          (pixel[1] ?? 0) - color[1],
          (pixel[2] ?? 0) - color[2],
        )
        return distance < best.distance ? { label, distance } : best
      }, { label: '?', distance: Number.POSITIVE_INFINITY }).label
    })
  })
}

test('imports, ranks, corrects, compares scale, and exports locally', async ({ page }) => {
  const requests: Array<{ method: string; url: string; postData: string | null }> = []
  page.on('request', (request) => {
    requests.push({ method: request.method(), url: request.url(), postData: request.postData() })
  })

  const sourcePaths = [
    fixture('moon-small-sharp.png'),
    fixture('moon-large-sharp.png'),
    fixture('moon-large-soft.png'),
    fixture('moon-large-clipped.png'),
    fixture('corrupt.png'),
  ]
  const hashesBefore = await Promise.all(sourcePaths.map(sha256))

  await page.goto('./')
  await expect(page.getByRole('link', { name: 'MoonPick home' })).toHaveAttribute(
    'href',
    new URL(page.url()).pathname,
  )
  await expect(page.getByRole('heading', { name: 'Find the sharpest moon shot.' })).toBeVisible()
  await expect(page.getByText('相似照片精選')).toHaveCount(0)
  await page.getByLabel('選取照片').setInputFiles(sourcePaths)

  await expect(page.getByText('5 張照片')).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'JPEG 或 PNG' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '同批排名' })).toBeVisible()
  await expect(page.getByRole('button', { name: /第 1 名，moon-large-sharp\.png/ }).first()).toBeVisible()
  await expect(page.getByText(/月亮來源直徑 215 px/).first()).toBeVisible()
  await expect(page.getByText(/比同批最小大 31/).first()).toBeVisible()

  await page.getByRole('button', {
    name: '同尺度比較；保留不同時期的月亮大小差異',
  }).click()
  await expect(page.getByRole('spinbutton', { name: '寬度' })).toHaveValue('300')
  await expect(page.getByRole('spinbutton', { name: '高度' })).toHaveValue('300')
  await page.getByRole('button', { name: /第 2 名/ }).first().click()
  await expect(page.getByRole('spinbutton', { name: '寬度' })).toHaveValue('300')
  await expect(page.getByRole('spinbutton', { name: '高度' })).toHaveValue('300')
  await page.getByRole('button', { name: /第 1 名，moon-large-sharp\.png/ }).first().click()

  const centerHandle = page.getByRole('slider', { name: '調整月亮圓心' })
  await centerHandle.press('ArrowRight')
  await page.getByRole('button', { name: '套用並重新評分' }).click()
  await expect(page.getByText('偵測信心 100%')).toBeVisible()

  await page.getByRole('button', {
    name: '同尺度比較；保留不同時期的月亮大小差異',
  }).click()
  await page.getByRole('spinbutton', { name: '寬度' }).fill('640')
  await page.getByRole('spinbutton', { name: '高度' }).fill('480')
  await expect(page.getByText(/不重新縮放/)).toBeVisible()
  await expect(page.getByText(/這張照片的月亮佔短邊/)).toBeVisible()
  await page.getByLabel('輸出格式').selectOption('image/png')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下載 PNG' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('moon-large-sharp-moon-crop-640x480.png')
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  if (downloadPath != null) {
    const bytes = await readFile(downloadPath)
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(bytes.readUInt32BE(16)).toBe(640)
    expect(bytes.readUInt32BE(20)).toBe(480)
  }

  expect(await Promise.all(sourcePaths.map(sha256))).toEqual(hashesBefore)
  expect(requests.every((request) => ['GET', 'HEAD'].includes(request.method))).toBe(true)
  const appUrl = new URL(page.url())
  expect(requests.every((request) => new URL(request.url).origin === appUrl.origin)).toBe(true)
  const appBasePath = appUrl.pathname
  const httpRequests = requests.filter((request) => ['http:', 'https:'].includes(new URL(request.url).protocol))
  expect(httpRequests.every((request) => new URL(request.url).pathname.startsWith(appBasePath))).toBe(true)
  expect(requests.every((request) => request.postData == null)).toBe(true)
})

test('blocks a fixed-size crop that cannot remain centered', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('選取照片').setInputFiles(fixture('moon-large-sharp.png'))
  await expect(page.getByRole('heading', { name: '同批排名' })).toBeVisible()
  await page.getByRole('button', {
    name: '同尺度比較；保留不同時期的月亮大小差異',
  }).click()
  await page.getByRole('spinbutton', { name: '寬度' }).fill('800')
  await page.getByRole('spinbutton', { name: '高度' }).fill('600')

  await expect(page.getByText(/最多可用 799 × 599 px/)).toBeVisible()
  await expect(page.getByRole('button', { name: '下載 JPEG' })).toBeDisabled()
})

test('decodes EXIF orientations 2 through 8 into upright dimensions', async ({ page }) => {
  const expectedCorners: Record<number, string[]> = {
    2: ['G', 'R', 'Y', 'B'],
    3: ['Y', 'B', 'G', 'R'],
    4: ['B', 'Y', 'R', 'G'],
    5: ['R', 'B', 'G', 'Y'],
    6: ['B', 'R', 'Y', 'G'],
    7: ['Y', 'G', 'B', 'R'],
    8: ['G', 'Y', 'R', 'B'],
  }
  await page.goto('./')
  for (let orientation = 2; orientation <= 8; orientation += 1) {
    const jpeg = await browserMoonJpeg(page, orientation)
    await page.getByLabel('選取照片').setInputFiles({
      name: `orientation-${orientation}.jpg`,
      mimeType: 'image/jpeg',
      buffer: jpeg,
    })
    const expectedSize = orientation >= 5 ? '200 × 320' : '320 × 200'
    await expect(page.getByText(expectedSize).first()).toBeVisible()
    await expect(page.getByText('需要確認圓框').or(page.getByText('完成')).first()).toBeVisible()
    expect(await previewCornerLabels(page)).toEqual(expectedCorners[orientation])
    await page.getByRole('button', { name: '清除全部' }).click()
  }
})

test('applies EXIF orientation and manual circle edits to fill JPEG export', async ({ page }) => {
  await page.goto('./')
  const jpeg = await browserMoonJpeg(page)
  await page.getByLabel('選取照片').setInputFiles({
    name: 'oriented-moon.jpg',
    mimeType: 'application/octet-stream',
    buffer: jpeg,
  })

  await expect(page.getByText('200 × 320').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: '同批排名' })).toBeVisible()
  const centerHandle = page.getByRole('slider', { name: '調整月亮圓心' })
  for (let step = 0; step < 5; step += 1) await centerHandle.press('Shift+ArrowRight')
  await page.getByRole('button', { name: /重新評分/ }).click()
  await expect(page.getByText('偵測信心 100%')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await expect(page.getByRole('button', { name: '下載 JPEG' })).toBeEnabled()
  await page.getByRole('button', { name: '下載 JPEG' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(
    '20260726-oriented-moon-moon-crop-85pct-1x1.jpg',
  )
  const outputPath = await download.path()
  expect(outputPath).not.toBeNull()
  if (outputPath == null) return
  const output = await readFile(outputPath)
  const dimensions = jpegDimensions(output)
  expect(dimensions.width).toBe(dimensions.height)
  expect(dimensions.width).toBeGreaterThan(80)

  const centroid = await page.evaluate(async ({ encoded, width, height }) => {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (context == null) throw new Error('Canvas unavailable')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pixels = context.getImageData(0, 0, width, height).data
    let sumX = 0
    let sumY = 0
    let count = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        const luminance = (pixels[offset] ?? 0) * 0.2126 +
          (pixels[offset + 1] ?? 0) * 0.7152 + (pixels[offset + 2] ?? 0) * 0.0722
        if (luminance < 70) continue
        sumX += x + 0.5
        sumY += y + 0.5
        count += 1
      }
    }
    return { x: sumX / count, y: sumY / count }
  }, { encoded: output.toString('base64'), ...dimensions })
  expect(centroid.x).toBeLessThan(dimensions.width / 2 - 5)
  expect(Math.abs(centroid.y - dimensions.height / 2)).toBeLessThan(3)
})

test('keeps the wide title on one line and Inspect within its panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('./')

  const title = page.getByRole('heading', { name: 'Find the sharpest moon shot.' })
  const titleLayout = await title.evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
    return {
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      lineHeight,
      scrollWidth: element.scrollWidth,
    }
  })
  expect(titleLayout.clientHeight).toBeLessThanOrEqual(titleLayout.lineHeight * 1.1)
  expect(titleLayout.scrollWidth).toBeLessThanOrEqual(titleLayout.clientWidth)

  await page.setViewportSize({ width: 900, height: 1000 })
  await page.getByLabel('選取照片').setInputFiles(fixture('moon-large-sharp.png'))
  await expect(page.getByRole('heading', { name: '同批排名' })).toBeVisible()

  const editor = page.locator('.moon-editor')
  const metrics = page.locator('.metric-breakdown')
  const [editorBounds, metricBounds] = await Promise.all([
    editor.boundingBox(),
    metrics.boundingBox(),
  ])
  expect(editorBounds).not.toBeNull()
  expect(metricBounds).not.toBeNull()
  if (editorBounds != null && metricBounds != null) {
    expect(Math.abs(editorBounds.x - metricBounds.x)).toBeLessThan(1)
    expect(metricBounds.y).toBeGreaterThan(editorBounds.y + editorBounds.height)
  }

  const metricOverflow = await metrics.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(metricOverflow.scrollWidth).toBeLessThanOrEqual(metricOverflow.clientWidth)

  const metricRight = metricBounds == null ? 0 : metricBounds.x + metricBounds.width
  for (const output of await page.locator('.metric-row output').all()) {
    const bounds = await output.boundingBox()
    expect(bounds).not.toBeNull()
    if (bounds != null) expect(bounds.x + bounds.width).toBeLessThanOrEqual(metricRight + 0.5)
  }
})

test('keeps a narrow 16:9 crop preview proportional to export', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./')
  await page.getByLabel('選取照片').setInputFiles(fixture('moon-large-sharp.png'))
  await expect(page.getByRole('heading', { name: '同批排名' })).toBeVisible()
  await page.getByRole('button', { name: '16:9' }).click()

  const bounds = await page.locator('.crop-preview').boundingBox()
  expect(bounds).not.toBeNull()
  if (bounds != null) expect(Math.abs(bounds.width / bounds.height - 16 / 9)).toBeLessThan(0.03)
})

test('reloads the cached app shell while offline', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Offline service-worker smoke runs once in Chromium.')
  const serviceWorker = await readFile(resolve(process.cwd(), 'dist/sw.js'), 'utf8')
  expect(serviceWorker).toContain('name.startsWith(CACHE_PREFIX)')
  expect(serviceWorker).toContain('caches.open(CACHE_NAME)')
  expect(serviceWorker).not.toContain('caches.match(')

  await page.goto('./')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (navigator.serviceWorker.controller == null) {
      await new Promise<void>((resolveController) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolveController(), {
          once: true,
        })
      })
    }
  })
  expect(await page.evaluate(async () => (await caches.match('./index.html')) != null)).toBe(true)
  await page.evaluate(async () => {
    const foreignCache = await caches.open('foreign-photo-app-cache')
    await foreignCache.put('./foreign-shell', new Response('foreign'))
  })
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Find the sharpest moon shot.' })).toBeVisible()
  expect(await page.evaluate(async () => (await caches.keys()).includes('foreign-photo-app-cache'))).toBe(true)
})
