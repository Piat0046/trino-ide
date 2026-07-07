// 쿼리 파라미터: SQL 안의 {{name}} / {{name:type}} 을 스캔해 실행 전 값을 치환한다(#34, F27).
// 순수 렌더러 문자열 변환 — 서버 왕복·스키마 조회 0. main/ipc/client 무변경.
//
// 규칙:
// - {{ }} 만 지원(:param 은 Trino ::캐스트·콜론 편재로 오탐 위험이라 미지원).
// - 문자열 리터럴 '…'·따옴표 식별자 "…"·주석 --,/* */ 안의 {{…}}는 무시(토크나이저).
// - {{snippet:…}} 는 F26(스니펫)용으로 예약 — 파라미터로 잡지 않는다.
// - 타입: text(기본)/number/date/multi. date-range는 {{name.start}}+{{name.end}} 접미 규약으로 묶는다.

// raw = 따옴표 없이 값을 그대로 삽입(식별자·동적 테이블/스키마명 보간용 이스케이프 해치).
export type ParamType = 'text' | 'number' | 'date' | 'multi' | 'raw'

/** 스캔으로 얻는 파라미터 정의. date-range는 kind='range'로 base 이름 하나에 묶인다. */
export interface ParamDef {
  /** 위젯/값맵 키. 일반=파라미터 이름, range=base 이름 */
  key: string
  /** 위젯 종류 */
  kind: 'text' | 'number' | 'date' | 'multi' | 'range' | 'raw'
  /** 원문에 등장한 raw 토큰명(치환 매칭용). range는 base(`x`), 실제 토큰은 x.start/x.end */
  raw: string
}

/** {{ }} 안의 한 토큰. name/type 분해 + 원문 위치. */
interface RawToken {
  /** 예: "from", "from.start", "n" */
  name: string
  /** 선언 타입(소문자). 없으면 undefined */
  type?: string
  start: number
  end: number
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/

/**
 * 문자열/식별자/주석을 건너뛰며 최상위 {{…}} 토큰만 수집.
 * (sqlStatements.ts 토크나이저와 같은 스킵 규칙)
 */
function scanRawTokens(sql: string): RawToken[] {
  const out: RawToken[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      i++
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) i += 2
          else {
            i++
            break
          }
        } else i++
      }
      continue
    }
    if (c === '{' && sql[i + 1] === '{') {
      const close = sql.indexOf('}}', i + 2)
      if (close === -1) break // 닫히지 않은 {{ — 나머지는 파라미터 아님
      const inner = sql.slice(i + 2, close).trim()
      const colon = inner.indexOf(':')
      const name = (colon === -1 ? inner : inner.slice(0, colon)).trim()
      const type = colon === -1 ? undefined : inner.slice(colon + 1).trim().toLowerCase()
      out.push({ name, type, start: i, end: close + 2 })
      i = close + 2
      continue
    }
    i++
  }
  return out
}

/** 에디터 하이라이트용: 실제 파라미터 토큰({{…}})의 원문 위치(문자열/주석/snippet 제외). */
export function paramRanges(sql: string): Array<{ from: number; to: number }> {
  return scanRawTokens(sql)
    .filter((t) => NAME_RE.test(t.name) && t.name.toLowerCase() !== 'snippet')
    .map((t) => ({ from: t.start, to: t.end }))
}

function normalizeType(t?: string): ParamType {
  if (t === 'number' || t === 'date' || t === 'multi' || t === 'text') return t
  return 'raw' // 미지정·미지원 타입은 raw(그대로) — 인용이 필요하면 위젯에서 '문자열' 선택
}

/** 위젯 타입 드롭다운에 노출할 타입과 라벨(range는 .start/.end 네이밍으로 자동 → 제외). */
export const PARAM_TYPES: ReadonlyArray<{ value: ParamType; label: string }> = [
  { value: 'raw', label: '그대로' },
  { value: 'text', label: '문자열' },
  { value: 'number', label: '숫자' },
  { value: 'date', label: '날짜' },
  { value: 'multi', label: '여러 값' }
]

/**
 * 실행 대상 SQL에서 파라미터 정의를 순서대로(중복 제거) 추출한다.
 * - snippet: 접두는 제외(F26 예약).
 * - {{x.start}}+{{x.end}} 가 함께 있으면 range 하나로 묶는다(한쪽만 있으면 각각 date/일반).
 * - 이름 형식이 유효하지 않은 토큰은 무시.
 */
