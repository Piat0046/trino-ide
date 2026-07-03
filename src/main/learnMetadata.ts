import type { MetadataRef, QueryColumn } from '@shared/types'
import { extractTableRefs, singleTableStarRef, toMetadataRef } from './sql/extractTableRefs'
import { learnColumns, learnReferences } from './store/metadata'

/**
 * 성공한 쿼리 SQL에서 catalog/schema/table을 학습한다(best-effort).
 * 파싱/저장 중 어떤 예외도 삼켜 쿼리 실행·history 기록·응답에 영향을 주지 않는다.
 * 미수식 참조는 host 기본 catalog/schema로 보정하며, 보정 불가하면 스킵된다.
 */
export function learnMetadataFromSql(
  hostId: string,
  sql: string,
  defCatalog?: string,
  defSchema?: string
): void {
  try {
    const refs: MetadataRef[] = []
    for (const parts of extractTableRefs(sql)) {
      const ref = toMetadataRef(parts, defCatalog, defSchema)
      if (ref) refs.push(ref)
    }
    learnReferences(hostId, refs)
  } catch {
    // 학습 실패는 조용히 무시한다.
  }
}

/**
 * 단일 테이블 `SELECT *` 쿼리의 결과 컬럼을 그 테이블에 귀속해 학습한다(best-effort).
 * 그 외 형태(컬럼 나열·조인·집계 등)는 오귀속 위험이 있어 학습하지 않는다.
 */
export function learnColumnsFromResult(
  hostId: string,
  sql: string,
  columns: QueryColumn[],
  defCatalog?: string,
  defSchema?: string
): void {
  try {
    if (!columns || columns.length === 0) return
    const parts = singleTableStarRef(sql)
    if (!parts) return
    const ref = toMetadataRef(parts, defCatalog, defSchema)
    if (!ref) return
    learnColumns(hostId, ref, columns.map((c) => ({ name: c.name, type: c.type })))
  } catch {
    // 학습 실패는 조용히 무시한다.
  }
}
