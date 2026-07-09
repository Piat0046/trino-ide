// 테이블 프리뷰 SELECT 조립 + 필터 조건 → 안전한 SQL 변환(순수 함수, #54).
// 식별자는 quoteIdent, 값은 타입별 인용/이스케이프로 인젝션을 차단한다. 서버 실행은 호출부가 query:run.

import { quoteIdent } from './showQueries'

export type FilterOp = 'eq' | 'ne' | 'contains' | 'ncontains' | 'starts' | 'ends' | 'gt' | 'lt'

export interface PreviewFilter {
  /** 안정 렌더 key(prepend 시 값/포커스 어긋남 방지). SQL엔 무관 */
  id?: string
  column: string
  op: FilterOp
  value: string
  /** 컬럼 타입(값 인용/CAST 판정용). 없으면 문자열로 취급 */
  colType?: string
  /** 체크박스 off면 WHERE에서 제외(행·값은 보존). undefined=사용(true) */
  enabled?: boolean
}

export interface PreviewRef {
  catalog: string
  schema: string
  table: string
}

/** UI 드롭다운용 조건 라벨 — 비교는 부등호, LIKE 계열은 영어 */
export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: 'eq', label: '=' },
  { op: 'ne', label: '≠' },
  { op: 'gt', label: '>' },
  { op: 'lt', label: '<' },
  { op: 'contains', label: 'contains' },
  { op: 'ncontains', label: 'not contains' },
  { op: 'starts', label: 'starts with' },
  { op: 'ends', label: 'ends with' }
]

export const LIMIT_PRESETS = [100, 500, 1000, 5000, 10000]
export const DEFAULT_LIMIT = 500
/** OFFSET 절대행 상한 — 초과 페이지는 재스캔 부하가 커 "다음"을 막는다(WHERE로 좁히도록 유도) */
export const PREVIEW_OFFSET_CAP = 10000

export interface OrderBy {
  column: string
  dir: 'asc' | 'desc'
}
/** ORDER BY 가능한 스칼라 타입만(ROW/MAP/ARRAY/JSON 등은 Trino ORDER BY 에러) */
export function isOrderable(colType: string): boolean {
  const t = (colType ?? '').toLowerCase()
  return NUMERIC_RE.test(t) || STRING_RE.test(t) || /^(date|timestamp|time|boolean)/.test(t)
}

const NUMERIC_RE = /^(tinyint|smallint|integer|int|bigint|real|double|decimal|numeric|float)/i
const STRING_RE = /^(varchar|char)/i
const isNumericType = (t: string): boolean => NUMERIC_RE.test(t)
const isNumberLiteral = (v: string): boolean => /^-?\d+(\.\d+)?$/.test(v)

/** 문자열 리터럴: '…' 로 감싸고 내부 '는 ''로 이스케이프 */
const quoteText = (v: string): string => "'" + v.replace(/'/g, "''") + "'"

/** 비교 값 리터럴: 숫자 컬럼+숫자값=raw, date/timestamp=타입 리터럴, 그 외=문자열 */
function compareLiteral(f: PreviewFilter): string {
  const t = (f.colType ?? '').toLowerCase()
  const v = f.value.trim()
  if (isNumericType(t) && isNumberLiteral(v)) return v
  if (t.startsWith('date')) return `DATE ${quoteText(v)}`
  if (t.startsWith('timestamp')) return `TIMESTAMP ${quoteText(v)}`
  return quoteText(v)
}

/** LIKE 값: %, _, \ 를 이스케이프(리터럴 매칭) */
const escLike = (v: string): string => v.replace(/[\\%_]/g, (c) => '\\' + c)

/** LIKE 대상 컬럼식(비문자 컬럼은 varchar로 CAST) */
function likeColExpr(f: PreviewFilter): string {
  const col = quoteIdent(f.column)
  return STRING_RE.test((f.colType ?? '').toLowerCase()) ? col : `CAST(${col} AS varchar)`
}

/** 필터 1개 → SQL 술어. value가 비었으면 null(호출부가 제외) */
export function buildPredicate(f: PreviewFilter): string | null {
  if (!f.column || f.value.trim() === '') return null
  const col = quoteIdent(f.column)
  switch (f.op) {
    case 'eq':
      return `${col} = ${compareLiteral(f)}`
    case 'ne':
      return `${col} <> ${compareLiteral(f)}`
    case 'gt':
      return `${col} > ${compareLiteral(f)}`
    case 'lt':
      return `${col} < ${compareLiteral(f)}`
    case 'contains':
      return `${likeColExpr(f)} LIKE ${quoteText('%' + escLike(f.value) + '%')} ESCAPE '\\'`
    case 'ncontains':
      return `${likeColExpr(f)} NOT LIKE ${quoteText('%' + escLike(f.value) + '%')} ESCAPE '\\'`
    case 'starts':
      return `${likeColExpr(f)} LIKE ${quoteText(escLike(f.value) + '%')} ESCAPE '\\'`
    case 'ends':
      return `${likeColExpr(f)} LIKE ${quoteText('%' + escLike(f.value))} ESCAPE '\\'`
    default:
      return null
  }
}

/**
 * SELECT * FROM "cat"."sch"."tbl" [WHERE …(AND)] ORDER BY … LIMIT n [OFFSET m]
 * - orderBy 지정: `"col" dir` + 나머지 정렬가능 컬럼 asc tiebreaker(총순서 → OFFSET 페이지 경계 정확).
 * - orderBy null(기본): 정렬가능 컬럼을 ordinal로 총순서(`ORDER BY 1, 2, …`) — columns를 알면 tiebreaker
 *   포함해 경계 정확. columns 미상(첫 조회)이면 `ORDER BY 1`(첫 컬럼)로 폴백(그 첫 렌더 이후 페이지 이동은
 *   result.columns가 있어 총순서가 적용됨).
 * page>0이면 OFFSET page*n.
 */
export function buildPreviewSql(
  ref: PreviewRef,
  filters: PreviewFilter[],
  limit: number,
  page = 0,
  orderBy: OrderBy | null = null,
  columns: { name: string; type: string }[] = []
): string {
  const table =
    quoteIdent(ref.catalog) + '.' + quoteIdent(ref.schema) + '.' + quoteIdent(ref.table)
  const preds = filters
    .filter((f) => f.enabled !== false) // 체크 해제 행은 제외
    .map(buildPredicate)
    .filter((p): p is string => p !== null)
  const where = preds.length ? ' WHERE ' + preds.join(' AND ') : ''

  let orderClause: string
  if (orderBy) {
    const parts = [quoteIdent(orderBy.column) + (orderBy.dir === 'desc' ? ' DESC' : ' ASC')]
    for (const c of columns) {
      if (c.name !== orderBy.column && isOrderable(c.type)) parts.push(quoteIdent(c.name) + ' ASC')
    }
    orderClause = ' ORDER BY ' + parts.join(', ')
  } else {
    // 기본: 정렬가능 컬럼 ordinal 총순서. 컬럼 미상(첫 조회)이면 ORDER BY 1
    const ords = columns.map((c, i) => (isOrderable(c.type) ? i + 1 : 0)).filter((o) => o > 0)
    orderClause = ords.length ? ' ORDER BY ' + ords.join(', ') : ' ORDER BY 1'
  }

  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT
  const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0
  const offset = p > 0 ? ` OFFSET ${p * n}` : ''
  return `SELECT * FROM ${table}${where}${orderClause} LIMIT ${n}${offset}`
}
