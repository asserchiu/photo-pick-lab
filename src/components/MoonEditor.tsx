import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { CircleDetection, NormalizedCircle, Size } from '../domain/types'
import { normalizedCircleToPixels } from '../imaging/geometry'

type DragMode = 'center' | 'radius'

interface MoonEditorProps {
  detection: CircleDetection
  previewUrl: string
  sourceSize: Size
  busy?: boolean
  requiresConfirmation?: boolean
  onApply: (circle: NormalizedCircle) => void
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function sameCircle(left: NormalizedCircle, right: NormalizedCircle): boolean {
  return Math.abs(left.centerX - right.centerX) < 1e-6 &&
    Math.abs(left.centerY - right.centerY) < 1e-6 &&
    Math.abs(left.radius - right.radius) < 1e-6
}

export function MoonEditor({
  detection,
  previewUrl,
  sourceSize,
  busy = false,
  requiresConfirmation = false,
  onApply,
}: MoonEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [draft, setDraft] = useState(detection.circle)
  const [dragMode, setDragMode] = useState<DragMode | null>(null)

  const pixelCircle = useMemo(
    () => normalizedCircleToPixels(draft, sourceSize),
    [draft, sourceSize],
  )

  const pointerPosition = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    }
  }

  const updateFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (dragMode == null) return
    const point = pointerPosition(event)
    if (point == null) return

    if (dragMode === 'center') {
      setDraft((current) => ({ ...current, centerX: point.x, centerY: point.y }))
      return
    }

    setDraft((current) => {
      const sourceDx = (point.x - current.centerX) * sourceSize.width
      const sourceDy = (point.y - current.centerY) * sourceSize.height
      return {
        ...current,
        radius: clamp(
          Math.hypot(sourceDx, sourceDy) / Math.min(sourceSize.width, sourceSize.height),
          0.005,
          0.7,
        ),
      }
    })
  }

  const beginDrag = (event: PointerEvent<SVGElement>, mode: DragMode) => {
    event.preventDefault()
    setDragMode(mode)
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const finishDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragMode(null)
  }

  const moveCenterByKeyboard = (event: KeyboardEvent<SVGCircleElement>) => {
    const step = event.shiftKey ? 0.01 : 0.0025
    const directions: Record<string, readonly [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const direction = directions[event.key]
    if (direction == null) return
    event.preventDefault()
    setDraft((current) => ({
      ...current,
      centerX: clamp(current.centerX + direction[0], 0, 1),
      centerY: clamp(current.centerY + direction[1], 0, 1),
    }))
  }

  const resizeByKeyboard = (event: KeyboardEvent<SVGCircleElement>) => {
    const step = event.shiftKey ? 0.01 : 0.0025
    if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    const increase = event.key === 'ArrowRight' || event.key === 'ArrowUp'
    setDraft((current) => ({
      ...current,
      radius: clamp(current.radius + (increase ? step : -step), 0.005, 0.7),
    }))
  }

  if (pixelCircle == null) return null

  const confidence = Math.round(detection.confidence * 100)
  const dirty = !sameCircle(draft, detection.circle)

  return (
    <div className="moon-editor">
      <div
        className="editor-stage"
        style={{ aspectRatio: `${sourceSize.width} / ${sourceSize.height}` }}
      >
        <img src={previewUrl} alt="選取照片的月亮偵測預覽" draggable={false} />
        <svg
          ref={svgRef}
          viewBox={`0 0 ${sourceSize.width} ${sourceSize.height}`}
          aria-label="月亮幾何圓調整器"
          onPointerMove={updateFromPointer}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <circle
            className="detection-ring"
            cx={pixelCircle.centerX}
            cy={pixelCircle.centerY}
            r={pixelCircle.radius}
          />
          <line
            className="radius-guide"
            x1={pixelCircle.centerX}
            y1={pixelCircle.centerY}
            x2={pixelCircle.centerX + pixelCircle.radius}
            y2={pixelCircle.centerY}
          />
          <circle
            className="editor-handle center-handle"
            cx={pixelCircle.centerX}
            cy={pixelCircle.centerY}
            r={Math.max(8, Math.min(sourceSize.width, sourceSize.height) * 0.012)}
            role="slider"
            tabIndex={0}
            aria-label="調整月亮圓心"
            aria-valuetext={`X ${Math.round(draft.centerX * 100)}%，Y ${Math.round(draft.centerY * 100)}%`}
            onPointerDown={(event) => beginDrag(event, 'center')}
            onKeyDown={moveCenterByKeyboard}
          />
          <circle
            className="editor-handle radius-handle"
            cx={pixelCircle.centerX + pixelCircle.radius}
            cy={pixelCircle.centerY}
            r={Math.max(8, Math.min(sourceSize.width, sourceSize.height) * 0.012)}
            role="slider"
            tabIndex={0}
            aria-label="調整月亮半徑"
            aria-valuemin={1}
            aria-valuemax={70}
            aria-valuenow={Math.round(draft.radius * 100)}
            onPointerDown={(event) => beginDrag(event, 'radius')}
            onKeyDown={resizeByKeyboard}
          />
        </svg>
      </div>

      <div className="editor-toolbar">
        <div>
          <span className={`confidence-badge confidence-${confidence >= 70 ? 'high' : 'review'}`}>
            偵測信心 {confidence}%
          </span>
          <p>拖曳中心點與圓周控制點來修正偵測圓框。</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={busy || (!dirty && !requiresConfirmation)}
          onClick={() => onApply(draft)}
        >
          {requiresConfirmation ? '確認圓框並重新評分' : '套用並重新評分'}
        </button>
      </div>
    </div>
  )
}
