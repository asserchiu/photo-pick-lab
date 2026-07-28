// Assembles the published site tree and its version registry.
//
// GitHub Pages replaces the whole site on every deployment, so parallel
// versions only survive if each run rewrites one slot of a tree that is kept
// between runs on a storage branch. This script performs that rewrite: it
// installs (or deletes) one slot, updates `versions.json`, drops entries whose
// directory has disappeared, and re-renders the index page.
//
//   node .github/tools/render-site-index.mjs --root site \
//     --slot preview/pr-42 --build dist --label 'PR #42 — Title' \
//     --ref feature-branch --sha 0123456 --site-root https://user.github.io/repo/
//
//   node .github/tools/render-site-index.mjs --root site --slot preview/pr-42 --remove
//
// Omitting --slot prunes and re-renders without touching any deployment.

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const [key, inlineValue] = token.slice(2).split(/=(.*)/s)
    if (inlineValue !== undefined) {
      values.set(key, inlineValue)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      values.set(key, '')
      continue
    }
    values.set(key, next)
    index += 1
  }
  return values
}

// The slot doubles as the directory inside the site root and as the URL
// suffix, so it must stay a plain relative path.
function normalizeSlot(raw) {
  const segments = raw.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Slot must not contain path traversal: ${raw}`)
  }
  return segments.join('/')
}

function slotKind(slot) {
  if (slot === '') return 'root'
  if (slot.startsWith('version/')) return 'tag'
  if (slot.startsWith('preview/')) return 'preview'
  return 'other'
}

function slotExists(root, slot) {
  return existsSync(resolve(root, slot, 'index.html'))
}

// The production build owns the site root, but the other deployments and the
// registry live underneath it, so a root install must spare exactly these.
const reservedRootEntries = new Set(['.git', 'preview', 'version', 'versions', 'versions.json'])

async function installSlot(root, slot, buildDirectory) {
  const target = resolve(root, slot)

  if (slot === '') {
    for (const entry of await readdir(root)) {
      if (reservedRootEntries.has(entry)) continue
      await rm(resolve(root, entry), { recursive: true, force: true })
    }
  } else {
    await rm(target, { recursive: true, force: true })
  }

  await mkdir(target, { recursive: true })
  await cp(buildDirectory, target, { recursive: true })
}

async function removeSlot(root, slot) {
  if (slot === '') throw new Error('Refusing to delete the site root')
  await rm(resolve(root, slot), { recursive: true, force: true })
}

function slotUrl(siteRoot, slot) {
  // Without an absolute site root, link relative to /versions/index.html.
  if (siteRoot === '') return slot === '' ? '../' : `../${slot}/`
  return slot === '' ? siteRoot : `${siteRoot}${slot}/`
}

async function readRegistry(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

const kindOrder = { root: 0, tag: 1, preview: 2, other: 3 }
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    const byKind = kindOrder[left.kind] - kindOrder[right.kind]
    if (byKind !== 0) return byKind
    return collator.compare(right.slot, left.slot)
  })
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const sectionTitles = {
  root: 'Production',
  tag: 'Released versions',
  preview: 'Pull request previews',
  other: 'Other deployments',
}

function renderSection(kind, entries) {
  if (entries.length === 0) return ''
  const items = entries
    .map((entry) => {
      const meta = [
        entry.ref ? `ref <code>${escapeHtml(entry.ref)}</code>` : '',
        entry.sha ? `commit <code>${escapeHtml(entry.sha.slice(0, 7))}</code>` : '',
        entry.updatedAt ? `updated ${escapeHtml(entry.updatedAt.slice(0, 16).replace('T', ' '))} UTC` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      return `        <li>
          <a href="${escapeHtml(entry.url)}">${escapeHtml(entry.label || entry.slot || '/')}</a>
          <p>${meta}</p>
        </li>`
    })
    .join('\n')

  return `      <section>
        <h2>${escapeHtml(sectionTitles[kind])}</h2>
        <ul>
${items}
        </ul>
      </section>`
}

function renderIndex(entries, generatedAt) {
  const sections = ['root', 'tag', 'preview', 'other']
    .map((kind) => renderSection(kind, entries.filter((entry) => entry.kind === kind)))
    .filter(Boolean)
    .join('\n')

  const body = sections === '' ? '      <p class="empty">No deployments are published yet.</p>' : sections

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Deployed versions</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        padding: 3rem 1.5rem;
        background: #080b15;
        color: #e6e9f5;
        font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { max-width: 44rem; margin: 0 auto; }
      h1 { font-size: 1.6rem; margin: 0 0 0.4rem; }
      h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8f9bc4; margin: 2.5rem 0 0.75rem; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { padding: 0.9rem 1.1rem; margin-bottom: 0.6rem; border-radius: 0.6rem; background: #0c1020; border: 1px solid #1c2440; }
      a { color: #8fb8ff; font-weight: 600; text-decoration: none; }
      a:hover { text-decoration: underline; }
      p { margin: 0.3rem 0 0; color: #8f9bc4; font-size: 0.85rem; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .lede, .empty { color: #8f9bc4; }
    </style>
  </head>
  <body>
    <main>
      <h1>Deployed versions</h1>
      <p class="lede">Generated ${escapeHtml(generatedAt.slice(0, 16).replace('T', ' '))} UTC.</p>
${body}
    </main>
  </body>
</html>
`
}

const options = parseArguments(process.argv.slice(2))
const root = resolve(process.cwd(), options.get('root') ?? 'site')
const siteRoot = (options.get('site-root') ?? '').trim()
const registryPath = resolve(root, 'versions.json')
const indexPath = resolve(root, 'versions/index.html')
const generatedAt = new Date().toISOString()

if (siteRoot !== '' && !siteRoot.endsWith('/')) {
  throw new Error('--site-root must end with a slash')
}

let entries = await readRegistry(registryPath)

if (options.has('slot')) {
  const slot = normalizeSlot(options.get('slot'))
  entries = entries.filter((entry) => entry.slot !== slot)

  if (options.has('remove')) {
    await removeSlot(root, slot)
  } else {
    const buildDirectory = options.get('build')
    if (!buildDirectory) throw new Error('Publishing a slot requires --build')
    await installSlot(root, slot, resolve(process.cwd(), buildDirectory))

    if (!slotExists(root, slot)) {
      throw new Error(`Slot ${slot || '/'} has no index.html under ${root}`)
    }
    entries.push({
      slot,
      kind: slotKind(slot),
      label: options.get('label') || slot || '/',
      ref: options.get('ref') ?? '',
      sha: options.get('sha') ?? '',
      url: slotUrl(siteRoot, slot),
      updatedAt: generatedAt,
    })
  }
}

// A slot can vanish without passing through this script — a force-push to the
// storage branch, a manual cleanup — so trust the filesystem over the registry.
entries = sortEntries(entries.filter((entry) => slotExists(root, entry.slot)))

await mkdir(dirname(indexPath), { recursive: true })
await writeFile(registryPath, `${JSON.stringify({ generatedAt, entries }, null, 2)}\n`)
await writeFile(indexPath, renderIndex(entries, generatedAt))

console.log(`Rendered version index with ${entries.length} deployment(s)`)
