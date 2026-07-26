#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { preview } from 'vite'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] ?? null
}

const classificationPath = argument('--classification')
const outputPath = argument('--output')
if (classificationPath == null || outputPath == null) {
  throw new Error('Usage: node tests/tools/validate-moon-batches.mjs --classification <json> --output <json>')
}

const projectRoot = resolve(new URL('../..', import.meta.url).pathname)
const classification = JSON.parse(await readFile(resolve(classificationPath), 'utf8'))
const records = classification.records.filter((record) => record.directory < '20260000')
const grouped = new Map()
for (const record of records) {
  const key = [
    record.directory,
    record.metadata.model ?? 'unknown-camera',
    record.metadata.lensModel ?? 'unknown-lens',
    record.metadata.focalLength ?? 'unknown-focal',
    record.phase?.label ?? 'unclassified-phase',
  ].join('|')
  const group = grouped.get(key) ?? []
  group.push(record)
  grouped.set(key, group)
}

const batches = []
for (const [groupKey, group] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
  const sorted = group.sort((left, right) => left.path.localeCompare(right.path))
  for (let offset = 0; offset < sorted.length; offset += 50) {
    batches.push({
      groupKey,
      batchIndex: Math.floor(offset / 50) + 1,
      records: sorted.slice(offset, offset + 50),
    })
  }
}

const server = await preview({
  root: projectRoot,
  logLevel: 'error',
  preview: { host: '127.0.0.1', port: 0 },
})
const url = server.resolvedUrls?.local[0]
if (url == null) throw new Error('Vite preview did not expose a local URL')
const browser = await chromium.launch()
const page = await browser.newPage()
const validations = []

try {
  await page.goto(url)
  for (const [index, batch] of batches.entries()) {
    const paths = batch.records.map((record) => resolve(classification.sampleRoot, record.path))
    await page.getByLabel('選取照片').setInputFiles(paths)
    await expect(page.getByText(`${paths.length} 張照片`)).toBeVisible()
    await page.waitForFunction(() => {
      const statuses = [...document.querySelectorAll('.status-text')].map((node) => node.textContent?.trim())
      return statuses.length > 0 && statuses.every((status) =>
        status !== '等待分析' && status !== '分析中')
    }, null, { timeout: 10 * 60 * 1000 })

    const result = await page.evaluate(() => ({
      queue: [...document.querySelectorAll('.queue-item')].map((item) => ({
        label: item.getAttribute('aria-label'),
        metadata: item.querySelector('.queue-meta')?.textContent?.replace(/\s+/gu, ' ').trim() ?? null,
      })),
      ranking: [...document.querySelectorAll('.result-row')].map((row) => ({
        label: row.getAttribute('aria-label'),
        text: row.textContent?.replace(/\s+/gu, ' ').trim() ?? null,
      })),
      reviewNotices: document.querySelectorAll('.review-flag').length,
      errors: [...document.querySelectorAll('.queue-error')].map((node) => node.textContent?.trim()),
    }))
    validations.push({
      groupKey: batch.groupKey,
      batchIndex: batch.batchIndex,
      files: batch.records.map((record) => record.path),
      ...result,
    })
    process.stderr.write(`Validated ${index + 1}/${batches.length}: ${batch.groupKey} (${paths.length})\n`)
    await page.getByRole('button', { name: '清除全部' }).click()
    await expect(page.locator('.queue-panel')).toHaveCount(0)
  }
} finally {
  await browser.close()
  await new Promise((resolveClose, rejectClose) => {
    server.httpServer.close((error) => error == null ? resolveClose() : rejectClose(error))
  })
}

const summary = {
  files: validations.reduce((sum, validation) => sum + validation.files.length, 0),
  batches: validations.length,
  failedFiles: validations.flatMap((validation) => validation.errors).length,
  reviewFiles: validations.flatMap((validation) => validation.queue)
    .filter((item) => item.label?.endsWith('需要確認圓框')).length,
  rankedRows: validations.flatMap((validation) => validation.ranking)
    .filter((row) => row.label?.startsWith('第 ')).length,
}
const output = {
  generatedBy: 'tests/tools/validate-moon-batches.mjs',
  privacy: {
    imagesUploaded: false,
    returnedData: 'UI text and scalar status only',
  },
  sourceClassification: resolve(classificationPath),
  summary,
  validations,
}
await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2))
