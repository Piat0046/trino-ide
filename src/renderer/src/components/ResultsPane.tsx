import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { QueryResultPayload } from '@shared/types'
import { IconChevronLeft, IconChevronRight } from './icons'

interface Props {
  result: QueryResultPayload | null
  error: string | null
  running: boolean
  onPrevPage: () => void
  onNextPage: () => void
}

const HEAD_H = 42
const ROW_H = 30
const CHAR_W = 7.3
const ROWNUM_W = 66
const MIN_COL = 84
const MAX_COL = 460

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
  const parentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error) setTab('messages')
    else if (result) setTab('results')
  }, [result, error])

  // 새 결과가 오면 스크롤을 맨 위로
  useEffect(() => {
    parentRef.current?.scrollTo(0, 0)
  }, [result])

  const columns = result?.columns ?? []
  const rows = result?.rows ?? []
  const numericCols = columns.map((c) => typeClass(c.type) === 't-num')

  // 열 너비: 헤더 + 상위 300행 샘플의 최대 문자 수 기반(가상화라 미리 고정)
  const widths = useMemo(() => {
    const sample = rows.slice(0, 300)
    return columns.map((c, ci) => {
      let max = Math.max(c.name.length, c.type.length + 2)
      for (const r of sample) {
        const v = r[ci]
        const len = v === null ? 4 : typeof v === 'object' ? JSON.stringify(v).length : String(v).length
        if (len > max) max = len
      }
      return Math.min(MAX_COL, Math.max(MIN_COL, Math.round(max * CHAR_W) + 26))
    })
  }, [result]) // eslint-disable-line react-hooks/exhaustive-deps

  const rowVirt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
    scrollMargin: HEAD_H
  })

  const template = `${ROWNUM_W}px ${widths.map((w) => `${w}px`).join(' ')}`
  const totalWidth = ROWNUM_W + widths.reduce((a, b) => a + b, 0)
  const baseIndex = result?.paginated ? result.page * (result.pageSize ?? 0) : 0
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
              <div className="ok-line">✓ 완료 · {stats?.state ?? 'FINISHED'}</div>
              <div>
                {result.rowCount.toLocaleString()} rows {result.paginated ? `(page ${result.page + 1})` : ''}
              </div>
              {stats?.elapsedMs != null && <div>소요 {(stats.elapsedMs / 1000).toFixed(2)}s</div>}
              {stats?.processedRows != null && (
                <div>
                  스캔 {stats.processedRows.toLocaleString()} rows · {formatBytes(stats.processedBytes)}
                </div>
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
            <div className="grid-wrap" ref={parentRef}>
              <div className="grid2" style={{ width: totalWidth, minWidth: '100%' }}>
                <div className="grid2-head" style={{ gridTemplateColumns: template, height: HEAD_H }}>
                  <div className="g-hcell rownum">#</div>
                  {columns.map((c, i) => (
                    <div className="g-hcell" key={i} title={c.type}>
                      <span className="col-name">{c.name}</span>
                      <span className={'col-type ' + typeClass(c.type)}>{c.type}</span>
                    </div>
                  ))}
                </div>
                <div className="grid2-body" style={{ height: rowVirt.getTotalSize() }}>
                  {rowVirt.getVirtualItems().map((vi) => {
                    const row = rows[vi.index]
                    return (
                      <div
                        className="g-row"
                        key={vi.key}
                        style={{
                          gridTemplateColumns: template,
                          height: ROW_H,
                          transform: `translateY(${vi.start - rowVirt.options.scrollMargin}px)`
                        }}
                      >
                        <div className="g-cell rownum">{(baseIndex + vi.index + 1).toLocaleString()}</div>
                        {row.map((cell, ci) => (
                          <div
                            key={ci}
                            className={'g-cell' + (numericCols[ci] ? ' num' : '') + (cell === null ? ' null' : '')}
                          >
                            {cell === null ? 'NULL' : formatCell(cell)}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>
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
          {result.truncated && (
            <span className="stat" style={{ color: 'var(--warn)' }}>
              안전 상한 도달 — 더 보려면 LIMIT 페이지네이션 사용
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
