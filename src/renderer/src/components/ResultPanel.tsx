import type { QueryResultPayload } from '@shared/types'

interface Props {
  result: QueryResultPayload | null
  error: string | null
  running: boolean
}

/** DOM에 한 번에 그릴 최대 행 수(가상 스크롤 도입 전 보호 장치) */
const DISPLAY_LIMIT = 2000

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

export function ResultPanel({ result, error, running }: Props): JSX.Element {
  if (running) return <div className="result result-status">실행 중…</div>
  if (error)
    return (
      <div className="result result-error">
        <pre>{error}</pre>
      </div>
    )
  if (!result)
    return <div className="result result-status">쿼리를 실행하면 결과가 여기에 표시됩니다.</div>

  const shown = result.rows.slice(0, DISPLAY_LIMIT)
  const stats = result.stats

  return (
    <div className="result">
      <div className="result-stats">
        <span>{result.rowCount.toLocaleString()} rows</span>
        {result.truncated && <span className="warn">· {DISPLAY_LIMIT >= result.rowCount ? '상한 도달' : '일부만 수신'}</span>}
        {shown.length < result.rowCount && (
          <span className="warn">· 화면에는 {shown.length.toLocaleString()}행만 표시</span>
        )}
        {stats && (
          <>
            <span>· {stats.state}</span>
            {stats.elapsedMs != null && <span>· {(stats.elapsedMs / 1000).toFixed(2)}s</span>}
            {stats.processedRows != null && (
              <span>· {stats.processedRows.toLocaleString()} rows scanned</span>
            )}
            {stats.processedBytes != null && <span>· {formatBytes(stats.processedBytes)}</span>}
          </>
        )}
      </div>

      <div className="result-grid-wrap">
        <table className="result-grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {result.columns.map((c, i) => (
                <th key={i} title={c.type}>
                  {c.name}
                  <span className="coltype">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, ri) => (
              <tr key={ri}>
                <td className="rownum">{ri + 1}</td>
                {row.map((cell, ci) => (
                  <td key={ci} className={cell === null ? 'null-cell' : undefined}>
                    {cell === null ? 'NULL' : formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
