// SQL 스크립트를 문장(;로 구분) 단위로 안전하게 분리한다.
// 문자열 리터럴('...', ''로 이스케이프)·따옴표 식별자("...", ""로 이스케이프)·
// 라인 주석(--)·블록 주석(/* */) 안의 세미콜론은 구분자로 보지 않는다.
// 실행/하이라이트/문장 인디케이터가 공유하는 순수 함수.

export interface Statement {
  /** 원문에서의 시작 오프셋(선행 공백 포함) */
  start: number
  /** 종결 세미콜론 '다음' 인덱스. 세미콜론이 없으면 문서 끝 */
  end: number
  /** 실행/기록에 쓰는 본문: 끝의 ; 제거 후 trim */
  text: string
}

/** 원문을 문장 경계로 쪼갠다. 빈(공백/주석뿐) 구간도 범위 매핑을 위해 포함한다. */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
  const n = sql.length
  let stmtStart = 0
  let i = 0

  const push = (start: number, end: number): void => {
    out.push({ start, end, text: statementText(sql.slice(start, end)) })
  }

  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      // 라인 주석
      i += 2
      while (i < n && sql[i] !== '\n') i++
    } else if (c === '/' && sql[i + 1] === '*') {
      // 블록 주석
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
    } else if (c === "'" || c === '"') {
      // 문자열 리터럴 / 따옴표 식별자 (같은 따옴표 2개로 이스케이프)
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
    } else if (c === ';') {
      push(stmtStart, i + 1)
      i++
      stmtStart = i
    } else {
      i++
    }
  }
  // 마지막 세미콜론 뒤에 내용이 남아 있으면 문장으로 추가
  if (stmtStart < n) push(stmtStart, n)
  return out
}

/** 한 구간에서 끝의 세미콜론을 제거하고 trim. */
export function statementText(chunk: string): string {
  return chunk.replace(/;\s*$/, '').trim()
}

/**
 * 커서 위치(pos)가 속한 문장. 규칙: pos <= end 인 '첫' 문장.
 * (문장 본문/종결자 위 → 그 문장, ; 바로 뒤 → 다음 문장)
 * 해당 문장이 없으면(=pos가 모든 문장 뒤) 마지막 비어있지 않은 문장.
 */
export function statementAtCursor(
  sql: string,
  pos: number,
  stmts: Statement[] = splitStatements(sql)
): Statement | null {
  if (stmts.length === 0) return null
  for (const s of stmts) {
    if (pos <= s.end) return s
  }
  for (let i = stmts.length - 1; i >= 0; i--) {
    if (stmts[i].text) return stmts[i]
  }
  return stmts[stmts.length - 1]
}

/** 실행 대상 텍스트. 선택이 있으면 선택, 없으면 커서 문장. */
export interface RunTarget {
  mode: 'selection' | 'statement'
  /** 실제로 실행/경고 판정에 쓰는 텍스트(끝 세미콜론 제거·trim) */
  text: string
  /** 선택이 여러 문장(세미콜론 경계)에 걸쳐 실행 불가 */
  spansMultiple: boolean
}

/** 청크에 주석·공백이 아닌 실제 코드가 있는지(문자열/식별자 리터럴은 코드로 본다). */
function hasCode(chunk: string): boolean {
  const n = chunk.length
  for (let i = 0; i < n; ) {
    const c = chunk[i]
    if (c === '-' && chunk[i + 1] === '-') {
      i += 2
      while (i < n && chunk[i] !== '\n') i++
      continue
    }
    if (c === '/' && chunk[i + 1] === '*') {
      i += 2
      while (i < n && !(chunk[i] === '*' && chunk[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (!/\s/.test(c)) return true
    i++
  }
  return false
}

/**
 * ⌘↵/실행이 대상으로 삼을 텍스트를 결정한다.
 * 실제 코드가 있는(주석/공백만은 제외) 선택이 있으면 그 텍스트, 없으면 head가 놓인 커서 문장.
 * spansMultiple은 주석/공백뿐인 청크를 빼고 실 코드 문장이 둘 이상일 때만 true.
 * 순수 함수 — 실행·대용량 경고·활성 하이라이트가 이 단일 소스를 공유한다.
 */
export function resolveRunTarget(sql: string, from: number, to: number, head: number): RunTarget {
  if (from !== to) {
    const selText = statementText(sql.slice(from, to))
    if (hasCode(selText)) {
      const spansMultiple = splitStatements(selText).filter((s) => hasCode(s.text)).length > 1
      return { mode: 'selection', text: selText, spansMultiple }
    }
  }
  const stmt = statementAtCursor(sql, head)
  return { mode: 'statement', text: stmt?.text ?? '', spansMultiple: false }
}
