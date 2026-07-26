import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { product } from './src/config/product'

function productPwa(): Plugin {
  return {
    name: 'product-pwa',
    transformIndexHtml(html) {
      return html
        .replaceAll('%APP_TITLE%', product.displayName)
        .replaceAll('%APP_DESCRIPTION%', product.description)
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
      const appFiles = Object.values(bundle)
        .map((entry) => entry.fileName)
        .filter((fileName) => /\.(?:css|html|js|svg)$/.test(fileName))
        .map((fileName) => `./${fileName}`)

      const manifest = {
        name: product.displayName,
        short_name: product.shortName,
        description: product.description,
        theme_color: '#0c1020',
        background_color: '#080b15',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'icons/moon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          {
            src: 'icons/moon-maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      }

      const shellFiles = [
        './',
        './index.html',
        './icons/moon.svg',
        './icons/moon-maskable.svg',
        ...appFiles,
      ]
      const cacheHash = createHash('sha256').update(JSON.stringify(shellFiles))
      for (const entry of Object.values(bundle).sort((left, right) =>
        left.fileName.localeCompare(right.fileName))) {
        cacheHash.update(entry.fileName)
        cacheHash.update(entry.type === 'chunk' ? entry.code : entry.source)
      }
      // Public files keep stable URLs, so their bytes must participate in the
      // version or an icon-only deployment would never install a new worker.
      cacheHash.update(readFileSync(new URL('./public/icons/moon.svg', import.meta.url)))
      cacheHash.update(readFileSync(new URL('./public/icons/moon-maskable.svg', import.meta.url)))
      const cacheVersion = cacheHash.digest('hex').slice(0, 12)

      // The generated worker knows Vite's hashed asset names without adding a
      // runtime caching dependency. It only caches this explicit app shell.
      const serviceWorker = `
const CACHE_PREFIX = 'moon-photo-app-';
const CACHE_NAME = CACHE_PREFIX + '${cacheVersion}';
const APP_SHELL = ${JSON.stringify([...new Set(shellFiles)])};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME)
        .then((cache) => cache.match('./index.html', { ignoreVary: true }))
        .then((cached) => cached || fetch(event.request)),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME)
      .then((cache) => cache.match(event.request, { ignoreVary: true }))
      .then((cached) => cached || fetch(event.request)),
  );
});
`

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(manifest),
      })
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorker.trimStart() })
      },
    },
  }
}

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), productPwa()],
})
