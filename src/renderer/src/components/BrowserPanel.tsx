import { useEffect, useRef, useState } from 'react'
import type { HostConfig, HostMetadata, QueryErrorInfo } from '@shared/types'
import {
  showCatalogsSql,
  showSchemasSql,
  showTablesSql,
  parseNames
} from '../lib/showQueries'
import { IconChevronDown, IconChevronRight, IconPlus, IconRefresh } from './icons'

const api = window.api

/** host별 서버 조회 결과 캐시(App 보관, 세션 한정). 재펼침·섹션 전환 시 서버 왕복 0. */
export interface BrowseData {
  /** SHOW CATALOGS 결과. undefined면 아직 안 불러옴(빈 상태) */
  catalogs?: string[]
  /** catalog → schema[] */
  schemas: Record<string, string[]>
  /** tkey(catalog, schema) → table[] */
  tables: Record<string, string[]>
}

export const emptyBrowse: BrowseData = { schemas: {}, tables: {} }
// tables 캐시 키: 길이 접두로 catalog/schema 경계를 명확히 해 충돌 방지("ab"+"c" ≠ "a"+"bc")
const tkey = (c: string, s: string): string => c.length + '.' + c + '/' + s

interface Props {
  hosts: HostConfig[]
  hostId: string | null
  onSelectHost: (id: string) => void
  /** 등록됨 판정용(같은 host의 등록/학습 메타데이터) */
  metadata: HostMetadata | null
  cache: BrowseData
  onCache: (fn: (d: BrowseData) => BrowseData) => void
  onRegisterTables: (catalog: string, schema: string, tables: string[]) => void
}

type NodeErr = string

/**
 * 서버 catalog→schema→table 드릴다운 탐색 + 골라 등록(#52 재정의).
 * 펼치기=명시 클릭 1회=서버 SHOW 1회(캐시). 자동/폴링 없음. 실행은 query:run(recordHistory:false).
 */
