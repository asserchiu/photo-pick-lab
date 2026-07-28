# MoonPick

MoonPick is a desktop-first, local-only web app for comparing a set of moon photos, finding the technically sharpest candidates, correcting the detected moon circle, and exporting a centered crop.

> MoonPick is the provisional display name for this MVP. Product-facing naming is isolated in `src/config/product.ts`.

## Privacy

- Photos are decoded and analyzed inside the browser.
- The app has no server, account, telemetry, remote font, or third-party runtime request.
- Only files explicitly selected or dropped by the user are read.
- App assets may be cached for offline use; user photos, thumbnails, Blob URLs, and metadata are not cached.
- The original files are never modified.

## Supported formats

| Direction | Formats |
|---|---|
| Input | JPEG, PNG |
| Output | JPEG, PNG |

HEIC／HEIF, RAW／ProRAW, TIFF, AVIF fallback, stacking, deconvolution, AI upscaling, and generated borders are outside this MVP.

## How it works

1. Import a set of moon photos that are reasonable to compare with one another.
2. A Web Worker creates an orientation-corrected analysis image and finds bright connected-component candidates.
3. Moon edge points are fitted to a geometric circle using deterministic robust sampling. Brightness centroid is not used as the crop center, which matters for crescent moons.
4. The app measures moon-surface texture, limb sharpness, directional blur, clipping, noise, haze, and effective source resolution.
5. Metrics are normalized only within the current imported set and combined into a deterministic relative ranking.
6. Low-confidence detections require review. Any detection can be corrected by moving its center and radius before re-analysis.
7. Export either with a fixed moon fill at 1:1, 4:3, 3:2, or 16:9 using 65%, 75%, 85%, or 95% fill (85% by default), or use an editable source-pixel square suggested for same-scale comparison.

### Same-scale comparison

The **same-scale** export mode treats the entered width and height as upright source-pixel crop dimensions and does not resample the crop. After the batch becomes idle, MoonPick suggests one shared square: it calculates the edge needed for 85% moon fill and rounds it up to the next 100 pixels. The rounded size remains unchanged while switching photos, preserving visible moon-size differences when the photos use the same camera, source resolution, and focal length without digital zoom or prior cropping. The fields remain editable, and a manual value is never replaced by a later suggestion.

Rounding up can make the actual fill lower than 85%. If the rounded size cannot remain centered inside the source, the app uses the largest valid centered square that still contains the moon. If no centered crop can contain the whole detected circle, export remains blocked instead of shifting the moon, adding borders, or generating pixels.

### Export files

- JPEG uses a browser encoder quality hint of `0.9`; it is not a promise to retain 90% of source quality. PNG is lossless at the pixel-encoding level.
- Fill-mode filenames end in the moon-fill percentage followed by the aspect ratio, such as `20260726-DSC00001-moon-crop-85pct-1x1.jpg`.
- Same-scale filenames end in the source-pixel dimensions, such as `20260726-DSC00001-moon-crop-500x500.png`.
- The `yyyymmdd-` prefix comes from a valid EXIF capture date. It is omitted when no valid capture date exists; file modification time is never substituted.
- Browser Canvas export re-encodes the crop. The exported file does **not** preserve source EXIF, ICC profiles, or other metadata and may reflect the browser's 8-bit color-management pipeline.

The score is a heuristic, batch-relative technical-quality score. It is not comparable across separate imports and does not claim to understand composition, emotion, or every photographic preference.

## Development

Requires a current Node.js release supported by Vite.

```bash
npm install
npm run dev
```

Verification commands:

```bash
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run test:e2e
```

`npm run verify` runs the first four gates in sequence. Playwright tests build and exercise the production preview.

## Deployment

`.github/workflows/deploy.yml` verifies and publishes to GitHub Pages. Configure the repository once under **Settings → Pages → Build and deployment → Source** by selecting **GitHub Actions**.

Pages serves one site per repository, so several versions can only be online at once if the workflow assembles the whole directory tree itself. A `gh-pages` branch stores the published tree between runs; each run rewrites a single slot in it and re-uploads everything as the Pages artifact. That branch is storage only — do not switch the Pages source to "Deploy from a branch".

| Trigger | Slot | URL |
| --- | --- | --- |
| Push to `main` | site root | <https://asserchiu.github.io/photo-pick-lab/> |
| Push tag `v*` | `version/<tag>` | `…/photo-pick-lab/version/v1.2.3/` |
| Pull request labeled `deploy-preview` | `preview/pr-<number>` | `…/photo-pick-lab/preview/pr-42/` |
| Manual run off a branch | `preview/branch-<slug>` | `…/photo-pick-lab/preview/branch-my-feature/` |
| — | version index | `…/photo-pick-lab/versions/` |

