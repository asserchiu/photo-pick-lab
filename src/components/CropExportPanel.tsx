import { useMemo, useState } from 'react'
import { analysisConfig, cropOptions as availableOptions } from '../config/analysis'
import {
  type CropAspectRatio,
  type CropOptions,
  type NormalizedCircle,
  type Size,
} from '../domain/types'
import {
  FIXED_CROP_ERROR_CODES,
  fixedSizeCrop,
  type CropMode,
  type ExportCropSpec,
} from '../export/crop'
import { centeredCrop } from '../imaging/geometry'

type ExportFormat = 'image/jpeg' | 'image/png'

interface CropExportPanelProps {
  circle: NormalizedCircle
  previewUrl: string
  sourceSize: Size
  fixedScaleRecommendation: Size | null
  disabled?: boolean
  onExport: (spec: ExportCropSpec, format: ExportFormat) => Promise<void>
}

function positiveInteger(value: string): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function CropExportPanel({
  circle,
  previewUrl,
  sourceSize,
  fixedScaleRecommendation,
  disabled = false,
  onExport,
}: CropExportPanelProps) {
  const [mode, setMode] = useState<CropMode>('fill')
  const [aspectRatio, setAspectRatio] = useState<CropAspectRatio>('1:1')
  const [fill, setFill] = useState<number>(availableOptions.defaultFillRatio)
  const [acceptedRecommendation, setAcceptedRecommendation] = useState<Size | null>(
    fixedScaleRecommendation,
  )
  const [fixedSizeOverride, setFixedSizeOverride] = useState<{
    width: string
    height: string
  } | null>(null)
  const [format, setFormat] = useState<ExportFormat>('image/jpeg')
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)

  if (acceptedRecommendation == null && fixedSizeOverride == null &&
      fixedScaleRecommendation != null) {
    setAcceptedRecommendation(fixedScaleRecommendation)
  }
  const automaticFixedSize = acceptedRecommendation ?? { width: 1920, height: 1080 }
  const targetWidth = fixedSizeOverride?.width ?? String(automaticFixedSize.width)
  const targetHeight = fixedSizeOverride?.height ?? String(automaticFixedSize.height)
  const fillOptions = useMemo<CropOptions>(() => ({ aspectRatio, fill }), [aspectRatio, fill])
  const fixedSize = useMemo<Size>(() => ({
    width: positiveInteger(targetWidth) ?? 0,
    height: positiveInteger(targetHeight) ?? 0,
  }), [targetHeight, targetWidth])
  const updateTargetWidth = (value: string) => {
    setFixedSizeOverride((current) => ({
      width: value,
      height: current?.height ?? targetHeight,
    }))
  }
  const updateTargetHeight = (value: string) => {
    setFixedSizeOverride((current) => ({
      width: current?.width ?? targetWidth,
      height: value,
    }))
  }
  const crop = useMemo(
    () => mode === 'fill'
      ? centeredCrop(sourceSize, circle, fillOptions)
      : fixedSizeCrop(sourceSize, circle, fixedSize),
    [circle, fillOptions, fixedSize, mode, sourceSize],
  )

  const exportImage = async () => {
    setExporting(true)
    setExportMessage(null)
    const spec: ExportCropSpec = mode === 'fill'
      ? { mode: 'fill', options: fillOptions }
      : { mode: 'fixed-scale', size: fixedSize }
    try {
      await onExport(spec, format)
      setExportMessage('已建立下載檔案。原始照片未被修改。')
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : '無法匯出這張照片。')
    } finally {
      setExporting(false)
    }
  }

  let failureMessage = '請調整圓框或裁切設定。'
  if (!crop.ok) {
    if ('minimumFill' in crop && crop.minimumFill != null) {
      failureMessage = `月亮太靠近邊界；填滿比例至少需要 ${Math.ceil(crop.minimumFill * 100)}%。`
    } else if ('errorCode' in crop && crop.errorCode === FIXED_CROP_ERROR_CODES.TARGET_CLIPS_MOON) {
      failureMessage = `目標短邊至少需要 ${crop.minimumShortSide ?? '足以容納月亮的'} px。`
    } else if ('errorCode' in crop && crop.errorCode === FIXED_CROP_ERROR_CODES.TARGET_EXCEEDS_SOURCE) {
      const maximum = crop.maximumCenteredSize
      failureMessage = maximum == null
        ? '目標尺寸超過來源照片。'
        : `維持置中時最多可用 ${maximum.width} × ${maximum.height} px。`
    } else if ('errorCode' in crop && crop.errorCode === FIXED_CROP_ERROR_CODES.INVALID_TARGET_SIZE) {
      failureMessage = '寬度與高度必須是正整數。'
    }
  }

  const cropAspectRatio = crop.ok
    ? crop.rect.width / crop.rect.height
    : mode === 'fill'
      ? availableOptions.aspectRatios.find((option) => option.id === aspectRatio)?.value ?? 1
      : fixedSize.width > 0 && fixedSize.height > 0
        ? fixedSize.width / fixedSize.height
        : 16 / 9
  const actualFill = crop.ok && 'actualFill' in crop ? crop.actualFill : null

  return (
    <section className="crop-export" aria-labelledby="crop-heading">
      <div className="panel-heading">
        <div>
          <span className="step-label">03 · Center &amp; export</span>
          <h3 id="crop-heading">置中裁切</h3>
        </div>
        {crop.ok && (
          <span className="format-note">
            {Math.max(1, Math.floor(crop.rect.width))} × {Math.max(1, Math.floor(crop.rect.height))} px
          </span>
        )}
      </div>

      <div className="mode-switch" role="group" aria-label="裁切模式">
        <button
          type="button"
          aria-label="固定月亮比例；適合輸出單張構圖"
          aria-pressed={mode === 'fill'} onClick={() => setMode('fill')}>
          <strong>固定月亮比例</strong>
          <span>適合輸出單張構圖</span>
        </button>
        <button
          type="button"
          aria-label="同尺度比較；保留不同時期的月亮大小差異"
          aria-pressed={mode === 'fixed-scale'}
          onClick={() => setMode('fixed-scale')}
        >
          <strong>同尺度比較</strong>
          <span>保留不同時期的大小差異</span>
        </button>
      </div>

      <div className="crop-layout">
        <div className="crop-preview" style={{ aspectRatio: cropAspectRatio }}>
          {crop.ok ? (
            <>
              <img
                src={previewUrl}
                alt="月亮置中裁切預覽"
                style={{
                  width: `${sourceSize.width / crop.rect.width * 100}%`,
                  height: `${sourceSize.height / crop.rect.height * 100}%`,
                  left: `${-crop.rect.x / crop.rect.width * 100}%`,
                  top: `${-crop.rect.y / crop.rect.height * 100}%`,
                }}
              />
              <span className="crop-crosshair crop-crosshair-horizontal" aria-hidden="true" />
              <span className="crop-crosshair crop-crosshair-vertical" aria-hidden="true" />
            </>
          ) : (
            <div className="crop-unavailable">
              <strong>無法維持幾何置中</strong>
              <span>{failureMessage}</span>
            </div>
          )}
        </div>

        <div className="crop-controls">
          {mode === 'fill' ? (
            <>
              <fieldset>
                <legend>裁切比例</legend>
                <div className="segmented-control">
                  {availableOptions.aspectRatios.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      aria-pressed={aspectRatio === option.id}
                      onClick={() => setAspectRatio(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend>月亮填滿短邊</legend>
                <div className="segmented-control">
                  {availableOptions.fillRatios.map((option) => (
                    <button
                      type="button"
                      key={option}
                      aria-pressed={fill === option}
                      onClick={() => setFill(option)}
                    >
                      {Math.round(option * 100)}%
                    </button>
                  ))}
                </div>
              </fieldset>
            </>
          ) : (
            <fieldset>
              <legend>目標輸出尺寸（來源像素 1:1）</legend>
              <div className="dimension-inputs">
                <label>
                  <span>寬度</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={targetWidth}
                    onChange={(event) => updateTargetWidth(event.target.value)}
                  />
                </label>
                <span aria-hidden="true">×</span>
                <label>
                  <span>高度</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={targetHeight}
                    onChange={(event) => updateTargetHeight(event.target.value)}
                  />
                </label>
              </div>
              <p className="scale-note">
                不重新縮放：同一相機與焦段下，月亮在輸出中的像素大小差異會被保留。
              </p>
              {actualFill != null && (
                <p className="derived-fill">這張照片的月亮佔短邊 {Math.round(actualFill * 1000) / 10}%</p>
              )}
            </fieldset>
          )}

          <label className="select-field">
            <span>輸出格式</span>
            <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
              <option value="image/jpeg">
                JPEG · quality {Math.round(analysisConfig.jpegQuality * 100)}%
              </option>
              <option value="image/png">PNG · lossless</option>
            </select>
          </label>

          <div className="export-note">
            <strong>非破壞性輸出</strong>
            <span>原檔不變；匯出檔不保留 EXIF、ICC 或其他原始 metadata。</span>
          </div>

          <button
            className="primary-button export-button"
            type="button"
            disabled={disabled || exporting || !crop.ok}
            onClick={() => void exportImage()}
          >
            {exporting ? '正在產生檔案…' : `下載 ${format === 'image/jpeg' ? 'JPEG' : 'PNG'}`}
          </button>
          {exportMessage != null && <p className="export-message" role="status">{exportMessage}</p>}
        </div>
      </div>
    </section>
  )
}
