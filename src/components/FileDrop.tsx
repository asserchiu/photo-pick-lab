import { useId, useState, type ChangeEvent, type DragEvent } from 'react'

interface FileDropProps {
  disabled?: boolean
  onFiles: (files: File[]) => void
}

export function FileDrop({ disabled = false, onFiles }: FileDropProps) {
  const inputId = useId()
  const [dragging, setDragging] = useState(false)

  const emitFiles = (files: FileList | null) => {
    if (disabled || files == null) return
    onFiles(Array.from(files))
  }

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    emitFiles(event.target.files)
    // Selecting the same file again should still create a new import action.
    event.target.value = ''
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (!disabled) setDragging(true)
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragging(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    emitFiles(event.dataTransfer.files)
  }

  return (
    <div
      className="drop-zone"
      data-dragging={dragging}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span className="drop-icon" aria-hidden="true">＋</span>
      <strong>拖放一批月亮照片</strong>
      <span>同一天或相似構圖的照片最適合互相比較</span>
      <label className="file-button" htmlFor={inputId} aria-disabled={disabled}>
        選取照片
      </label>
      <input
        className="sr-only"
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
        multiple
        disabled={disabled}
        onChange={handleInput}
      />
    </div>
  )
}
