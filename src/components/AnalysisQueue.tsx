import type { AssetRecord, AssetStatus } from '../app/state'
import { formatCapturedAt } from '../ingest/photo'
import type { WorkerProgressStage } from '../workers/protocol'

interface AnalysisQueueProps {
  assets: AssetRecord[]
  onCancel: (assetId: string) => void
  onRetry: (assetId: string) => void
}

const statusLabels: Record<AssetStatus, string> = {
  queued: '等待分析',
  running: '分析中',
  'needs-review': '需要確認圓框',
  ready: '完成',
  failed: '失敗',
  cancelled: '已取消',
}

const stageLabels: Record<WorkerProgressStage, string> = {
  metadata: '讀取拍攝資訊',
  decode: '解碼照片',
  detect: '尋找月亮',
  measure: '量測清晰度',
  preview: '建立預覽',
  export: '產生匯出檔',
}

const errorTranslations: Record<string, string> = {
  UNSUPPORTED_FORMAT: '檔案內容不是支援的 JPEG 或 PNG。',
  FILE_TOO_LARGE: '檔案超過 150 MiB 上限。',
  DECODE_FAILED: '瀏覽器無法解碼這張照片。',
  DECODED_IMAGE_TOO_LARGE: '解碼後超過 8,000 萬像素上限。',
  CANVAS_UNAVAILABLE: '此瀏覽器不支援必要的離線影像處理功能。',
  WORKER_CRASH: '影像分析程序意外停止。',
  WORKER_MESSAGE_ERROR: '影像分析程序回傳了無法讀取的結果。',
  PREVIEW_URL_FAILED: '瀏覽器無法建立預覽。',
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

export function AnalysisQueue({ assets, onCancel, onRetry }: AnalysisQueueProps) {
  if (assets.length === 0) return null

  return (
    <section className="panel queue-panel" aria-labelledby="queue-heading">
      <div className="panel-heading panel-padding">
        <div>
          <span className="step-label">02 · Local analysis</span>
          <h2 id="queue-heading">分析進度</h2>
        </div>
        <span className="format-note">{assets.length} 張照片</span>
      </div>

      <ol className="queue-list">
        {assets.map((asset) => {
          const progress = Math.round((asset.progress?.value ?? (asset.status === 'ready' ? 1 : 0)) * 100)
          const canCancel = asset.status === 'queued' || asset.status === 'running'
          const canRetry = asset.status === 'failed' || asset.status === 'cancelled'
          return (
            <li
              className="queue-item"
              key={asset.id}
              aria-label={`${asset.file.name} · ${statusLabels[asset.status]}`}
            >
              <div className="queue-thumbnail">
                {asset.previewUrl == null ? (
                  <span aria-hidden="true">◐</span>
                ) : (
                  <img src={asset.previewUrl} alt="" />
                )}
              </div>
              <div className="queue-copy">
                <div className="queue-row">
                  <strong title={asset.file.name}>{asset.file.name}</strong>
                  <span className={`status-text status-${asset.status}`}>
                    {statusLabels[asset.status]}
                  </span>
                </div>
                <div className="queue-meta">
                  <span>{fileSize(asset.file.size)}</span>
                  {asset.sourceSize != null && (
                    <span>{asset.sourceSize.width} × {asset.sourceSize.height}</span>
                  )}
                  {asset.metadata?.capturedAt != null && (
                    <span>{formatCapturedAt(asset.metadata.capturedAt)}</span>
                  )}
                </div>
                {(asset.status === 'running' || asset.status === 'queued') && (
                  <div className="queue-progress-wrap">
                    <div
                      className="queue-progress"
                      role="progressbar"
                      aria-label={`${asset.file.name} 分析進度`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                    >
                      <span style={{ width: `${progress}%` }} />
                    </div>
                    <small>
                      {asset.progress == null ? '等待開始' : stageLabels[asset.progress.stage]}
                    </small>
                  </div>
                )}
                {asset.error != null && (
                  <p className="queue-error" role="alert">
                    {errorTranslations[asset.error.code] ?? asset.error.message}
                  </p>
                )}
              </div>
              <div className="queue-action">
                {canCancel && (
                  <button className="ghost-button" type="button" onClick={() => onCancel(asset.id)}>
                    取消
                  </button>
                )}
                {canRetry && (
                  <button className="secondary-button" type="button" onClick={() => onRetry(asset.id)}>
                    重試
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
