import type { MetadataRef } from '@shared/types'

/**
 * SQL의 FROM/JOIN에서 테이블 참조의 식별자 세그먼트를 추출한다(catalog-우선, 1~3개).
 * Trino에 별도 호출 없이 성공 쿼리 텍스트만으로 메타데이터를 학습하기 위한 경량 파서.
 * 완전한 SQL 파서가 아니라 문자열/식별자/주석을 인식하는 토크나이저 기반이며, 실패해도 예외를 던지지 않는다.
 *
 * 오염 방지(제외): 서브쿼리 `FROM (…)`, 테이블 함수(UNNEST/TABLE/LATERAL/VALUES),
 * CTE(WITH) 별칭, 테이블 별칭(참조가 아니라 alias), `information_schema` 스키마·`system` 카탈로그.
 */

interface Tok {
  t: 'word' | 'op' | 'str' | 'num'
  v: string
  /** 따옴표 식별자 여부(예약어로 오인 방지) */
  q?: boolean
}

const WORD_START = /[A-Za-z_]/
const WORD_CHAR = /[A-Za-z0-9_]/
const SPACE = /[ \t\r\n\f\v]/

/** FROM 절 아이템 목록의 끝을 알리는 경계 키워드(그 뒤는 테이블 참조가 아님). */
const FROM_BOUNDARY = new Set([
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'ON', 'USING',
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH',
  'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'QUALIFY'
])

/** 테이블 참조 위치에 오지만 실제 테이블이 아닌 함수형 소스. */
const TABLE_FUNCS = new Set(['UNNEST', 'TABLE', 'LATERAL', 'VALUES'])

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (SPACE.test(c)) {
      i++
      continue
    }
    // 라인 주석 --
    if (c === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    // 블록 주석 /* */
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 문자열 리터럴 '...'( '' 이스케이프)
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      toks.push({ t: 'str', v: '' })
      continue
    }
    // 따옴표 식별자 "..."( "" 이스케이프, 케이스 보존)
    if (c === '"') {
      i++
      let v = ''
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            v += '"'
            i += 2
            continue
          }
          i++
          break
        }
        v += sql[i]
        i++
      }
      toks.push({ t: 'word', v, q: true })
      continue
    }
    // 식별자/키워드
    if (WORD_START.test(c)) {
      let j = i + 1
      while (j < n && WORD_CHAR.test(sql[j])) j++
      toks.push({ t: 'word', v: sql.slice(i, j) })
      i = j
      continue
    }
    // 숫자
    if (c >= '0' && c <= '9') {
      let j = i + 1
      while (j < n && (WORD_CHAR.test(sql[j]) || sql[j] === '.')) j++
      toks.push({ t: 'num', v: sql.slice(i, j) })
      i = j
      continue
    }
    // 그 외 단일 문자(연산자/구두점)
    toks.push({ t: 'op', v: c })
    i++
  }
  return toks
}

function isWord(tok: Tok | undefined, kw: string): boolean {
  return !!tok && tok.t === 'word' && !tok.q && tok.v.toUpperCase() === kw
}
function isOp(tok: Tok | undefined, ch: string): boolean {
  return !!tok && tok.t === 'op' && tok.v === ch
}

/** `name AS (` 형태의 CTE 별칭 이름을 수집(소문자). */
function collectCte(toks: Tok[]): Set<string> {
  const names = new Set<string>()
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i].t === 'word' && !toks[i].q && isWord(toks[i + 1], 'AS') && isOp(toks[i + 2], '(')) {
      names.add(toks[i].v.toLowerCase())
    }
  }
  return names
}

