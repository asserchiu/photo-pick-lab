import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CropExportPanel } from './CropExportPanel'

const baseProps = {
  circle: { centerX: 0.5, centerY: 0.5, radius: 0.05 },
  previewUrl: 'blob:preview',
  sourceSize: { width: 6000, height: 4000 },
  fixedScaleRecommendation: null,
}

describe('CropExportPanel', () => {
  it('exports a fill-based crop by default', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn().mockResolvedValue(undefined)
    render(<CropExportPanel {...baseProps} onExport={onExport} />)

    expect(screen.getByRole('button', { name: '85%' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '95%' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'JPEG · quality 90%' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '下載 JPEG' }))

    expect(onExport).toHaveBeenCalledWith(
      { mode: 'fill', options: { aspectRatio: '1:1', fill: 0.85 } },
      'image/jpeg',
    )
  })

  it('uses source pixels directly in same-scale mode', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn().mockResolvedValue(undefined)
    render(<CropExportPanel {...baseProps} onExport={onExport} />)

    await user.click(screen.getByRole('button', { name: /同尺度比較/ }))
    const width = screen.getByRole('spinbutton', { name: '寬度' })
    const height = screen.getByRole('spinbutton', { name: '高度' })
    await user.clear(width)
    await user.type(width, '1600')
    await user.clear(height)
    await user.type(height, '900')
    await user.click(screen.getByRole('button', { name: '下載 JPEG' }))

    expect(onExport).toHaveBeenCalledWith(
      { mode: 'fixed-scale', size: { width: 1600, height: 900 } },
      'image/jpeg',
    )
    expect(screen.getByText(/不重新縮放/)).toBeInTheDocument()
  })

  it('adopts the first recommendation and keeps it across later asset changes', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn().mockResolvedValue(undefined)
    const view = render(<CropExportPanel {...baseProps} onExport={onExport} />)
    await user.click(screen.getByRole('button', { name: /同尺度比較/ }))

    expect(screen.getByRole('spinbutton', { name: '寬度' })).toHaveValue(1920)
    expect(screen.getByRole('spinbutton', { name: '高度' })).toHaveValue(1080)
    view.rerender(
      <CropExportPanel
        {...baseProps}
        fixedScaleRecommendation={{ width: 500, height: 500 }}
        onExport={onExport}
      />,
    )
    expect(screen.getByRole('spinbutton', { name: '寬度' })).toHaveValue(500)
    expect(screen.getByRole('spinbutton', { name: '高度' })).toHaveValue(500)

    view.rerender(
      <CropExportPanel
        {...baseProps}
        circle={{ ...baseProps.circle, radius: 0.06 }}
        fixedScaleRecommendation={{ width: 600, height: 600 }}
        onExport={onExport}
      />,
    )
    expect(screen.getByRole('spinbutton', { name: '寬度' })).toHaveValue(500)
    expect(screen.getByRole('spinbutton', { name: '高度' })).toHaveValue(500)
  })

  it('does not overwrite dimensions edited before the recommendation arrives', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn().mockResolvedValue(undefined)
    const view = render(<CropExportPanel {...baseProps} onExport={onExport} />)
    await user.click(screen.getByRole('button', { name: /同尺度比較/ }))
    const width = screen.getByRole('spinbutton', { name: '寬度' })
    await user.clear(width)
    await user.type(width, '1600')

    view.rerender(
      <CropExportPanel
        {...baseProps}
        fixedScaleRecommendation={{ width: 500, height: 500 }}
        onExport={onExport}
      />,
    )
    expect(width).toHaveValue(1600)
    expect(screen.getByRole('spinbutton', { name: '高度' })).toHaveValue(1080)
  })

  it('blocks a same-scale crop that would cut through the moon', async () => {
    const user = userEvent.setup()
    render(<CropExportPanel {...baseProps} onExport={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /同尺度比較/ }))
    const width = screen.getByRole('spinbutton', { name: '寬度' })
    const height = screen.getByRole('spinbutton', { name: '高度' })
    await user.clear(width)
    await user.type(width, '200')
    await user.clear(height)
    await user.type(height, '200')

    expect(screen.getByText(/目標短邊至少需要 400 px/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下載 JPEG' })).toBeDisabled()
  })
})
