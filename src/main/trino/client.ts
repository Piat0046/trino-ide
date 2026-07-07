import { Trino, BasicAuth, type QueryError, type QueryResult } from 'trino-client'
import type { QueryResultPayload, QueryStatsSummary, StageSummary } from '@shared/types'

/** trino-client의 rootStage(재귀 트리)를 평면 요약 행으로 펼친다 */
type RawStage = NonNullable<NonNullable<QueryResult['stats']>['rootStage']>
function flattenStages(stage: RawStage | undefined, depth = 0, out: StageSummary[] = []): StageSummary[] {
  if (!stage) return out
  out.push({
    stageId: stage.stageId,
    state: stage.state,
    depth,
    coordinatorOnly: stage.coordinatorOnly,
    processedRows: stage.processedRows,
    processedBytes: stage.processedBytes,
    physicalInputBytes: stage.physicalInputBytes,
    cpuTimeMillis: stage.cpuTimeMillis,
    completedSplits: stage.completedSplits,
    runningSplits: stage.runningSplits,
    queuedSplits: stage.queuedSplits,
    totalSplits: stage.totalSplits,
    failedTasks: stage.failedTasks
  })
  for (const sub of stage.subStages ?? []) flattenStages(sub, depth + 1, out)
  return out
}

/** 모든 쿼리의 메모리 보호 안전 상한(행). 초과분은 받지 않고 서버 쿼리를 취소한다. */
export const SAFETY_CAP = 50_000

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

/** 구조화 정보를 보존하는 Trino 쿼리 에러. ipc 레이어가 errorInfo로 변환한다. */
export class TrinoQueryError extends Error {
  errorName?: string
  errorType?: string
  errorCode?: number
  line?: number
  column?: number
  constructor(e: QueryError) {
    super(e.message || e.errorName || 'Query failed')
    this.name = e.errorName || 'TrinoQueryError'
    this.errorName = e.errorName
    this.errorType = e.errorType
    this.errorCode = e.errorCode
    // errorLocation은 Trino 프로토콜의 런타임 필드(트리노-client 타입엔 없음)
    const loc = (e as { errorLocation?: { lineNumber?: number; columnNumber?: number } }).errorLocation
    this.line = loc?.lineNumber
    this.column = loc?.columnNumber
  }
}

function mapStats(s: QueryResult['stats']): QueryStatsSummary | undefined {
  return s
    ? {
        state: s.state,
        elapsedMs: s.elapsedTimeMillis,
        processedRows: s.processedRows,
        processedBytes: s.processedBytes,
        cpuTimeMillis: s.cpuTimeMillis,
        wallTimeMillis: s.wallTimeMillis,
        queuedTimeMillis: s.queuedTimeMillis,
        physicalInputBytes: s.physicalInputBytes,
        peakMemoryBytes: s.peakMemoryBytes,
        spilledBytes: s.spilledBytes,
        completedSplits: s.completedSplits,
        runningSplits: s.runningSplits,
        queuedSplits: s.queuedSplits,
        totalSplits: s.totalSplits,
        nodes: s.nodes
      }
    : undefined
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
  /** 받을 행 상한(메모리 보호). 도달 시 서버 쿼리를 취소하고 truncated 표시. */
  rowLimit: number = SAFETY_CAP,
  /** 페이지마다 진행 stats를 흘려보낸다(라이브 피드백용) */
  onProgress?: (stats: QueryStatsSummary) => void
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
  let warnings: string[] = []
  let infoUri: string | undefined

  for await (const page of iter as AsyncIterable<QueryResult>) {
    if (page.id) token.trinoQueryId = page.id
    if (page.infoUri && !infoUri) infoUri = page.infoUri
    if (page.warnings && page.warnings.length) warnings = page.warnings // 누적본(최신 페이지)
    if (token.cancelled) break
    if (page.error) throw new TrinoQueryError(page.error)

    if (page.columns && columns.length === 0) {
      columns = page.columns.map((c) => ({ name: c.name, type: c.type }))
    }
    if (page.stats) {
      lastStats = page.stats
      if (onProgress) {
        const mapped = mapStats(page.stats)
        if (mapped) onProgress(mapped)
      }
    }
    if (page.data) {
      for (const row of page.data as unknown[][]) {
        if (rows.length >= rowLimit) {
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

  const finalStats = mapStats(lastStats)
  if (finalStats && lastStats?.rootStage) finalStats.stages = flattenStages(lastStats.rootStage)

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
    stats: finalStats,
    executedSql: sql,
    warnings: warnings.length ? warnings : undefined,
    infoUri,
    queryId: token.trinoQueryId
  }
}

export async function cancelQuery(conn: ResolvedConn, trinoQueryId: string): Promise<void> {
  try {
    await buildTrino(conn).cancel(trinoQueryId)
  } catch {
    /* ignore */
  }
}
