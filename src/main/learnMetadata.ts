import type { MetadataRef } from '@shared/types'
import { extractTableRefs, toMetadataRef } from './sql/extractTableRefs'
import { learnReferences } from './store/metadata'

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
