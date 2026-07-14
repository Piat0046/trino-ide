import type { PreviewSessionState, PreviewSessionUpdate } from '@shared/types'

export interface PreviewPagerInput {
  state: PreviewSessionState
  availableRows: number
  page: number
  pageSize: number
  currentRows: number
}

export interface PreviewPagerView {
  page: number
  rangeFrom: number
  rangeTo: number
  canPrev: boolean
  canNext: boolean
  statusLabel: string
  warning: boolean
}

const STATE_RANK: Record<PreviewSessionState, number> = {
  starting: 0,
  running: 1,
  finished: 2,
  cancelled: 2,
  failed: 2,
  row_limit: 2,
  size_limit: 2
}

/** 늦게 돌아온 start 응답이 이미 진행된 세션 상태나 행 수를 되돌리지 않게 한다. */
export function shouldApplyPreviewUpdate(
  previous: PreviewSessionUpdate | undefined,
  next: PreviewSessionUpdate
): boolean {
  if (!previous || previous.sessionId !== next.sessionId) return true
  if (next.availableRows < previous.availableRows) return false
  return STATE_RANK[next.state] >= STATE_RANK[previous.state]
}

/** Main process에 append 완료된 행만으로 로컬 Preview 페이저 상태를 계산한다. */
export function derivePreviewPager(input: PreviewPagerInput): PreviewPagerView {
  const page = Math.max(0, Math.floor(input.page))
  const pageSize = Math.max(1, Math.floor(input.pageSize))
  const availableRows = Math.max(0, Math.floor(input.availableRows))
  const currentRows = Math.max(0, Math.floor(input.currentRows))
  const offset = page * pageSize
  const running = input.state === 'starting' || input.state === 'running'

  let statusLabel: string
  switch (input.state) {
    case 'starting':
      statusLabel = availableRows > 0 ? `/ ${availableRows.toLocaleString()}+행 수신 중` : '· 수신 준비 중'
      break
    case 'running':
      statusLabel = `/ ${availableRows.toLocaleString()}+행 수신 중`
      break
    case 'row_limit':
      statusLabel = `/ ${availableRows.toLocaleString()}행 표시됨 · Preview 한도 도달`
      break
    case 'size_limit':
      statusLabel = `/ ${availableRows.toLocaleString()}행 표시됨 · 256 MiB 저장 한도 도달`
      break
    case 'cancelled':
      statusLabel = `/ ${availableRows.toLocaleString()}행 · 중지된 부분 결과`
      break
    case 'failed':
      statusLabel = `/ ${availableRows.toLocaleString()}행 · 오류 전 부분 결과`
      break
    case 'finished':
    default:
      statusLabel = `/ ${availableRows.toLocaleString()}행`
      break
  }

  return {
    page,
    rangeFrom: currentRows > 0 ? offset + 1 : 0,
    rangeTo: offset + currentRows,
    canPrev: page > 0,
    // 다음 페이지의 첫 행이 append 완료된 뒤에만 이동한다.
    canNext: availableRows > (page + 1) * pageSize,
    statusLabel,
    warning: !running && input.state !== 'finished'
  }
}
