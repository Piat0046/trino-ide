import type { HostConfig, QueryResultPayload } from '@shared/types'

interface Props {
  selectedHost: HostConfig | null
  running: boolean
  result: QueryResultPayload | null
  error: string | null
}

function fmtMs(ms?: number): string {
  if (ms == null) return '—'
  return (ms / 1000).toFixed(2) + 's'
}

export function StatusBar({ selectedHost, running, result, error }: Props): JSX.Element {
  // 실제 상태 반영: 실행중=앰버, 오류=빨강, 최근 실행 성공=초록, 선택만 됨=중립, 미선택=회색
  const dotClass = running ? 'busy' : error ? 'err' : result ? 'on' : selectedHost ? 'idle' : ''
  const ctx = selectedHost
    ? [selectedHost.catalog, selectedHost.schema].filter(Boolean).join('.')
    : ''

  return (
    <footer className="statusbar">
      <span className="conn-live">
        <span className={'live-dot ' + dotClass} />
        {selectedHost ? selectedHost.name : '연결 선택 안 됨'}
      </span>
      {selectedHost && <span>{selectedHost.url}</span>}
      {ctx && <span className="ctx-badge">{ctx}</span>}
      <span className="spacer" />
      {running && <span>실행 중…</span>}
      {!running && error && <span style={{ color: 'var(--danger)' }}>오류</span>}
      {!running && result && (
        <>
          <span>{result.rowCount.toLocaleString()} rows</span>
          <span>{fmtMs(result.stats?.elapsedMs)}</span>
          {result.paginated && <span>page {result.page + 1}</span>}
        </>
      )}
    </footer>
  )
}
