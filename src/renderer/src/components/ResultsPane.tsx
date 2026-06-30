import { useEffect, useState } from 'react'
import type { QueryColumn, QueryResultPayload } from '@shared/types'
import { IconChevronLeft, IconChevronRight } from './icons'

interface Props {
  result: QueryResultPayload | null
  error: string | null
  running: boolean
  onPrevPage: () => void
  onNextPage: () => void
}

/** DOM에 한 번에 그릴 최대 행 수(가상 스크롤 도입 전 보호 장치) */
const DISPLAY_LIMIT = 2000

type TypeClass = 't-num' | 't-str' | 't-time' | 't-bool'

function typeClass(type: string): TypeClass {
  const t = type.toLowerCase()
  if (/(int|bigint|smallint|tinyint|double|real|decimal|numeric|float)/.test(t)) return 't-num'
  if (/(timestamp|date|time|interval)/.test(t)) return 't-time'
  if (/bool/.test(t)) return 't-bool'
  return 't-str'
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function formatBytes(n?: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

export function ResultsPane({ result, error, running, onPrevPage, onNextPage }: Props): JSX.Element {
  const [tab, setTab] = useState<'results' | 'messages'>('results')

  // 새 실행 결과/오류에 맞춰 탭 자동 전환
  useEffect(() => {
    if (error) setTab('messages')
    else if (result) setTab('results')
  }, [result, error])

  const numericCols = (result?.columns ?? []).map((c: QueryColumn) => typeClass(c.type) === 't-num')
  const shown = result ? result.rows.slice(0, DISPLAY_LIMIT) : []
  const stats = result?.stats

  return (
    <section className="results">
      <div className="results-tabs">
        <button
          className={'results-tab' + (tab === 'results' ? ' active' : '')}
          onClick={() => setTab('results')}
        >
          Results
          {result && <span className="badge">{result.rowCount.toLocaleString()}</span>}
        </button>
        <button
          className={'results-tab' + (tab === 'messages' ? ' active' : '')}
          onClick={() => setTab('messages')}
        >
          Messages
          {error && <span className="badge err">●</span>}
        </button>
      </div>

      <div className="results-body">
        {running ? (
          <div className="results-status">
            <span className="spin" />
            실행 중…
          </div>
        ) : tab === 'messages' ? (
          error ? (
            <pre className="messages error">{error}</pre>
          ) : result ? (
            <div className="messages">
              <div className="ok-line">✓ 완료 · {result.stats?.state ?? 'FINISHED'}</div>
              <div>{result.rowCount.toLocaleString()} rows {result.paginated ? `(page ${result.page + 1})` : ''}</div>
              {stats?.elapsedMs != null && <div>소요 {(stats.elapsedMs / 1000).toFixed(2)}s</div>}
              {stats?.processedRows != null && (
                <div>스캔 {stats.processedRows.toLocaleString()} rows · {formatBytes(stats.processedBytes)}</div>
              )}
            </div>
          ) : (
            <div className="results-status">메시지가 없습니다.</div>
          )
        ) : !result ? (
          <div className="results-status">
            {error ? 'Messages 탭에서 오류를 확인하세요.' : '쿼리를 실행하면 결과가 여기에 표시됩니다.'}
          </div>
        ) : (
          <>
            {result.orderByWarning && (
              <div className="warn-banner">
                ⚠ ORDER BY가 없어 페이지 간 행 순서가 일정하지 않을 수 있습니다.
              </div>
            )}
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th className="rownum">#</th>
                    {result.columns.map((c, i) => (
                      <th key={i} title={c.type}>
                        <span className="col-name">{c.name}</span>
                        <span className={'col-type ' + typeClass(c.type)}>{c.type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row, ri) => {
                    const baseIndex = result.paginated ? result.page * (result.pageSize ?? 0) : 0
                    return (
                      <tr key={ri}>
                        <td className="rownum">{baseIndex + ri + 1}</td>
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            className={
                              (cell === null ? 'null' : '') + (numericCols[ci] ? ' num' : '')
                            }
                          >
                            {cell === null ? 'NULL' : formatCell(cell)}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {result && !running && (
        <div className="transport">
          {result.paginated && (
            <div className="pager">
              <button onClick={onPrevPage} disabled={result.page === 0} title="이전 페이지">
                <IconChevronLeft size={14} />
              </button>
              <span className="page-label">Page {result.page + 1}</span>
              <button onClick={onNextPage} disabled={!result.hasNext} title="다음 페이지">
                <IconChevronRight size={14} />
              </button>
            </div>
          )}
          <span className="stat">
            <b>{result.rowCount.toLocaleString()}</b> rows{result.paginated ? ' / page' : ''}
          </span>
          {result.truncated && <span className="stat" style={{ color: 'var(--warn)' }}>LIMIT 도달</span>}
          {shown.length < result.rowCount && (
            <span className="stat" style={{ color: 'var(--warn)' }}>
              화면 {shown.length.toLocaleString()}행
            </span>
          )}
          {stats?.elapsedMs != null && (
            <span className="stat">
              <b>{(stats.elapsedMs / 1000).toFixed(2)}s</b>
            </span>
          )}
          {stats?.processedRows != null && (
            <span className="stat">
              scan <b>{stats.processedRows.toLocaleString()}</b>
            </span>
          )}
          {stats?.processedBytes != null && (
            <span className="stat">
              <b>{formatBytes(stats.processedBytes)}</b>
            </span>
          )}
          <span className="spacer" />
        </div>
      )}
    </section>
  )
}