/** pos에서 시작하는 하나의 테이블 참조를 읽는다. 서브쿼리/테이블함수면 parts=null. */
function readItem(toks: Tok[], pos: number): { parts: string[] | null; next: number } {
  if (pos >= toks.length) return { parts: null, next: pos }
  const t = toks[pos]
  if (isOp(t, '(')) return { parts: null, next: pos } // 서브쿼리
  if (t.t === 'word' && !t.q && TABLE_FUNCS.has(t.v.toUpperCase())) return { parts: null, next: pos + 1 }
  if (t.t !== 'word') return { parts: null, next: pos + 1 }
  const parts = [t.v]
  let j = pos + 1
  while (j + 1 < toks.length && isOp(toks[j], '.') && toks[j + 1].t === 'word') {
    parts.push(toks[j + 1].v)
    j += 2
  }
  return { parts, next: j }
}

function recordRef(parts: string[], refs: string[][], cte: Set<string>): void {
  if (parts.length === 0 || parts.length > 3) return
  // CTE 별칭(단일 미수식 이름)
  if (parts.length === 1 && cte.has(parts[0].toLowerCase())) return
  const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined
  const catalog = parts.length >= 3 ? parts[parts.length - 3] : undefined
  if (schema && schema.toLowerCase() === 'information_schema') return
  if (catalog && catalog.toLowerCase() === 'system') return
  refs.push(parts)
}

/** FROM 뒤 콤마로 나열된 여러 아이템을 처리하고, 다음 스캔 위치를 반환. */
function readFrom(toks: Tok[], pos: number, refs: string[][], cte: Set<string>): number {
  let i = pos
  for (;;) {
    // 서브쿼리면 괄호 안으로 들어가 내부 FROM을 외부 스캐너가 발견하도록 둔다.
    if (isOp(toks[i], '(')) return i + 1
    const { parts, next } = readItem(toks, i)
    if (parts) recordRef(parts, refs, cte)
    i = next
    // 별칭/AS를 건너뛰고 콤마(다음 아이템) 또는 경계까지 전진
    while (i < toks.length) {
      const tk = toks[i]
      if (isOp(tk, ',')) break
      if (isOp(tk, '(') || isOp(tk, ')') || isOp(tk, ';')) return i
      if (tk.t === 'word' && !tk.q && FROM_BOUNDARY.has(tk.v.toUpperCase())) return i
      i++
    }
    if (isOp(toks[i], ',')) {
      i++
      continue
    }
    return i
  }
}

/** SQL에서 FROM/JOIN 테이블 참조 세그먼트 목록을 추출(중복 제거). */
export function extractTableRefs(sql: string): string[][] {
  let toks: Tok[]
  try {
    toks = tokenize(sql)
  } catch {
    return []
  }
  const cte = collectCte(toks)
  const refs: string[][] = []
  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    if (t.t === 'word' && !t.q) {
      const up = t.v.toUpperCase()
      if (up === 'FROM') {
        i = readFrom(toks, i + 1, refs, cte)
        continue
      }
      if (up === 'JOIN') {
        const r = readItem(toks, i + 1)
        if (r.parts) recordRef(r.parts, refs, cte)
        i = r.next
        continue
      }
    }
    i++
  }
  // 중복 제거(대소문자 구분 없이 같은 경로는 1회)
  const seen = new Set<string>()
  const out: string[][] = []
  for (const p of refs) {
    const key = p.map((s) => s.toLowerCase()).join(' ')
    if (!seen.has(key)) {
      seen.add(key)
      out.push(p)
    }
  }
  return out
}

/**
 * 세그먼트 목록을 host 기본 catalog/schema로 보정해 MetadataRef로 만든다.
 * 완전수식(3개)은 그대로. 미수식은 기본값으로 채우되, 채울 기본값이 없으면 null(=스킵).
 */
export function toMetadataRef(
  parts: string[],
  defCatalog?: string,
  defSchema?: string
): MetadataRef | null {
  if (parts.length === 3) return { catalog: parts[0], schema: parts[1], table: parts[2] }
  if (parts.length === 2) {
    if (!defCatalog) return null
    return { catalog: defCatalog, schema: parts[0], table: parts[1] }
  }
  if (parts.length === 1) {
    if (!defCatalog || !defSchema) return null
    return { catalog: defCatalog, schema: defSchema, table: parts[0] }
  }
  return null
}
