// 결과 셀 값·타입 렌더링 공용 유틸(그리드 ResultsPane와 인스펙터 InspectorPanel이 공유).
// 순수 함수 — 서버 왕복 0. 기존 ResultsPane의 typeClass/formatCell을 여기로 이관해 단일 출처화.

import type { QueryColumn } from '@shared/types'

export type TypeClass = 't-num' | 't-str' | 't-time' | 't-bool'

/** Trino 타입 문자열 → 타입색 클래스(그리드·인스펙터 공통 어휘). */
export function typeClass(type: string): TypeClass {
  const t = type.toLowerCase()
  if (/(int|bigint|smallint|tinyint|double|real|decimal|numeric|float)/.test(t)) return 't-num'
  if (/(timestamp|date|time|interval)/.test(t)) return 't-time'
  if (/bool/.test(t)) return 't-bool'
  return 't-str'
}

/** 그리드 표시용(NULL은 빈 문자열 — 셀은 별도 .null 스팬으로 렌더). */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function isNullish(v: unknown): boolean {
  return v === null || v === undefined
}

/**
 * 인스펙터 값 박스용 표시 문자열. 객체(ROW/ARRAY/MAP/JSON)는 pretty-print(들여쓰기),
 * 실패 시 한 줄 JSON. NULL은 호출부가 별도 표시하므로 여기선 빈 문자열.
 */
export function prettyValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

export interface ValueViews {
  /** 들여쓰기된 JSON. null이면 pretty 불가(정렬 대상 아님) */
  pretty: string | null
  /** 원문 표시(객체는 한 줄 JSON, 문자열은 원본) */
  raw: string
  /** JSON 형태로 보이는지({/[ 시작 또는 객체) — 깨진 JSON 안내 노출 판정 */
  looksJson: boolean
}

/**
 * 인스펙터 값의 pretty/raw 뷰를 한 번에 판정한다.
 * - 객체(ROW/MAP/ARRAY/JSON 타입이 파싱돼 온 값): pretty=들여쓰기, raw=한 줄.
 * - varchar에 담긴 JSON 문자열: 파싱되면 pretty=들여쓰기, raw=원문.
 * - JSON 형태지만 깨진 문자열: pretty=null, looksJson=true (버튼은 뜨되 클릭 시 안내).
 * - 그 외(일반 문자열/숫자): pretty=null, looksJson=false (버튼 없음).
 */
export function valueViews(v: unknown): ValueViews {
  if (v === null || v === undefined) return { pretty: null, raw: '', looksJson: false }
  if (typeof v === 'object') {
    let pretty: string | null
    let raw: string
    try {
      pretty = JSON.stringify(v, null, 2)
    } catch {
      pretty = null
    }
    try {
      raw = JSON.stringify(v)
    } catch {
      raw = String(v)
    }
    return { pretty, raw, looksJson: true }
  }
  if (typeof v === 'string') {
    const t = v.trim()
    const looksJson = t.startsWith('{') || t.startsWith('[')
    if (looksJson) {
      try {
        const parsed = JSON.parse(v)
        if (parsed !== null && typeof parsed === 'object') {
          return { pretty: JSON.stringify(parsed, null, 2), raw: v, looksJson: true }
        }
      } catch {
        /* 깨진 JSON — 아래로 폴백 */
      }
    }
    return { pretty: null, raw: v, looksJson }
  }
  return { pretty: null, raw: String(v), looksJson: false }
}

// ----- 레코드 스냅샷(선택 행 → 인스펙터로 emit-up하는 파생 값) -----

export interface RecordField {
  name: string
  type: string
  value: unknown
}
export interface RecordSnapshot {
  fields: RecordField[]
  /** displayRows 기준 0-based 위치 */
  rowIndex: number
  /** 수신한 행 수(displayRows.length) */
  rowCount: number
  /** 클릭한 컬럼의 fields 인덱스(=원본 컬럼 origIndex). 없으면 -1 */
  hitField: number
}

/** 선택 셀 → 그 행의 전체 필드(원본 컬럼 순서) 스냅샷. columns/rowValues는 이미 메모리에 있는 값. */
export function buildRecordSnapshot(
  columns: QueryColumn[],
  rowValues: unknown[],
  hitOrigIndex: number,
  rowIndex: number,
  rowCount: number
): RecordSnapshot {
  const fields: RecordField[] = columns.map((c, i) => ({
    name: c.name,
    type: c.type,
    value: rowValues[i]
  }))
  const hitField = hitOrigIndex >= 0 && hitOrigIndex < fields.length ? hitOrigIndex : -1
  return { fields, rowIndex, rowCount, hitField }
}
