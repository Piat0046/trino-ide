import { SQLDialect } from '@codemirror/lang-sql'
import { LanguageSupport, syntaxTree } from '@codemirror/language'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { CatalogNode, HostMetadata, MetaNode, SchemaNode } from '@shared/types'
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

/** 자동완성 소스가 매 호출 시 읽는 "현재 host 메타데이터" 공급자. */
export interface CompletionMeta {
  meta: HostMetadata | null
  /** 연결의 기본 catalog/schema(미수식 이름 완성 근거) — 현재는 참조만 */
  defCatalog?: string
  defSchema?: string
}
type GetMeta = () => CompletionMeta

// ── 메타데이터 → 완성 후보 helpers ──────────────────────────────────

/** 식별자에 특수문자/공백이 있으면 따옴표로 감싼다. */
function quoteId(id: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? id : `"${id.replace(/"/g, '""')}"`
}

/** 자주/최근 쓴 것을 위로. manual은 최소 보장 부스트. 키워드(boost 1)보다는 항상 위. */
function metaBoost(node: MetaNode): number {
  const base = Math.min(90, node.count)
  return node.source === 'manual' ? Math.max(base, 25) : Math.max(base, 2)
}

function metaDetail(kind: string, node: MetaNode, parent?: string): string {
  const tag = node.source === 'manual' ? '✎ 수동' : node.count > 0 ? `${node.count}×` : ''
  return [kind, parent, tag].filter(Boolean).join(' · ')
}

/** 대소문자 무시 조회(Trino 미따옴표 식별자는 소문자로 접힘). */
function ciGet<T>(rec: Record<string, T>, key: string): T | undefined {
  if (rec[key]) return rec[key]
  const lk = key.toLowerCase()
  for (const k in rec) if (k.toLowerCase() === lk) return rec[k]
  return undefined
}

function catalogCompletion(name: string, node: CatalogNode): Completion {
  const schemaCount = Object.keys(node.schemas).length
  return {
    label: name,
    type: 'catalog',
    detail: metaDetail(schemaCount ? `catalog · ${schemaCount} schema` : 'catalog', node),
    apply: quoteId(name),
    boost: metaBoost(node)
  }
}
function schemaCompletion(name: string, node: SchemaNode, catName: string): Completion {
  return {
    label: name,
    type: 'schema',
    detail: metaDetail('schema', node, catName),
    apply: quoteId(name),
    boost: metaBoost(node)
  }
}
function tableCompletion(
  name: string,
  node: MetaNode,
  catName: string,
  schName: string,
  fullyQualified: boolean
): Completion {
  return {
    label: name,
    type: 'table',
    detail: metaDetail('table', node, `${catName}.${schName}`),
    apply: fullyQualified
      ? `${quoteId(catName)}.${quoteId(schName)}.${quoteId(name)}`
      : quoteId(name),
    boost: metaBoost(node)
  }
}

/** `catalog.` → schema 목록 / `catalog.schema.` → table 목록. 못 찾으면 null(억제). */
function dotOptions(meta: HostMetadata, segs: string[]): Completion[] | null {
  if (segs.length === 1) {
    const cat = ciGet(meta.catalogs, segs[0])
    if (!cat) return null
    return Object.entries(cat.schemas).map(([n, node]) => schemaCompletion(n, node, segs[0]))
  }
  if (segs.length === 2) {
    const cat = ciGet(meta.catalogs, segs[0])
    if (!cat) return null
    const sch = ciGet(cat.schemas, segs[1])
    if (!sch) return null
    return Object.entries(sch.tables).map(([n, node]) => tableCompletion(n, node, segs[0], segs[1], false))
  }
  // 3+ 세그먼트(컬럼)는 Phase 2
  return null
}

/** FROM/JOIN 직후: catalog 목록 + 완전수식 table(상단 부스트). */
function fromContextOptions(meta: HostMetadata): Completion[] {
  const out: Completion[] = []
  for (const [catName, cat] of Object.entries(meta.catalogs)) {
    out.push(catalogCompletion(catName, cat))
    for (const [schName, sch] of Object.entries(cat.schemas)) {
      for (const [tblName, tbl] of Object.entries(sch.tables)) {
        out.push(tableCompletion(tblName, tbl, catName, schName, true))
      }
    }
  }
  return out
}

/** 커서 앞의 점 체인(`catalog.` / `catalog.schema.`)에서 세그먼트를 추출. */
function chainBeforeDot(ctx: CompletionContext, from: number): string[] | null {
  const pre = ctx.state.sliceDoc(Math.max(0, from - 256), from)
  const m = /([A-Za-z0-9_".]+)\.$/.exec(pre)
  if (!m) return null
  const segs = m[1]
    .split('.')
    .map((s) => s.replace(/^"|"$/g, '').replace(/""/g, '"'))
    .filter((s) => s.length > 0)
  return segs.length > 0 ? segs : null
}

/** getMeta 클로저를 캡처한 완성 소스를 만든다. */
function makeCompletionSource(getMeta: GetMeta) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
    if (SKIP_NODE.test(node.name)) return null

    const word = ctx.matchBefore(/[\w]+/)
    const from = word ? word.from : ctx.pos
    const { meta } = getMeta()

    // 1) catalog.schema.table 드릴다운: '.' 뒤에서는 입력 단어가 없어도 즉시 완성
    //    (이 분기를 no-word 가드보다 먼저 둬야 `hive.` / `hive.sales.` 에서 바로 목록이 뜬다)
    if (from > 0 && ctx.state.sliceDoc(from - 1, from) === '.') {
      if (!meta) return null
      const segs = chainBeforeDot(ctx, from)
      if (!segs) return null
      const opts = dotOptions(meta, segs)
      return opts && opts.length ? { from, options: opts, validFor: /^[\w]*$/ } : null
    }

    // 2) FROM/JOIN 직후: 카탈로그 + 완전수식 테이블을 정적 완성 위에 얹는다
    const inFrom = !!ctx.matchBefore(/\b(from|join)\s+[\w".]*$/i)
    const metaOpts = inFrom && meta ? fromContextOptions(meta) : []

    const hasWord = !!word && word.from !== word.to
    // 단어도, 명시 호출(⌃Space)도, FROM/JOIN 메타 후보도 없으면 완성하지 않는다
    if (!hasWord && !ctx.explicit && metaOpts.length === 0) return null

    const includeStatic = hasWord || ctx.explicit
    const typed = word ? word.text : ''
    // 함수는 2글자 이상 입력했을 때만(1글자에 330개 함수가 쏟아지는 소음 방지). 명시 호출(⌃Space)은 전부.
    const staticOpts = includeStatic
      ? typed.length >= 2 || ctx.explicit
        ? ALL_OPTS
        : KEYWORDS_AND_TYPES
      : []
    const options = [...metaOpts, ...staticOpts]
    return options.length ? { from, options } : null
  }
}

/**
 * Trino 하이라이팅 + 커스텀 완성. getMeta로 현재 host 메타데이터를 매 호출 읽는다.
 * 확장 인스턴스는 고정하고 클로저(getMeta) 내부 데이터만 갱신하는 방식으로 쓴다(호출부 참조).
 */
export function makeTrino(getMeta: GetMeta): LanguageSupport {
  return new LanguageSupport(trinoSql.language, [
    trinoSql.language.data.of({ autocomplete: makeCompletionSource(getMeta) })
  ])
}

/** 메타데이터 없는 정적 기본 인스턴스(호환용). */
export const trino = makeTrino(() => ({ meta: null }))
