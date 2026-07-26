import type { AssetRecord } from '../app/state'
import type { RankedCandidate } from '../domain/types'
import { formatCapturedAt } from '../ingest/photo'

interface RankedResultsProps {
  assets: AssetRecord[]
  ranked: RankedCandidate[]
  selectedId: string | null
  onSelect: (assetId: string) => void
}

function sourceDiameter(asset: AssetRecord): number | null {
  return asset.quality?.effectiveSourcePixelDiameter ?? null
}

function diameterLabel(asset: AssetRecord, smallestDiameter: number | null): string {
  const diameter = sourceDiameter(asset)
  if (diameter == null || !Number.isFinite(diameter)) return '月亮來源直徑無法量測'
  const rounded = Math.round(diameter)
  if (smallestDiameter == null || smallestDiameter <= 0) return `月亮來源直徑 ${rounded} px`
  const difference = Math.round((diameter / smallestDiameter - 1) * 1000) / 10
  return difference <= 0
    ? `月亮來源直徑 ${rounded} px · 同批基準`
    : `月亮來源直徑 ${rounded} px · 比同批最小大 ${difference}%`
}

function resultMetadataLabel(asset: AssetRecord, smallestDiameter: number | null): string {
  const diameter = diameterLabel(asset, smallestDiameter)
  const capturedAt = formatCapturedAt(asset.metadata?.capturedAt ?? null)
  return capturedAt == null ? diameter : `${capturedAt} · ${diameter}`
}

export function RankedResults({ assets, ranked, selectedId, onSelect }: RankedResultsProps) {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const rankedById = new Map(ranked.map((candidate, index) => [candidate.assetId, { candidate, index }]))
  const rankedIds = new Set(ranked.map((candidate) => candidate.assetId))
  const additional = assets.filter((asset) =>
    asset.previewUrl != null && asset.detection != null && !rankedIds.has(asset.id),
  )
  const orderedAssets = [
    ...ranked.flatMap((candidate) => {
      const asset = assetById.get(candidate.assetId)
      return asset == null ? [] : [asset]
    }),
    ...additional,
  ]
  const diameters = ranked
    .map((candidate) => candidate.quality.effectiveSourcePixelDiameter)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
  const smallestDiameter = diameters.length === 0 ? null : Math.min(...diameters)

  if (orderedAssets.length === 0) return null

  return (
    <section className="panel results-panel" aria-labelledby="results-heading">
      <div className="panel-heading panel-padding">
        <div>
          <span className="step-label">Rank within this set</span>
          <h2 id="results-heading">同批排名</h2>
        </div>
        <span className="format-note">分數不跨批次比較</span>
      </div>

      {ranked.length > 0 && (
        <div className="podium-grid" aria-label="前三名">
          {ranked.slice(0, 3).map((candidate, index) => {
            const asset = assetById.get(candidate.assetId)
            if (asset == null || asset.previewUrl == null) return null
            return (
              <button
                className="podium-card"
                type="button"
                key={candidate.assetId}
                aria-label={`第 ${index + 1} 名，${asset.file.name}，相對分數 ${Math.round(candidate.score)}，${resultMetadataLabel(asset, smallestDiameter)}`}
                aria-pressed={selectedId === candidate.assetId}
                onClick={() => onSelect(candidate.assetId)}
              >
                <div className="podium-image">
                  <img src={asset.previewUrl} alt={asset.file.name} />
                  <span className="rank-badge">#{index + 1}</span>
                  {asset.status === 'needs-review' && <span className="review-flag">圓框待確認</span>}
                </div>
                <div className="podium-copy">
                  <strong title={asset.file.name}>{asset.file.name}</strong>
                  <span className="podium-score">{Math.round(candidate.score)}</span>
                  <small>{resultMetadataLabel(asset, smallestDiameter)}</small>
                </div>
              </button>
            )
          })}
        </div>
      )}

      <div className="all-results" role="list" aria-label="所有分析結果">
        {orderedAssets.map((asset) => {
          const rankedEntry = rankedById.get(asset.id)
          const placeholder = asset.detection?.method === 'manual' && asset.detection.confidence === 0
          return (
            <div role="listitem" key={asset.id}>
              <button
                className="result-row"
                type="button"
                aria-label={`${rankedEntry == null ? '待確認' : `第 ${rankedEntry.index + 1} 名`}，${asset.file.name}，${placeholder ? '尚未找到可靠圓框' : resultMetadataLabel(asset, smallestDiameter)}`}
                aria-pressed={selectedId === asset.id}
                onClick={() => onSelect(asset.id)}
              >
              <span className="result-rank">
                {rankedEntry == null ? '—' : String(rankedEntry.index + 1).padStart(2, '0')}
              </span>
              {asset.previewUrl != null && <img src={asset.previewUrl} alt="" />}
              <span className="result-name">
                <strong>{asset.file.name}</strong>
                <small>
                  {placeholder ? '尚未找到可靠圓框' : resultMetadataLabel(asset, smallestDiameter)}
                </small>
              </span>
              <span className="result-confidence">
                {asset.detection == null ? '—' : `信心 ${Math.round(asset.detection.confidence * 100)}%`}
              </span>
              <span className="result-score">
                {rankedEntry == null ? '待確認' : Math.round(rankedEntry.candidate.score)}
              </span>
              </button>
            </div>
          )
        })}
      </div>

      <p className="scale-comparison-note">
        月亮來源直徑可用來觀察大小差異；有效比較需使用相同相機、來源解析度與焦段，且未套用數位變焦或預先裁切。
      </p>
    </section>
  )
}