export function scanParams(sql: string): ParamDef[] {
  // 유효 이름 + snippet 예약({{snippet:foo}}는 name='snippet') 제외
  const params = scanRawTokens(sql).filter(
    (t) => NAME_RE.test(t.name) && t.name.toLowerCase() !== 'snippet'
  )

  // range 후보: base.start AND base.end 둘 다 있을 때만 묶는다(한쪽만이면 일반 파라미터로 degrade)
  const hasStart = new Set<string>()
  const hasEnd = new Set<string>()
  for (const t of params) {
    const m = /^(.+)\.(start|end)$/.exec(t.name)
    if (m) (m[2] === 'start' ? hasStart : hasEnd).add(m[1])
  }
  const rangeBases = new Set<string>([...hasStart].filter((b) => hasEnd.has(b)))

  const seen = new Set<string>()
  const defs: ParamDef[] = []
  for (const t of params) {
    const m = /^(.+)\.(start|end)$/.exec(t.name)
    if (m && rangeBases.has(m[1])) {
      const base = m[1]
      if (seen.has('range:' + base)) continue
      seen.add('range:' + base)
      defs.push({ key: base, kind: 'range', raw: base })
      continue
    }
    if (seen.has('one:' + t.name)) continue
    seen.add('one:' + t.name)
    defs.push({ key: t.name, kind: normalizeType(t.type), raw: t.name })
  }
  return defs
}

/** 작은따옴표 문자열 리터럴로 감싼다('→'' 이스케이프). */
function quote(v: string): string {
  return "'" + v.replace(/'/g, "''") + "'"
}

/** 숫자 리터럴로 허용되는지(raw 삽입 유일 표면 — 엄격 제약). */
export function isValidNumber(v: string): boolean {
  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim())
}

/** 파라미터 값. range는 {start,end}, multi는 string[], 그 외 string. */
export type ParamValue = string | string[] | { start: string; end: string }

/** 위젯 초기 기본값(빈 값). */
export function defaultValue(def: ParamDef): ParamValue {
  if (def.kind === 'multi') return []
  if (def.kind === 'range') return { start: '', end: '' }
  return ''
}

/** 값이 실행 가능한 형식인지(빈값·비숫자·범위역전·빈 multi 차단 — 실행 게이팅용). */
export function paramValueValid(def: ParamDef, val: ParamValue | undefined): boolean {
  switch (def.kind) {
    case 'number':
      return typeof val === 'string' && isValidNumber(val)
    case 'multi':
      return Array.isArray(val) && val.length > 0
    case 'range':
      if (!val || typeof val !== 'object' || Array.isArray(val)) return false
      return val.start !== '' && val.end !== '' && val.start <= val.end
    default: // text, raw
      return typeof val === 'string' && val.trim() !== ''
  }
}

/** 실행 대상의 모든 파라미터가 유효한가. */
export function paramsReady(defs: ParamDef[], values: Record<string, ParamValue>): boolean {
  return defs.every((d) => paramValueValid(d, values[d.key]))
}

/** 한 정의를 실제 치환 문자열로 컴파일한다(값 형식은 UI가 보장). */
function compileValue(def: ParamDef, val: ParamValue | undefined): string {
  switch (def.kind) {
    case 'number': {
      const s = typeof val === 'string' ? val.trim() : ''
      return isValidNumber(s) ? s : s // 유효성은 UI가 게이팅(여기선 raw)
    }
    case 'date': {
      const s = typeof val === 'string' ? val.trim() : ''
      return "DATE " + quote(s)
    }
    case 'multi': {
      const arr = Array.isArray(val) ? val : []
      return arr.map((v) => quote(v)).join(', ')
    }
    case 'raw':
      return typeof val === 'string' ? val : '' // 따옴표 없이 그대로(식별자 보간)
    case 'range':
      return '' // range는 아래 applyParams에서 .start/.end 토큰을 직접 치환
    default: {
      const s = typeof val === 'string' ? val : ''
      return quote(s)
    }
  }
}

/** 위젯에서 선택된 유효 타입 맵(def.key → kind). range base는 'range'. */
export type KindMap = Record<string, ParamDef['kind']>

/**
 * SQL의 모든 {{…}} 토큰을 값으로 치환한 최종 SQL을 만든다(문자열/주석 속 토큰은 보존).
 * values: def.key → ParamValue. kinds: def.key → 위젯에서 선택된 타입(없으면 raw로 폴백).
 * range는 kinds[base]==='range'일 때 .start/.end 토큰이 각각 DATE '…'로.
 */
export function applyParams(
  sql: string,
  values: Record<string, ParamValue>,
  kinds: KindMap = {}
): string {
  const tokens = scanRawTokens(sql)
  let out = ''
  let last = 0
  for (const t of tokens) {
    if (!NAME_RE.test(t.name) || t.name.toLowerCase() === 'snippet') continue // 보존
    out += sql.slice(last, t.start)
    out += renderToken(t, values, kinds)
    last = t.end
  }
  out += sql.slice(last)
  return out
}

function renderToken(t: RawToken, values: Record<string, ParamValue>, kinds: KindMap): string {
  const m = /^(.+)\.(start|end)$/.exec(t.name)
  if (m && kinds[m[1]] === 'range') {
    const v = values[m[1]]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return 'DATE ' + quote(m[2] === 'start' ? v.start : v.end)
    }
    return 'DATE ' + quote('')
  }
  const kind = kinds[t.name] ?? 'raw'
  return compileValue({ key: t.name, kind, raw: t.name }, values[t.name])
}
