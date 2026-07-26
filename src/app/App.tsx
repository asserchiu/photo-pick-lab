import { useState } from 'react'
import { cropOptions } from '../config/analysis'
import { product } from '../config/product'
import type { ExportCropSpec } from '../export/crop'
import { recommendFixedSquareSize } from '../export/crop'
import { formatCapturedAt } from '../ingest/photo'
import type { ExportFormat } from '../workers/protocol'
import { AnalysisQueue } from '../components/AnalysisQueue'
import { CropExportPanel } from '../components/CropExportPanel'
import { FileDrop } from '../components/FileDrop'
import { MetricBreakdown } from '../components/MetricBreakdown'
import { MoonEditor } from '../components/MoonEditor'
import { RankedResults } from '../components/RankedResults'
import { useAnalysisQueue } from './useAnalysisQueue'

export function App() {
  const queue = useAnalysisQueue()
  const [preferredAssetId, setPreferredAssetId] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const selectableAssets = queue.assets.filter((asset) =>
    asset.previewUrl != null && asset.detection != null && asset.sourceSize != null,
  )
  const preferredAsset = preferredAssetId == null
    ? null
    : selectableAssets.find((asset) => asset.id === preferredAssetId) ?? null
  const fallbackAssetId = queue.ranked[0]?.assetId ?? selectableAssets[0]?.id ?? null
  const selectedAssetId = preferredAsset?.id ?? fallbackAssetId
  const selectedAsset = selectedAssetId == null
    ? null
    : selectableAssets.find((asset) => asset.id === selectedAssetId) ?? null
  const selectedRanking = selectedAssetId == null
    ? null
    : queue.ranked.find((candidate) => candidate.assetId === selectedAssetId) ?? null
  const queueBusy = queue.assets.some((asset) => asset.status === 'queued' || asset.status === 'running')
  const recommendationAsset = queueBusy
    ? null
    : selectedAsset?.status === 'ready'
      ? selectedAsset
      : queue.ranked
        .map((candidate) => queue.assets.find((asset) => asset.id === candidate.assetId) ?? null)
        .find((asset) => asset?.status === 'ready') ?? null
  const fixedScaleRecommendation = recommendationAsset?.sourceSize == null ||
      recommendationAsset.detection == null
    ? null
    : recommendFixedSquareSize(
      recommendationAsset.sourceSize,
      recommendationAsset.detection.circle,
      cropOptions.fixedScaleRecommendation,
    )

  const addFiles = (files: File[]) => {
    const result = queue.addFiles(files)
    setImportMessage(result.rejected.length === 0
      ? null
      : `${result.rejected.length} 張照片超過每批 50 張的上限，未加入佇列。`)
  }

  const exportSelected = async (spec: ExportCropSpec, format: ExportFormat) => {
    if (selectedAsset == null) throw new Error('目前沒有可匯出的照片。')
    const result = await queue.exportAsset(selectedAsset.id, { crop: spec, format })
    const url = URL.createObjectURL(result.blob)
    const link = document.createElement('a')
    link.href = url
    link.download = result.filename
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label={`${product.displayName} home`}>
          <span className="brand-mark" aria-hidden="true">◐</span>
          <span>{product.displayName}</span>
        </a>
        <div className="header-actions">
          <span className="local-badge">Local-only · 本機處理</span>
          {queue.assets.length > 0 && (
            <button className="ghost-button" type="button" onClick={queue.clear}>
              清除全部
            </button>
          )}
        </div>
      </header>

      <main>
        <section className={`hero ${queue.assets.length > 0 ? 'hero-compact' : ''}`} aria-labelledby="hero-title">
          <div className="eyebrow">Moon photo culling &amp; centered crop</div>
          <h1 id="hero-title">{product.taglineEn}</h1>
          <p className="hero-zh">{product.taglineZhTw}</p>
          <p className="hero-copy">
            匯入同一批月亮照片，比較月面紋理、月緣與模糊程度，再輸出幾何置中的裁切結果。
            同相機與焦段的跨時期照片也可用同尺度輸出保留月亮大小差異。
          </p>
        </section>

        <section className="workspace-card" aria-labelledby="import-heading">
          <div className="section-heading">
            <div>
              <span className="step-label">01 · Import</span>
              <h2 id="import-heading">選取可互相比較的月亮照片</h2>
            </div>
            <span className="format-note">JPEG · PNG · 最多 50 張</span>
          </div>
          <FileDrop onFiles={addFiles} />
          {importMessage != null && <p className="import-message" role="status">{importMessage}</p>}
        </section>

        <AnalysisQueue
          assets={queue.assets}
          onCancel={(assetId) => { queue.cancelAsset(assetId) }}
          onRetry={(assetId) => { queue.retryAsset(assetId) }}
        />

        <RankedResults
          assets={queue.assets}
          ranked={queue.ranked}
          selectedId={selectedAssetId}
          onSelect={setPreferredAssetId}
        />

        {selectedAsset != null && selectedAsset.previewUrl != null &&
          selectedAsset.sourceSize != null && selectedAsset.detection != null && (
          <section className="panel detail-panel" aria-labelledby="detail-heading">
            <div className="panel-heading panel-padding">
              <div>
                <span className="step-label">Inspect &amp; correct</span>
                <h2 id="detail-heading" title={selectedAsset.file.name}>{selectedAsset.file.name}</h2>
              </div>
              <span className="format-note">
                {selectedAsset.metadata?.capturedAt == null
                  ? `${selectedAsset.sourceSize.width} × ${selectedAsset.sourceSize.height}`
                  : `${formatCapturedAt(selectedAsset.metadata.capturedAt)} · ${selectedAsset.sourceSize.width} × ${selectedAsset.sourceSize.height}`}
              </span>
            </div>

            {selectedAsset.status === 'needs-review' && (
              <div className="review-notice" role="status">
                <strong>請先確認月亮圓框</strong>
                <span>自動偵測的信心不足；確認或調整後才可匯出。</span>
              </div>
            )}

            <div className="detail-grid panel-padding panel-padding-topless">
              <MoonEditor
                key={`${selectedAsset.id}-${selectedAsset.revision}`}
                detection={selectedAsset.detection}
                previewUrl={selectedAsset.previewUrl}
                sourceSize={selectedAsset.sourceSize}
                busy={selectedAsset.status === 'queued' || selectedAsset.status === 'running'}
                requiresConfirmation={selectedAsset.status === 'needs-review'}
                onApply={(circle) => { queue.reanalyzeCircle(selectedAsset.id, circle) }}
              />

              {selectedRanking == null ? (
                <div className="metric-placeholder">
                  <span aria-hidden="true">◎</span>
                  <strong>確認圓框後顯示排名</strong>
                  <p>未找到可靠月亮時，不會用預設圓框製造看似精確的分數。</p>
                </div>
              ) : (
                <MetricBreakdown candidate={selectedRanking} />
              )}
            </div>

            <div className="panel-divider" />
            <div className="panel-padding">
              <CropExportPanel
                circle={selectedAsset.detection.circle}
                previewUrl={selectedAsset.previewUrl}
                sourceSize={selectedAsset.sourceSize}
                fixedScaleRecommendation={fixedScaleRecommendation}
                disabled={queueBusy || selectedAsset.status !== 'ready'}
                onExport={exportSelected}
              />
            </div>
          </section>
        )}
      </main>

      <footer>
        <span>{product.privacyMessage}</span>
        <span>{product.displayName} 是暫定 MVP 顯示名稱。</span>
      </footer>
    </div>
  )
}
