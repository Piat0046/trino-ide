import { Trino, BasicAuth, type QueryError, type QueryResult } from 'trino-client'
import type { QueryResultPayload } from '@shared/types'

/** 결과 행을 메모리에 모으는 상한. 초과 시 서버 쿼리를 취소하고 truncated 처리. */
const MAX_ROWS = 50_000

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
  token: CancelToken
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
        if (rows.length >= MAX_ROWS) {
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
      : undefined
  }
}

export async function cancelQuery(conn: ResolvedConn, trinoQueryId: string): Promise<void> {
  try {
    await buildTrino(conn).cancel(trinoQueryId)
  } catch {
    /* ignore */
  }
}
