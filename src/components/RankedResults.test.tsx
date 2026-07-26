import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AssetRecord } from '../app/state'
import { selectRankedAssets } from '../app/state'
import { testDetection, testMetadata, testQuality } from '../test/analysisFixtures'
import { RankedResults } from './RankedResults'

function readyAsset(id: string, ingestIndex: number, capturedAt: string): AssetRecord {
  return {
    id,
    ingestIndex,
    revision: 1,
    file: new File(['photo'], 'DSC00003.JPG', { type: 'image/jpeg' }),
    status: 'ready',
    progress: null,
    metadata: { ...testMetadata, capturedAt },
    sourceSize: { width: 6192, height: 4128 },
    previewUrl: `blob:${id}`,
    detection: testDetection(),
    quality: testQuality(),
    manualCircle: null,
    error: null,
  }
}

describe('RankedResults', () => {
  it('shows capture times so repeated camera filenames remain distinguishable', () => {
    const assets = [
      readyAsset('first', 0, '2026:05:30 22:24:06'),
      readyAsset('second', 1, '2026:05:31 20:28:32'),
    ]
    const ranked = selectRankedAssets({ assets })

    render(
      <RankedResults
        assets={assets}
        ranked={ranked}
        selectedId="first"
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('button', { name: /2026-05-30 22:24:06/ })).not.toHaveLength(0)
    expect(screen.getAllByRole('button', { name: /2026-05-31 20:28:32/ })).not.toHaveLength(0)
  })
})
