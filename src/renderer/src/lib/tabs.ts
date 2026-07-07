import type { QueryErrorInfo, QueryResultPayload, QueryStatsSummary } from '@shared/types'

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
  /** 구조화 에러(있을 때) */
  errorInfo: QueryErrorInfo | null
  running: boolean
  requestId: string | null
  /** 실행 중 라이브 진행 stats(스트리밍) */
  progress: QueryStatsSummary | null
}

/** 워크스페이스 분할 단위. 각 pane = 독립 탭 그룹(자체 활성 탭). 분할 시 panes.length===2. */
export interface Pane {
  id: string
  tabs: EditorTab[]
  activeTabId: string | null
}

export function makePane(tabs: EditorTab[]): Pane {
  return { id: crypto.randomUUID(), tabs, activeTabId: tabs[0]?.id ?? null }
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
    errorInfo: null,
    running: false,
    requestId: null,
    progress: null
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
    errorInfo: null,
    running: false,
    requestId: null,
    progress: null
  }
}

export function isDirty(t: EditorTab): boolean {
  return t.sql !== t.baseSql
}

/**
 * 미작업(일회용) 탭: 연 뒤 편집·실행이 전혀 없는 탭.
 * 새 콘텐츠를 열 때 이 탭을 교체(누적 방지) 대상으로 삼는다 — non-dirty라 무손실.
 * `!running`이 실행 창(requestId/progress 세팅~해제)을 완전히 덮으므로 그 둘은 따로 안 본다.
 */
export function isDisposable(t: EditorTab): boolean {
  return !isDirty(t) && t.result === null && t.error === null && !t.running
}
