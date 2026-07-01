import { SQLDialect } from '@codemirror/lang-sql'
import { LanguageSupport, syntaxTree } from '@codemirror/language'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { TRINO_FUNCTIONS, TRINO_KEYWORDS, TRINO_TYPES } from './trinoWords'

// Trino 방언: 목록은 반드시 소문자(토크나이저가 words[word.toLowerCase()]로 조회 → 하이라이팅).
const trinoSql = SQLDialect.define({
  keywords: TRINO_KEYWORDS.join(' '),
  types: TRINO_TYPES.join(' '),
  builtin: TRINO_FUNCTIONS.join(' ')
})

// 실무 빈용 함수(상위 노출). 나머지 함수는 롱테일로 낮춘다.
const COMMON = new Set([
  'date_trunc', 'date_add', 'date_diff', 'date_format', 'date_parse', 'format_datetime',
  'parse_datetime', 'from_unixtime', 'to_unixtime', 'now', 'at_timezone',
  'concat', 'concat_ws', 'substr', 'substring', 'split', 'split_part', 'length', 'lower', 'upper',
  'trim', 'replace', 'regexp_replace', 'regexp_extract', 'regexp_like', 'format', 'position', 'starts_with',
  'coalesce', 'nullif', 'if', 'try', 'try_cast', 'cast', 'greatest', 'least',
  'count', 'sum', 'avg', 'min', 'max', 'min_by', 'max_by', 'array_agg', 'approx_distinct', 'approx_percentile',
  'row_number', 'rank', 'lag', 'lead',
  'cardinality', 'element_at', 'contains', 'array_join', 'array_distinct', 'filter', 'transform', 'reduce',
  'map_keys', 'map_values', 'sequence',
  'json_extract_scalar', 'json_extract', 'json_parse', 'json_format'
])

// 완성 후보(정적). 키워드·타입은 대문자 표기, 함수는 소문자(Trino docs 관례). 자동 괄호 없음(이름만 삽입).
const KEYWORD_OPTS: Completion[] = TRINO_KEYWORDS.map((k) => ({
  label: k.toUpperCase(),
  type: 'keyword',
  boost: 1
}))
const TYPE_OPTS: Completion[] = TRINO_TYPES.map((t) => ({
  label: t.toUpperCase(),
  type: 'type',
  boost: 1
}))
const FUNCTION_OPTS: Completion[] = TRINO_FUNCTIONS.map((f) => ({
  label: f,
  type: 'function',
  boost: COMMON.has(f) ? 1 : -1
}))

const KEYWORDS_AND_TYPES = [...KEYWORD_OPTS, ...TYPE_OPTS]
const ALL_OPTS = [...KEYWORD_OPTS, ...TYPE_OPTS, ...FUNCTION_OPTS]

// 문자열/주석/따옴표 식별자 안에서는 완성하지 않는다.
const SKIP_NODE = /String|Comment|Quoted/i

function trinoCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[\w]+/)
  if ((!word || word.from === word.to) && !ctx.explicit) return null

  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
  if (SKIP_NODE.test(node.name)) return null

  const from = word ? word.from : ctx.pos
  // catalog.schema.table 의 '.' 뒤에는 정적 키워드를 띄우지 않는다(메타데이터 오해 방지)
  if (from > 0 && ctx.state.sliceDoc(from - 1, from) === '.') return null

  const typed = word ? word.text : ''
  // 함수는 2글자 이상 입력했을 때만(1글자에 330개 함수가 쏟아지는 소음 방지). 명시 호출(⌃Space)은 전부.
  const options = typed.length >= 2 || ctx.explicit ? ALL_OPTS : KEYWORDS_AND_TYPES
  return { from, options }
}

/** Trino 하이라이팅 + 커스텀 완성. sql() 대신 이걸 extensions에 넣는다. */
export const trino = new LanguageSupport(trinoSql.language, [
  trinoSql.language.data.of({ autocomplete: trinoCompletionSource })
])
