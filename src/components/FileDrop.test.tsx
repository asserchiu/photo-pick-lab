import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileDrop } from './FileDrop'

describe('FileDrop', () => {
  it('emits every selected file and clears the input', () => {
    const onFiles = vi.fn()
    const { container } = render(<FileDrop onFiles={onFiles} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const files = [
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ]

    fireEvent.change(input, { target: { files } })

    expect(onFiles).toHaveBeenCalledWith(files)
    expect(input.value).toBe('')
  })

  it('does not emit files when disabled', () => {
    const onFiles = vi.fn()
    const { container } = render(<FileDrop disabled onFiles={onFiles} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(input, {
      target: { files: [new File(['one'], 'one.jpg', { type: 'image/jpeg' })] },
    })

    expect(onFiles).not.toHaveBeenCalled()
    expect(screen.getByText('選取照片')).toHaveAttribute('aria-disabled', 'true')
  })
})
