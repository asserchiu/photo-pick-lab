import type { NormalizedQualityFactors, RankedCandidate, RawMetric } from '../domain/types'

interface MetricBreakdownProps {
  candidate: RankedCandidate
}

interface MetricRow {
  key: keyof NormalizedQualityFactors
  label: string
  hint: string
  raw: RawMetric
}

const reasonTranslations: Record<string, string> = {
  'Strong surface texture': '月面紋理較清楚',
  'Soft surface texture': '月面紋理偏柔',
  'Crisp lunar limb': '月緣較銳利',
  'Soft lunar limb': '月緣偏柔',
  'High source-pixel diameter': '月亮原始像素較多',
  'Low source-pixel diameter': '月亮原始像素較少',
  'Low directional blur': '方向性模糊較少',
  'Directional blur': '有方向性動態模糊',
  'Highlights retain detail': '高光細節保留較多',
  'Clipped highlights': '高光截斷較多',
  'Low visible noise': '可見雜訊較少',
  'Visible noise': '可見雜訊較多',
  'Clear local contrast': '局部對比較清楚',
  'Low-contrast haze': '低對比或霧氣較明顯',
  'No decisive quality difference': '與同批候選接近',
}

function rawValue(metric: RawMetric): string {
  if (metric.value == null) return '無法可靠量測'
  return `${Number(metric.value.toPrecision(4))} · 可靠度 ${Math.round(metric.reliability * 100)}%`
}

export function MetricBreakdown({ candidate }: MetricBreakdownProps) {
  const metrics = candidate.quality.metrics
  const rows: MetricRow[] = [
    {
      key: 'textureSharpness',
      label: '月面紋理',
      hint: 'Surface texture',
      raw: metrics.textureSharpness,
    },
    {
      key: 'limbSharpness',
      label: '月緣銳利度',
      hint: 'Lunar limb',
      raw: metrics.limbSharpness,
    },
    {
      key: 'effectiveResolution',
      label: '有效解析度',
      hint: 'Source pixels',
      raw: metrics.effectiveResolution,
    },
    {
      key: 'motionBlur',
      label: '低動態模糊',
      hint: 'Motion stability',
      raw: metrics.motionBlurPenalty,
    },
    {
      key: 'clipping',
      label: '高光細節',
      hint: 'Highlight detail',
      raw: metrics.clippingPenalty,
    },
    {
      key: 'noise',
      label: '低雜訊',
      hint: 'Noise control',
      raw: metrics.noisePenalty,
    },
    {
      key: 'haze',
      label: '局部對比',
      hint: 'Atmospheric clarity',
      raw: metrics.hazePenalty,
    },
  ]

  return (
    <section className="metric-breakdown" aria-labelledby="metrics-heading">
      <div className="score-summary">
        <div>
          <span className="step-label">Batch-relative score</span>
          <h3 id="metrics-heading">同批技術品質</h3>
        </div>
        <strong aria-label={`相對分數 ${Math.round(candidate.score)} 分`}>
          {Math.round(candidate.score)}
          <span>/100</span>
        </strong>
      </div>

      <ul className="reason-list" aria-label="主要排名理由">
        {candidate.reasons.map((reason) => (
          <li key={reason}>{reasonTranslations[reason] ?? reason}</li>
        ))}
      </ul>

      <div className="metric-list" role="list" aria-label="評分項目">
        {rows.map((row) => {
          const value = Math.round(candidate.normalized[row.key] * 100)
          return (
            <div className="metric-row" role="listitem" key={row.key} title={rawValue(row.raw)}>
              <div className="metric-label">
                <span>{row.label}</span>
                <small>{row.hint}</small>
              </div>
              <div
                className="metric-track"
                role="progressbar"
                aria-label={row.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={value}
                aria-valuetext={`${value} 分；${rawValue(row.raw)}`}
              >
                <span style={{ width: `${value}%` }} />
              </div>
              <output>{value}</output>
            </div>
          )
        })}
      </div>
      <p className="relative-note">分數只在目前匯入的照片間比較，不代表跨批次的絕對品質。</p>
    </section>
  )
}
