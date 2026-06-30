import { Trino, BasicAuth, type QueryError, type QueryResult } from 'trino-client'
import type { QueryResultPayload } from '@shared/types'

/** rowLimit 미지정 시 사용할 기본 수신 상한. */
const DEFAULT_ROW_LIMIT = 300

/** 비밀번호까지 복호화가 끝난, Trino 접속에 필요한 모든 값 */
export interface ResolvedConn {
  url: string
  user: string
  catalog?: string
  schema?: string
  insecure?: boolean
  password?: string
}

/** 실행 중 쿼리를 취소하기 위한 토큰. ipc 레이어가 보관/조작한다. */
export interface CancelToken {
  cancelled: boolean
  trinoQueryId?: string
}

function buildTrino(conn: ResolvedConn): Trino {
  const isHttps = conn.url.startsWith('https://')
  return Trino.create({
    server: conn.url,
    source: 'trino-ide',
    catalog: conn.catalog,
    schema: conn.schema,
    auth: conn.password ? new BasicAuth(conn.user, conn.password) : undefined,
    ssl: isHttps && conn.insecure ? { rejectUnauthorized: false } : undefined
  })
}

function toError(e: QueryError): Error {
  const err = new Error(e.message || e.errorName || 'Query failed')
  err.name = e.errorName || 'TrinoQueryError'
  return err
}

/**
 * 단일 쿼리를 실행하고 모든 페이지를 모아 반환한다.
 * trino-client의 query()는 nextUri를 따라가는 async iterator를 돌려준다.
 * 각 페이지(QueryResult)에서 columns/data/stats/error를 누적한다.
 */
export async function runQuery(
  conn: ResolvedConn,
  sql: string,
  token: CancelToken,
  /** 받을 행 상한. null이면 무제한. undefined면 기본값 사용 */
  rowLimit: number | null = DEFAULT_ROW_LIMIT
): Promise<QueryResultPayload> {
  const trino = buildTrino(conn)
  const iter = await trino.query({
    query: sql,
    user: conn.user,
    catalog: conn.catalog,
    schema: conn.schema
  })

  let columns: QueryResultPayload['columns'] = []
  const rows: unknown[][] = []
  let truncated = false
  let lastStats: QueryResult['stats']

  for await (const page of iter as AsyncIterable<QueryResult>) {
    if (page.id) token.trinoQueryId = page.id
    if (token.cancelled) break
    if (page.error) throw toError(page.error)

    if (page.columns && columns.length === 0) {
      columns = page.columns.map((c) => ({ name: c.name, type: c.type }))
    }
    if (page.stats) lastStats = page.stats
    if (page.data) {
      for (const row of page.data as unknown[][]) {
        if (rowLimit != null && rows.length >= rowLimit) {
          truncated = true
          break
        }
        rows.push(row)
      }
      if (truncated) break
    }
  }

  // 취소/상한 도달 시 서버 측 쿼리도 정리(best-effort)
  if ((token.cancelled || truncated) && token.trinoQueryId) {
    try {
      await trino.cancel(token.trinoQueryId)
    } catch {
      /* ignore */
    }
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
    stats: lastStats
      ? {
          state: lastStats.state,
          elapsedMs: lastStats.elapsedTimeMillis,
          processedRows: lastStats.processedRows,
          processedBytes: lastStats.processedBytes
        }
      : undefined,
    // 페이지네이션 메타는 ipc 레이어에서 채운다(기본: 비페이지네이션)
    paginated: false,
    page: 0,
    pageSize: null,
    hasNext: false,
    orderByWarning: false
  }
}

/** SELECT/WITH 단일 문이면 OFFSET/LIMIT 래핑이 가능 */
export function canPaginate(sql: string): boolean {
  const s = sql.trim().replace(/;\s*$/, '')
  if (s.includes(';')) return false // 다중 문은 제외
  return /^(select|with)\b/i.test(s)
}

/** 원본 쿼리를 서브쿼리로 감싸 OFFSET/LIMIT 부여 */
export function wrapPaginated(sql: string, offset: number, limit: number): string {
  const inner = sql.trim().replace(/;\s*$/, '')
  // inner와 OFFSET을 줄바꿈으로 분리해 inner 끝의 줄주석(--)이 삼키지 않게 함
  return `SELECT * FROM (\n${inner}\n) AS _trino_ide_page\nOFFSET ${offset} LIMIT ${limit}`
}

/** 원본 쿼리에 ORDER BY가 보이는지(대략) — 없으면 페이지 순서 경고 */
export function hasOrderBy(sql: string): boolean {
  return /\border\s+by\b/i.test(sql)
}

export async function cancelQuery(conn: ResolvedConn, trinoQueryId: string): Promise<void> {
  try {
    await buildTrino(conn).cancel(trinoQueryId)
  } catch {
    /* ignore */
  }
}
