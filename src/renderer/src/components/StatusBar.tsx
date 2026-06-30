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
  const dotClass = running ? 'busy' : selectedHost ? 'on' : ''

  return (
    <footer className="statusbar">
      <span className="conn-live">
        <span className={'live-dot ' + dotClass} />
        {selectedHost ? selectedHost.name : '연결 안 됨'}
      </span>
      {selectedHost && <span>{selectedHost.url}</span>}
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
