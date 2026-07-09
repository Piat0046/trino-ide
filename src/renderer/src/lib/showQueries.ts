// 메타데이터 조회용 SHOW 쿼리 조립 + 결과 파싱(순수 함수). 서버 실행은 호출부가 query:run으로.
// 식별자는 큰따옴표 인용(" → "" 이스케이프)해 예약어·특수문자·인젝션에 안전하게.

import type { QueryResultPayload } from '@shared/types'

/** Trino 식별자 인용: "cat" 형태로 감싸고 내부 "는 ""로 이스케이프. */
export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"'
}

export function showCatalogsSql(): string {
  return 'SHOW CATALOGS'
}
export function showSchemasSql(catalog: string): string {
  return `SHOW SCHEMAS FROM ${quoteIdent(catalog)}`
}
export function showTablesSql(catalog: string, schema: string): string {
  return `SHOW TABLES FROM ${quoteIdent(catalog)}.${quoteIdent(schema)}`
}

/** SHOW 결과(단일 컬럼)에서 이름 목록을 뽑는다. 빈/비문자열 값은 건너뛴다. */
export function parseNames(payload: QueryResultPayload): string[] {
  const out: string[] = []
  for (const row of payload.rows) {
    const v = row[0]
    if (v == null) continue
    const s = String(v)
    if (s !== '') out.push(s)
  }
  return out
}
