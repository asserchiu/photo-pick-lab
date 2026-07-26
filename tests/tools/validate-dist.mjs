import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function normalizeSiteUrl() {
  const siteUrl = new URL(
    process.env.SITE_URL ?? process.env.BASE_PATH ?? '/',
    'http://localhost',
  )
  if (!siteUrl.pathname.endsWith('/')) siteUrl.pathname += '/'
  siteUrl.search = ''
  siteUrl.hash = ''
  return siteUrl
}

function requireSingle(document, selector) {
  const matches = document.querySelectorAll(selector)
  assert(matches.length === 1, `Expected one ${selector}, found ${matches.length}`)
  return matches[0]
}

function requireContent(document, selector, expected) {
  const element = requireSingle(document, selector)
  assert(
    element.getAttribute('content') === expected,
    `${selector} must contain ${JSON.stringify(expected)}`,
  )
}

const distDirectory = resolve(process.cwd(), 'dist')
const html = await readFile(resolve(distDirectory, 'index.html'), 'utf8')
assert(!/%APP_[A-Z_]+%/.test(html), 'Built HTML contains an unreplaced app metadata token')

const document = new JSDOM(html).window.document
const siteUrl = normalizeSiteUrl()
const siteUrlString = siteUrl.href
const imageUrl = new URL('icons/moon-512.png', siteUrl).href
const socialTitle = 'MoonPick — Find the sharpest moon shot.'
const description = 'Compare moon photos locally, find the sharpest candidate, and export a centered crop.'

if (process.env.SITE_URL != null) {
  assert(siteUrl.protocol === 'https:', 'Configured SITE_URL must use HTTPS')
}

const canonical = requireSingle(document, 'link[rel="canonical"]')
assert(canonical.getAttribute('href') === siteUrlString, 'Canonical URL does not match SITE_URL')

requireContent(document, 'meta[property="og:type"]', 'website')
requireContent(document, 'meta[property="og:site_name"]', 'MoonPick')
requireContent(document, 'meta[property="og:title"]', socialTitle)
requireContent(document, 'meta[property="og:description"]', description)
requireContent(document, 'meta[property="og:url"]', siteUrlString)
requireContent(document, 'meta[property="og:locale"]', 'zh_TW')
requireContent(document, 'meta[property="og:image"]', imageUrl)
requireContent(document, 'meta[property="og:image:secure_url"]', imageUrl)
requireContent(document, 'meta[property="og:image:type"]', 'image/png')
requireContent(document, 'meta[property="og:image:width"]', '512')
requireContent(document, 'meta[property="og:image:height"]', '512')
requireContent(document, 'meta[property="og:image:alt"]', 'MoonPick moon icon')
requireContent(document, 'meta[name="twitter:card"]', 'summary')
requireContent(document, 'meta[name="twitter:title"]', socialTitle)
requireContent(document, 'meta[name="twitter:description"]', description)
requireContent(document, 'meta[name="twitter:image"]', imageUrl)
requireContent(document, 'meta[name="twitter:image:alt"]', 'MoonPick moon icon')

const png = await readFile(resolve(distDirectory, 'icons/moon-512.png'))
assert(
  png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'Social icon is not a PNG file',
)
assert(png.subarray(12, 16).toString('ascii') === 'IHDR', 'Social icon has no PNG IHDR')
assert(png.readUInt32BE(16) === 512, 'Social icon width must be 512 pixels')
assert(png.readUInt32BE(20) === 512, 'Social icon height must be 512 pixels')

console.log(`Validated social metadata for ${siteUrlString}`)