Production deploys only replace the root; `preview/`, `version/`, and the registry are excluded from the sync so parallel versions survive. A preview is deleted when its pull request closes or loses the `deploy-preview` label. Other slots are removed by running the workflow manually with a `remove_slot` input such as `version/v1.0.0`. `.github/tools/render-site-index.mjs` performs the tree rewrite: it installs or deletes one slot, maintains `versions.json`, and renders the version index, dropping entries whose directory has disappeared. The publish job always runs that script from the default branch, so a pull request cannot supply the code that holds the deployment credentials.

The workflow injects `BASE_PATH` for Vite assets and `SITE_URL` as the full public URL prefix used by canonical, Open Graph, and Twitter metadata, both derived from the slot. `SITE_URL` honors a repository Actions variable of the same name for the site root and otherwise derives the repository's project-page URL. This keeps the deployment host and prefix out of the product source; use a full HTTPS URL ending in `/` when overriding it. Everything except the production slot also builds with `SITE_NOINDEX=1`, which adds `<meta name="robots" content="noindex">` so previews and superseded releases stay out of search results.

Validate a subpath locally before changing deployment behavior:

```bash
BASE_PATH=/photo-pick-lab/ npm run verify
BASE_PATH=/photo-pick-lab/ npm run test:e2e
BASE_PATH=/photo-pick-lab/preview/pr-42/ SITE_NOINDEX=1 npm run verify
```

The base path is applied to Vite assets, the web app manifest, the service worker, the photo-analysis worker, and in-app home navigation. It also scopes the service worker's cache names: Cache Storage is shared per origin, so without a per-base prefix each version would evict every other version's app shell. Social previews use the square `public/icons/moon-512.png` icon with a standard `summary` card rather than an App screenshot or large-image card.

Known limits:

- Pull requests from forks get a read-only token and cannot publish a preview.
- Publishing is serialized through one `pages-site` concurrency group. GitHub keeps only one queued run per group, so simultaneous deploys can cancel an earlier queued publish; re-run that job.
- The `gh-pages` branch accumulates build output and benefits from an occasional history squash.

## Known detector limits

A rule-based single-image detector cannot reliably distinguish every isolated, clipped, textureless circular light from an overexposed full moon. Thin crescents, heavy cloud, daylight backgrounds, border-truncated moons, very small moons, streetlights, reflections, and low-contrast star fields may require manual circle correction. Low-radial-contrast candidates are held out of the provisional ranking, but they remain available for review instead of being silently discarded. Detection confidence is shown separately from image quality so an uncertain location is not silently treated as a low-quality photo.

The analysis thumbnail currently imposes a practical minimum moon diameter of about 124 source pixels on a 6192 × 4128 image. A smaller moon can be detected with low confidence but its circle may be oversized; correct the radius before comparing effective resolution or exporting.

## Known UI issue

The moon-circle handles have arrow-key and Shift+arrow nudge handlers, but a pointer click or drag currently does not move keyboard focus to the SVG handle. Keyboard nudging therefore works only after reaching a handle with Tab and is not reliably discoverable after pointer use. The in-app helper documents dragging only until pointer focus is fixed.

## Resource limits

Analysis uses one Worker and processes one full-resolution source at a time. Long-lived state keeps the original `File`, scalar results, and a small preview—not every photo's full-resolution RGBA pixels. Image bitmaps, Worker contexts, and object URLs are released when replaced or no longer needed. Files that exceed configured byte or decoded-pixel limits fail individually without stopping the rest of the batch.

## Real-photo calibration

Repository tests use deterministic synthetic fixtures and do not include photographs of unknown provenance. Before making product-quality claims, prepare at least ten local sets of five or more real moon photos, label each set's top three before revealing the algorithm output, and record top-1 agreement, top-3 recall, detection failures, and crop failures in a failure ledger.

For a large local sample directory, run the scalar-only classifier before selecting App batches:

```bash
npm run samples:classify -- \
  --root ~/moon-samples \
  --output /path/to/new-classification.json
```

The script analyzes only JPG files, keeps JPG / RAW pairs from being counted twice, requests an explicit non-GPS EXIF allowlist, and returns scalar geometry, phase, quality, and relative cloud-candidate features. It does not upload images or write decoded pixels.

After reviewing the scalar groups, validate them through the production App in batches of at most 50:

```bash
npm run build
npm run samples:validate -- \
  --classification /path/to/classification.json \
  --output /path/to/new-validation.json
```

The validation output contains only queue and ranking text; it does not copy the source photos.
