import type { QueryResultPayload } from '@shared/types'

/** 에디터 탭 1개 = 독립 SQL 문서. 저장 쿼리 바인딩(savedQueryId!=null) 또는 스크래치. */
export interface EditorTab {
  /** 휘발성 탭 id */
  id: string
  /** 바인딩된 저장 쿼리 id. null이면 미저장 스크래치 */
  savedQueryId: string | null
  /** 스크래치 제목 / 바인딩 직전 이름(파생 폴백) */
  title: string
  sql: string
  /** 마지막 영속 내용. dirty = sql !== baseSql */
  baseSql: string
  hostId: string | null
  result: QueryResultPayload | null
  error: string | null
  running: boolean
  requestId: string | null
  lastRun: { sql: string; hostId: string } | null
}

/** taken에 없는 "Untitled query N" 생성 */
export function nextUntitled(taken: string[]): string {
  let n = 1
  while (taken.includes(`Untitled query ${n}`)) n++
  return `Untitled query ${n}`
}

export function makeScratch(seedSql: string, hostId: string | null, title: string): EditorTab {
  return {
    id: crypto.randomUUID(),
    savedQueryId: null,
    title,
    sql: seedSql,
    baseSql: seedSql,
    hostId,
    result: null,
    error: null,
    running: false,
    requestId: null,
    lastRun: null
  }
}

export function makeBound(
  q: { id: string; name: string; sql: string },
  hostId: string | null
): EditorTab {
  return {
    id: crypto.randomUUID(),
    savedQueryId: q.id,
    title: q.name,
    sql: q.sql,
    baseSql: q.sql,
    hostId,
    result: null,
    error: null,
    running: false,
    requestId: null,
    lastRun: null
  }
}

export function isDirty(t: EditorTab): boolean {
  return t.sql !== t.baseSql
}
