import type { HistoryEntry } from '@shared/types'

interface Props {
  history: HistoryEntry[]
  /** host가 아직 존재하는 id 집합 (지워진 host 표시용) */
  liveHostIds: Set<string>
  onLoad: (entry: HistoryEntry) => void
  onRun: (entry: HistoryEntry) => void
  onDelete: (id: string) => void
  onClear: () => void
}

function firstLine(sql: string): string {
  const line = sql.split('\n').find((l) => l.trim().length > 0) ?? sql
  return line.trim()
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function HistoryList({
  history,
  liveHostIds,
  onLoad,
  onRun,
  onDelete,
  onClear
}: Props): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-action">
        <button
          className="block-btn"
          onClick={() => {
            if (history.length && confirm('실행 기록을 모두 지울까요?')) onClear()
          }}
          disabled={history.length === 0}
        >
          전체 삭제
        </button>
      </div>
      <ul className="history-list">
        {history.length === 0 && <li className="empty">실행 기록이 없습니다.</li>}
        {history.map((h) => {
          const hostGone = !liveHostIds.has(h.hostId)
          return (
            <li
              key={h.id}
              className="history-item"
              onClick={() => onLoad(h)}
              onDoubleClick={() => onRun(h)}
              title="클릭: 에디터에 로드 · 더블클릭: 다시 실행"
            >
              <div className="history-top">
                <span className={'history-status ' + (h.ok ? 'ok' : 'fail')}>
                  {h.ok ? '●' : '▲'}
                </span>
                <span className="history-sql">{firstLine(h.sql)}</span>
              </div>
              <div className="history-meta">
                <span>{formatTime(h.ranAt)}</span>
                <span className={'history-host' + (hostGone ? ' gone' : '')}>
                  {h.hostName}
                  {hostGone ? ' (삭제됨)' : ''}
                </span>
                {h.ok && h.rowCount != null && <span>{h.rowCount.toLocaleString()} rows</span>}
                {h.ok && h.elapsedMs != null && <span>{(h.elapsedMs / 1000).toFixed(2)}s</span>}
                {!h.ok && <span className="history-err">실패</span>}
              </div>
              <div className="row-actions">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRun(h)
                  }}
                >
                  실행 ▶
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(h.id)
                  }}
                >
                  삭제
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
