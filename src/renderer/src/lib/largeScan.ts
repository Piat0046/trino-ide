// 무제한 모드에서 SELECT * · WHERE 없는 대용량 조회를 실행 전에 감지(순수 텍스트, 서버 접근 0).
// 핵심 근거: rowLimit이 숫자면 main/ipc가 wrapPaginated로 자동 상한을 걸어주므로(canPaginate 통과 시)
// 안전하다 — 진짜 "상한 없는 전체 스캔" 위험은 무제한 토글(rowLimit === null)에서만 실재한다.
// 스캐너 골격(문자열/주석/괄호깊이 인식, depth 0에서 키워드 검사)은 main/trino/client.ts의
// hasOwnLimitOffset과 동일하다. main↔renderer는 별도 번들이라 직접 import가 불가해 규칙을 이식한다.

/** 선행 공백·주석을 건너뛴 나머지. */
function stripLeadingComments(s: string): string {
  let i = 0
  const n = s.length
  for (;;) {
    while (i < n && /\s/.test(s[i])) i++
    if (s[i] === '-' && s[i + 1] === '-') {
      i += 2
      while (i < n && s[i] !== '\n') i++
      continue
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      i += 2
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    break
  }
  return s.slice(i)
}

/** 문장 헤드가 SELECT/WITH인지(= 스캔형 쿼리). canPaginate의 헤드 판정과 동일 규칙. */
export function isSelectLike(sql: string): boolean {
  const head = stripLeadingComments(sql).replace(/^\(+\s*/, '')
  return /^(select|with)\b/i.test(head)
}

interface ScanFlags {
  hasTopFrom: boolean
  hasTopWhere: boolean
  /** 최상위 LIMIT/OFFSET/FETCH (사용자가 이미 상한을 건 경우) */
  hasOwnLimit: boolean
  /** 최상위 SELECT * / t.* (COUNT(*) 등 괄호 안 * 는 제외) */
  hasTopSelectStar: boolean
}

/** 문자열/주석/괄호깊이를 인식하는 단일 패스. depth 0의 키워드와 SELECT * 만 본다. */
function scan(sql: string): ScanFlags {
  const f: ScanFlags = {
    hasTopFrom: false,
    hasTopWhere: false,
    hasOwnLimit: false,
    hasTopSelectStar: false
  }
  let depth = 0
  let prevSig = '' // 최근 유의미 토큰(소문자 단어 또는 단일 문자)
  const n = sql.length
  for (let i = 0; i < n; ) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const q = ch
      i++
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2 // '' / "" 이스케이프
            continue
          }
          i++
          break
        }
        i++
      }
      prevSig = 'str'
      continue
    }
    if (ch === '(') {
      depth++
      prevSig = '('
      i++
      continue
    }
    if (ch === ')') {
      if (depth > 0) depth--
      prevSig = ')'
      i++
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++
      const w = sql.slice(i, j).toLowerCase()
      if (depth === 0) {
        if (w === 'from') f.hasTopFrom = true
        else if (w === 'where') f.hasTopWhere = true
        else if (w === 'limit' || w === 'offset' || w === 'fetch') f.hasOwnLimit = true
      }
      prevSig = w
      i = j
      continue
    }
    if (ch === '*') {
      // SELECT * / SELECT DISTINCT|ALL * / t.* 만 스타로 본다.
      // 앞 토큰이 select·distinct·all(집합 한정자) 키워드거나 '.'(한정 스타)일 때.
      if (
        depth === 0 &&
        (prevSig === 'select' || prevSig === 'distinct' || prevSig === 'all' || prevSig === '.')
      )
        f.hasTopSelectStar = true
      prevSig = '*'
      i++
      continue
    }
    if (!/\s/.test(ch)) prevSig = ch // '.' ',' 등 유의미 문자
    i++
  }
  return f
}

/** 힌트 종류. null이면 위험 없음(힌트 미표시). */
export type LargeScanRisk = 'starNoWhere' | 'noWhere' | 'star' | null

/**
 * 무제한 모드에서 대용량 스캔 위험을 판정. 순수 텍스트 분석 — 추가 쿼리/스키마 조회 없음.
 * 게이트(AND): 무제한 모드 · SELECT/WITH · 최상위 FROM 존재 · 자체 LIMIT 없음.
 * 신호(OR): 최상위 SELECT * · 최상위 WHERE 없음.
 */
export function largeScanRisk(sql: string, rowLimit: number | null): LargeScanRisk {
  if (rowLimit !== null) return null // G1: 숫자 rowLimit은 ipc가 자동 캡 → 경고 피로 방지
  if (!sql.trim()) return null
  if (!isSelectLike(sql)) return null // G2
  const f = scan(sql)
  if (!f.hasTopFrom) return null // G3: FROM 없는 SELECT 1 등은 스캔 개념 없음
  if (f.hasOwnLimit) return null // G4: 사용자가 이미 LIMIT/OFFSET/FETCH 지정
  const star = f.hasTopSelectStar
  const noWhere = !f.hasTopWhere
  if (star && noWhere) return 'starNoWhere'
  if (noWhere) return 'noWhere'
  if (star) return 'star'
  return null
}