export function BrowserPanel({
  hosts,
  hostId,
  onSelectHost,
  metadata,
  cache,
  onCache,
  onRegisterTables
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, NodeErr>>({})
  const reqRef = useRef<Record<string, string>>({}) // nodeKey → requestId(가장 최근)

  // host가 바뀌면 펼침/로딩/에러 리셋(데이터 캐시는 App가 host별로 보관 → 재선택 시 재사용)
  useEffect(() => {
    setExpanded(new Set())
    setLoading(new Set())
    setErrors({})
  }, [hostId])

  const setLoad = (key: string, on: boolean): void =>
    setLoading((s) => {
      const n = new Set(s)
      if (on) n.add(key)
      else n.delete(key)
      return n
    })
  const setErr = (key: string, msg?: string): void =>
    setErrors((e) => {
      const n = { ...e }
      if (msg) n[key] = msg
      else delete n[key]
      return n
    })

  // 서버 SHOW 1회 실행 → 이름 목록. recordHistory:false로 history·학습·그리드 무오염.
  const fetchList = (nodeKey: string, sql: string, onOk: (names: string[]) => void): void => {
    if (!hostId || loading.has(nodeKey)) return
    setLoad(nodeKey, true)
    setErr(nodeKey, undefined)
    const requestId = crypto.randomUUID()
    reqRef.current[nodeKey] = requestId
    void api
      .runQuery({ hostId, sql, requestId, recordHistory: false })
      .then((res) => {
        if (reqRef.current[nodeKey] !== requestId) return // host 전환·재요청으로 무효
        setLoad(nodeKey, false)
        if (res.ok) onOk(parseNames(res.value))
        else {
          const info = res.errorInfo as QueryErrorInfo | undefined
          setErr(nodeKey, (info?.errorName ? info.errorName + ' · ' : '') + res.error)
        }
      })
      .catch((e) => {
        if (reqRef.current[nodeKey] !== requestId) return
        setLoad(nodeKey, false)
        setErr(nodeKey, e instanceof Error ? e.message : String(e))
      })
  }

  const loadCatalogs = (): void =>
    fetchList('__root__', showCatalogsSql(), (names) =>
      onCache((d) => ({ ...d, catalogs: names }))
    )
  const refreshCatalogs = (): void => {
    // 카탈로그만 재조회 + 하위 캐시 무효화(1클릭=1왕복 유지)
    onCache(() => ({ ...emptyBrowse }))
    setExpanded(new Set())
    fetchList('__root__', showCatalogsSql(), (names) =>
      onCache((d) => ({ ...d, catalogs: names }))
    )
  }

  const toggle = (key: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const openCatalog = (cat: string): void => {
    toggle('c:' + cat)
    if (cache.schemas[cat] === undefined && !expanded.has('c:' + cat)) {
      fetchList('c:' + cat, showSchemasSql(cat), (names) =>
        onCache((d) => ({ ...d, schemas: { ...d.schemas, [cat]: names } }))
      )
    }
  }
  const openSchema = (cat: string, sch: string): void => {
    const k = tkey(cat, sch)
    toggle('s:' + k)
    if (cache.tables[k] === undefined && !expanded.has('s:' + k)) {
      fetchList('s:' + k, showTablesSql(cat, sch), (names) =>
        onCache((d) => ({ ...d, tables: { ...d.tables, [k]: names } }))
      )
    }
  }
  const refreshSchema = (cat: string, sch: string): void => {
    const k = tkey(cat, sch)
    fetchList('s:' + k, showTablesSql(cat, sch), (names) =>
      onCache((d) => ({ ...d, tables: { ...d.tables, [k]: names } }))
    )
  }

  // 등록됨 판정(대소문자 무시): 등록/학습 메타데이터에 catalog.schema.table 존재?
  const regTables = (cat: string, sch: string): Set<string> => {
    const t = metadata?.catalogs[cat]?.schemas[sch]?.tables ?? {}
    return new Set(Object.keys(t).map((n) => n.toLowerCase()))
  }

  const hostSelect = (
    <div className="meta-hostbar">
      <select
        className="meta-select"
        value={hostId ?? ''}
        onChange={(e) => onSelectHost(e.target.value)}
      >
        <option value="" disabled>
          연결 선택…
        </option>
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </div>
  )

  if (!hostId) {
    return (
      <div className="panel">
        {hostSelect}
        <div className="empty">연결을 선택하면 서버를 탐색할 수 있습니다.</div>
      </div>
    )
  }

  const rootLoading = loading.has('__root__')
  const rootErr = errors['__root__']

  return (
    <div className="panel browser-panel">
      {hostSelect}
      <div className="browse-caption">펼침 = 서버 조회 1회 · 재펼침은 캐시</div>

      {cache.catalogs === undefined ? (
        <div className="browse-load">
          {rootErr && <div className="test-result fail">{rootErr}</div>}
          <button className="primary" disabled={rootLoading} onClick={loadCatalogs}>
            {rootLoading ? '조회 중…' : '카탈로그 불러오기 · 서버 조회 1회'}
          </button>
        </div>
      ) : (
        <ul className="list browse-tree" role="tree">
          {cache.catalogs.length === 0 && <li className="empty">카탈로그가 없습니다.</li>}
          {cache.catalogs.map((cat) => {
            const cKey = 'c:' + cat
            const cOpen = expanded.has(cKey)
            const cLoading = loading.has(cKey)
            const cErr = errors[cKey]
            const schemas = cache.schemas[cat]
            const willFetch = schemas === undefined
            return (
              <li key={cat} className="folder" role="treeitem" aria-expanded={cOpen}>
                <div
                  className="folder-row"
                  title={cat + (willFetch ? ' · 펼치면 서버 조회' : '')}
                  onClick={() => openCatalog(cat)}
                >
                  <span className={'caret' + (willFetch && !cOpen ? ' will-fetch' : '')}>
                    {cLoading ? (
                      <span className="spin" />
                    ) : cOpen ? (
                      <IconChevronDown size={13} />
                    ) : (
                      <IconChevronRight size={13} />
                    )}
                  </span>
                  <span className="meta-icon">▤</span>
                  <span className="folder-name">{cat}</span>
                  {schemas && <span className="folder-count">{schemas.length}</span>}
                </div>
                {cOpen && (
                  <ul className="query-list" role="group">
                    {cErr && <li className="test-result fail node-err">{cErr}</li>}
                    {!cErr && schemas && schemas.length === 0 && (
                      <li className="empty small">스키마가 없거나 조회 권한이 없습니다.</li>
                    )}
                    {schemas?.map((sch) => {
                      const k = tkey(cat, sch)
                      const sKey = 's:' + k
                      const sOpen = expanded.has(sKey)
                      const sLoading = loading.has(sKey)
                      const sErr = errors[sKey]
                      const tables = cache.tables[k]
                      const sWillFetch = tables === undefined
                      const reg = tables ? regTables(cat, sch) : new Set<string>()
                      const unreg = tables?.filter((t) => !reg.has(t.toLowerCase())) ?? []
                      return (
                        <li key={sch} className="folder meta-sub" role="treeitem" aria-expanded={sOpen}>
                          <div
                            className="folder-row"
                            title={sch + (sWillFetch ? ' · 펼치면 서버 조회' : '')}
                            onClick={() => openSchema(cat, sch)}
                          >
                            <span className={'caret' + (sWillFetch && !sOpen ? ' will-fetch' : '')}>
                              {sLoading ? (
                                <span className="spin" />
                              ) : sOpen ? (
                                <IconChevronDown size={12} />
                              ) : (
                                <IconChevronRight size={12} />
                              )}
                            </span>
                            <span className="meta-icon">◇</span>
                            <span className="folder-name">{sch}</span>
                            {tables && <span className="folder-count">{tables.length}</span>}
                            {tables && (
                              <div className="row-actions">
                                {unreg.length > 0 && (
                                  <button
                                    className="mini"
                                    title="보이는 테이블 모두 등록"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onRegisterTables(cat, sch, unreg)
                                    }}
                                  >
                                    <IconPlus size={12} />전체
                                  </button>
                                )}
                                <button
                                  className="mini"
                                  title="테이블 목록 새로고침 (서버 조회 1회)"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    refreshSchema(cat, sch)
                                  }}
                                >
                                  <IconRefresh size={12} />
                                </button>
                              </div>
                            )}
                          </div>
                          {sOpen && (
                            <ul className="query-list" role="group">
                              {sErr && <li className="test-result fail node-err">{sErr}</li>}
                              {!sErr && tables && tables.length === 0 && (
                                <li className="empty small">
                                  테이블이 없거나 조회 권한이 없습니다.
                                </li>
                              )}
                              {tables?.map((tbl) => {
                                const registered = reg.has(tbl.toLowerCase())
                                return (
                                  <li key={tbl} className="folder meta-sub2" role="treeitem">
                                    <div className="folder-row leaf" title={`${cat}.${sch}.${tbl}`}>
                                      <span className="caret-blank" />
                                      <span className="meta-icon table">▦</span>
                                      <span className="folder-name">{tbl}</span>
                                      {registered ? (
                                        <span className="meta-badge">등록됨</span>
                                      ) : (
                                        <div className="row-actions">
                                          <button
                                            className="mini"
                                            title="메타데이터에 등록"
                                            onClick={(e) => {
                                              e.stopPropagation()
                                              onRegisterTables(cat, sch, [tbl])
                                            }}
                                          >
                                            <IconPlus size={12} />
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
          <li className="browse-refresh">
            <button className="linklike" disabled={rootLoading} onClick={refreshCatalogs}>
              <IconRefresh size={12} /> 카탈로그 새로고침 (서버 조회 1회)
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}
