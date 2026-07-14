import type { QueryErrorInfo, QueryResultPayload, QueryStatsSummary } from '@shared/types'
import {
  buildPreviewSql,
  DEFAULT_MAX_ROWS,
  DEFAULT_PAGE_SIZE,
  type OrderBy,
  type PreviewFilter
} from './previewQuery'

/** 테이블 프리뷰 탭 상태(#54). tab.sql=마지막으로 시작한 단일 스트림 SQL. */
export interface PreviewSpec {
  catalog: string
  schema: string
  table: string
  filters: PreviewFilter[]
  /** 로컬 표시 단위. 변경해도 서버를 다시 조회하지 않는다. */
  pageSize: number
  /** Preview 쿼리 1회의 총 행 안전 한도. */
  maxRows: number
  /** 마지막 조회 시 실제 적용된(enabled+유효) 필터 스냅샷 — 행별 적용됨/대기 판정용 */
  appliedFilters?: PreviewFilter[]
  /** 현재 로컬 페이지(0-base). 필터/정렬/전체 한도 적용 시 0 리셋. */
  page: number
  /** 사용자가 명시한 서버 정렬. null이면 ORDER BY를 보내지 않는다. */
  orderBy: OrderBy | null
  /** Main process에서 소유하는 현재 Preview 세션. null은 미실행. */
  sessionId: string | null
}

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
  /** null이 아니면 테이블 프리뷰 탭(에디터 대신 필터 바). SQL 편집기 탭은 null. */
  preview: PreviewSpec | null
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
    progress: null,
    preview: null
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
    progress: null,
    preview: null
  }
}

/** 테이블 프리뷰 탭. sql=초기 컴파일된 SELECT(세션 복원 시 SQL 스크래치로 degrade). */
export function makePreview(
  ref: { catalog: string; schema: string; table: string },
  hostId: string | null
): EditorTab {
  const preview: PreviewSpec = {
    ...ref,
    filters: [],
    pageSize: DEFAULT_PAGE_SIZE,
    maxRows: DEFAULT_MAX_ROWS,
    page: 0,
    orderBy: null,
    sessionId: null
  }
  const sql = buildPreviewSql(ref, preview.filters, preview.maxRows, preview.orderBy)
  return {
    id: crypto.randomUUID(),
    savedQueryId: null,
    title: ref.table,
    sql,
    baseSql: sql,
    hostId,
    result: null,
    error: null,
    errorInfo: null,
    running: false,
    requestId: null,
    progress: null,
    preview
  }
}

export function isDirty(t: EditorTab): boolean {
  // 프리뷰 탭은 편집 문서가 아니라 dirty 개념 없음(닫기 확인 안 뜸)
  if (t.preview) return false
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
