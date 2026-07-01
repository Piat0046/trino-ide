import { format } from 'sql-formatter'

// Trino 방언으로 SQL을 정렬한다. 키워드 대소문자는 원본 유지(keywordCase 미지정=preserve).
// 파싱 불가한 입력은 원문을 그대로 돌려줘 편집 내용을 파괴하지 않는다.
export function formatSql(sql: string): string {
  try {
    return format(sql, { language: 'trino', tabWidth: 2 })
  } catch {
    return sql
  }
}
