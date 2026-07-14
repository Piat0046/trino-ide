import { describe, expect, it } from 'vitest'
import { derivePreviewPager, shouldApplyPreviewUpdate } from './previewPagination'

describe('derivePreviewPager', () => {
  it('enables Next only after the first row of the next local page is committed', () => {
    const fullCurrent = derivePreviewPager({
      state: 'running',
      availableRows: 500,
      page: 0,
      pageSize: 500,
      currentRows: 500
    })
    const nextStarted = derivePreviewPager({
      state: 'running',
      availableRows: 501,
      page: 0,
      pageSize: 500,
      currentRows: 500
    })

    expect(fullCurrent.canNext).toBe(false)
    expect(nextStarted.canNext).toBe(true)
    expect(nextStarted.statusLabel).toContain('501+행 수신 중')
  })

  it('reports the absolute range for a locally loaded page', () => {
    expect(
      derivePreviewPager({
        state: 'finished',
        availableRows: 8721,
        page: 2,
        pageSize: 500,
        currentRows: 500
      })
    ).toMatchObject({
      page: 2,
      rangeFrom: 1001,
      rangeTo: 1500,
      canPrev: true,
      canNext: true,
      warning: false
    })
  })

  it('labels a row cap as a Preview limit rather than a table total', () => {
    const pager = derivePreviewPager({
      state: 'row_limit',
      availableRows: 10_000,
      page: 19,
      pageSize: 500,
      currentRows: 500
    })

    expect(pager.canNext).toBe(false)
    expect(pager.warning).toBe(true)
    expect(pager.statusLabel).toBe('/ 10,000행 표시됨 · Preview 한도 도달')
  })

  it('keeps cancelled partial pages navigable while marking them as partial', () => {
    const pager = derivePreviewPager({
      state: 'cancelled',
      availableRows: 1200,
      page: 1,
      pageSize: 500,
      currentRows: 500
    })

    expect(pager.canPrev).toBe(true)
    expect(pager.canNext).toBe(true)
    expect(pager.warning).toBe(true)
    expect(pager.statusLabel).toContain('중지된 부분 결과')
  })
})

describe('shouldApplyPreviewUpdate', () => {
  const base = {
    sessionId: 'session-1',
    columns: [],
    availableRows: 0,
    storedBytes: 0
  }

  it('rejects a late starting response after a running event', () => {
    expect(
      shouldApplyPreviewUpdate(
        { ...base, state: 'running' },
        { ...base, state: 'starting' }
      )
    ).toBe(false)
  })

  it('rejects row-count rollback and accepts forward progress', () => {
    expect(
      shouldApplyPreviewUpdate(
        { ...base, state: 'running', availableRows: 500 },
        { ...base, state: 'running', availableRows: 100 }
      )
    ).toBe(false)
    expect(
      shouldApplyPreviewUpdate(
        { ...base, state: 'running', availableRows: 500 },
        { ...base, state: 'finished', availableRows: 500 }
      )
    ).toBe(true)
  })
})
