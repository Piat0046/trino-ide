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

/** UI 드롭다운용 조건 라벨(사용자 표기 유지) */
export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: 'eq', label: '동일' },
  { op: 'ne', label: '미동일' },
  { op: 'contains', label: '포함' },
  { op: 'ncontains', label: '미포함' },
  { op: 'starts', label: '앞에서부터 포함' },
  { op: 'ends', label: '뒤에서부터 포함' },
  { op: 'gt', label: '크다' },
  { op: 'lt', label: '작다' }
]

export const LIMIT_PRESETS = [100, 500, 1000, 5000, 10000]
export const DEFAULT_LIMIT = 500

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

/** SELECT * FROM "cat"."sch"."tbl" [WHERE …(AND)] LIMIT n */
export function buildPreviewSql(ref: PreviewRef, filters: PreviewFilter[], limit: number): string {
  const table =
    quoteIdent(ref.catalog) + '.' + quoteIdent(ref.schema) + '.' + quoteIdent(ref.table)
  const preds = filters
    .filter((f) => f.enabled !== false) // 체크 해제 행은 제외
    .map(buildPredicate)
    .filter((p): p is string => p !== null)
  const where = preds.length ? ' WHERE ' + preds.join(' AND ') : ''
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT
  return `SELECT * FROM ${table}${where} LIMIT ${n}`
}
