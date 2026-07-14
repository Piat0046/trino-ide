// 테이블 프리뷰 SELECT 조립 + 필터 조건 → 안전한 SQL 변환(순수 함수, #54).
// 식별자는 quoteIdent, 값은 타입별 인용/이스케이프로 인젝션을 차단한다. 서버 실행은 preview:start.

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

interface PreviewTargetTab {
  hostId: string | null
  preview: PreviewRef | null
}

/**
 * 탭 교체 setState 직후 panesRef가 예전 탭을 가리키는 경우 방금 만든 Preview를 선택한다.
 * 확인 다이얼로그처럼 시간이 지난 실행은 실제 mount된 동일 대상만 허용한다.
 */
export function resolvePreviewStartTarget<
  TMounted extends PreviewTargetTab,
  TIntended extends PreviewTargetTab
>(
  mounted: TMounted | undefined,
  intended: TIntended,
  requireMounted: boolean
): TMounted | TIntended | undefined {
  const actual = mounted?.preview
  const expected = intended.preview
  const matches =
    !!actual &&
    !!expected &&
    mounted?.hostId === intended.hostId &&
    actual.catalog === expected.catalog &&
    actual.schema === expected.schema &&
    actual.table === expected.table
  return matches ? mounted : requireMounted ? undefined : intended
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

/** 화면에 한 번에 표시할 로컬 페이지 크기. Trino SQL/transport chunk와 무관하다. */
// 1행은 8 MiB까지 저장할 수 있으므로, 16 MiB IPC 페이지를 넘는 큰 행도 반드시 열람할 수 있게 한다.
export const PAGE_SIZE_PRESETS = [1, 100, 500, 1000, 5000, 10000]
export const DEFAULT_PAGE_SIZE = 500
/** 테이블 Preview 쿼리 1회의 전체 안전 한도. 무제한 Preview는 제공하지 않는다. */
export const MAX_ROWS_PRESETS = [1000, 10000, 50000]
export const DEFAULT_MAX_ROWS = 10000

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
 * Preview 스트림을 시작할 단일 SQL을 만든다.
 *
 * SELECT * FROM "cat"."sch"."tbl" [WHERE …(AND)] [ORDER BY "col" dir] LIMIT n
 *
 * 페이지는 이 한 쿼리의 nextUri 스트림을 로컬 저장소에서 나눠 표시한다. 따라서 페이지 경계를
 * 맞추기 위한 OFFSET이나 기본 ORDER BY를 만들지 않는다. 헤더 정렬을 명시했을 때만 새 서버
 * 스트림에 ORDER BY를 포함한다.
 */
export function buildPreviewSql(
  ref: PreviewRef,
  filters: PreviewFilter[],
  maxRows: number,
  orderBy: OrderBy | null = null
): string {
  const table =
    quoteIdent(ref.catalog) + '.' + quoteIdent(ref.schema) + '.' + quoteIdent(ref.table)
  const preds = filters
    .filter((f) => f.enabled !== false) // 체크 해제 행은 제외
    .map(buildPredicate)
    .filter((p): p is string => p !== null)
  const where = preds.length ? ' WHERE ' + preds.join(' AND ') : ''

  const orderClause = orderBy
    ? ` ORDER BY ${quoteIdent(orderBy.column)}${orderBy.dir === 'desc' ? ' DESC' : ' ASC'}`
    : ''
  const n = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : DEFAULT_MAX_ROWS
  return `SELECT * FROM ${table}${where}${orderClause} LIMIT ${n}`
}
