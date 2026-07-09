import { useEffect, useRef, useState } from 'react'
import type { HostConfig, HostMetadata, QueryErrorInfo } from '@shared/types'
import {
  showCatalogsSql,
  showSchemasSql,
  showTablesSql,
  parseNames
} from '../lib/showQueries'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconRefresh,
  IconTrash
} from './icons'

const api = window.api

/** host별 서버 조회 결과 캐시(App 보관, 세션 한정). 재펼침·섹션 전환·모드 스왑 시 서버 왕복 0. */
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
  /** 등록됨(manual) 판정·홈 트리 소스(같은 host의 메타데이터) */
  metadata: HostMetadata | null
  cache: BrowseData
  onCache: (fn: (d: BrowseData) => BrowseData) => void
  onRegisterTables: (catalog: string, schema: string, tables: string[]) => void
  onUnregister: (catalog: string, schema: string, table: string) => void
}

type NodeErr = string
type Mode = 'home' | 'browse'

/**
 * 두 모드(#52 재설계):
 * - home(등록됨): 내가 등록한(manual) catalog→schema→table을 metadata에서 렌더 — 서버 왕복 0.
 * - browse(찾아보기): 서버 드릴다운(SHOW). 펼치기=명시 클릭 1회=서버 1회(캐시). 골라 등록.
 * 등록은 upsertMetadata(manual), 실행은 query:run(recordHistory:false)로 history·학습·그리드 무오염.
 */
export function BrowserPanel({
  hosts,
  hostId,
  onSelectHost,
  metadata,
  cache,
  onCache,
  onRegisterTables,
  onUnregister
}: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('home')
  const [expanded, setExpanded] = useState<Set<string>>(new Set()) // browse 펼침
  const [homeCollapsed, setHomeCollapsed] = useState<Set<string>>(new Set()) // home 접힘(기본 펼침)
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, NodeErr>>({})
  const reqRef = useRef<Record<string, string>>({}) // nodeKey → requestId(가장 최근)

  // host가 바뀌면 home으로 리셋 + 펼침/로딩/에러 초기화(데이터 캐시는 App가 host별 보관)
  useEffect(() => {
    setMode('home')
    setExpanded(new Set())
    setHomeCollapsed(new Set())
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
  const toggleHome = (key: string): void =>
    setHomeCollapsed((s) => {
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

  // 등록됨(manual) 테이블 집합(대소문자 무시) — browse 배지 + home 필터 공용
  const manualTables = (cat: string, sch: string): Set<string> => {
    const t = metadata?.catalogs[cat]?.schemas[sch]?.tables ?? {}
    return new Set(
      Object.entries(t)
        .filter(([, n]) => n.source === 'manual')
        .map(([k]) => k.toLowerCase())
    )
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
        <div className="empty">연결을 선택하면 등록한 항목이 표시됩니다.</div>
      </div>
    )
  }

  // ---------- 찾아보기(browse) ----------
  if (mode === 'browse') {
    const rootLoading = loading.has('__root__')
    const rootErr = errors['__root__']
    return (
      <div className="panel browser-panel">
        {hostSelect}
        <div className="browse-modebar">
          <button className="linklike" title="등록한 항목으로 돌아가기" onClick={() => setMode('home')}>
            <IconChevronLeft size={13} /> 등록됨
          </button>
          <span className="browse-caption inline">펼침 = 서버 조회 1회 · 재펼침은 캐시</span>
        </div>

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
                        const reg = tables ? manualTables(cat, sch) : new Set<string>()
                        const unreg = tables?.filter((t) => !reg.has(t.toLowerCase())) ?? []
                        return (
                          <li
                            key={sch}
                            className="folder meta-sub"
                            role="treeitem"
                            aria-expanded={sOpen}
                          >
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
                                      <div
                                        className="folder-row leaf"
                                        title={`${cat}.${sch}.${tbl}`}
                                      >
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
              <button
                className="linklike"
                disabled={rootLoading}
                title="카탈로그를 다시 조회하고 하위 캐시를 비웁니다"
                onClick={refreshCatalogs}
              >
                <IconRefresh size={12} /> 전체 새로고침 · 서버 조회 1회
              </button>
            </li>
          </ul>
        )}
      </div>
    )
  }

  // ---------- 등록됨(home) — manual 테이블로 이어지는 경로만, 서버 0 ----------
  const homeTree = Object.entries(metadata?.catalogs ?? {})
    .map(([cName, c]) => ({
      cName,
      schs: Object.entries(c.schemas)
        .map(([sName, s]) => ({
          sName,
          tbls: Object.entries(s.tables)
            .filter(([, t]) => t.source === 'manual')
            .map(([n]) => n)
        }))
        .filter((x) => x.tbls.length > 0)
    }))
    .filter((x) => x.schs.length > 0)

  if (homeTree.length === 0) {
    return (
      <div className="panel browser-panel">
        {hostSelect}
        <div className="browse-empty">
          <p className="empty-title">아직 등록한 항목이 없어요.</p>
          <p className="empty-sub">
            찾아보기로 서버에서 catalog·schema·table을 골라 담으세요.
          </p>
          <button className="primary" onClick={() => setMode('browse')}>
            <IconPlus size={14} /> 찾아보기
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel browser-panel">
      {hostSelect}
      <button className="browse-find-btn" onClick={() => setMode('browse')}>
        <IconPlus size={13} /> 찾아보기
      </button>
      <div className="browse-caption">등록한 항목 · 서버 조회 0</div>
      <ul className="list browse-tree home" role="tree">
        {homeTree.map(({ cName, schs }) => {
          const cKey = 'c:' + cName
          const cOpen = !homeCollapsed.has(cKey)
          return (
            <li key={cName} className="folder" role="treeitem" aria-expanded={cOpen}>
              <div className="folder-row" title={cName} onClick={() => toggleHome(cKey)}>
                <span className="caret">
                  {cOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                </span>
                <span className="meta-icon">▤</span>
                <span className="folder-name">{cName}</span>
                <span className="folder-count">{schs.length}</span>
              </div>
              {cOpen && (
                <ul className="query-list" role="group">
                  {schs.map(({ sName, tbls }) => {
                    const sKey = 's:' + tkey(cName, sName)
                    const sOpen = !homeCollapsed.has(sKey)
                    return (
                      <li
                        key={sName}
                        className="folder meta-sub"
                        role="treeitem"
                        aria-expanded={sOpen}
                      >
                        <div
                          className="folder-row"
                          title={sName}
                          onClick={() => toggleHome(sKey)}
                        >
                          <span className="caret">
                            {sOpen ? (
                              <IconChevronDown size={12} />
                            ) : (
                              <IconChevronRight size={12} />
                            )}
                          </span>
                          <span className="meta-icon">◇</span>
                          <span className="folder-name">{sName}</span>
                          <span className="folder-count">{tbls.length}</span>
                        </div>
                        {sOpen && (
                          <ul className="query-list" role="group">
                            {tbls.map((tbl) => (
                              <li key={tbl} className="folder meta-sub2" role="treeitem">
                                <div
                                  className="folder-row leaf"
                                  title={`${cName}.${sName}.${tbl}`}
                                >
                                  <span className="caret-blank" />
                                  <span className="meta-icon table">▦</span>
                                  <span className="folder-name">{tbl}</span>
                                  <div className="row-actions">
                                    <button
                                      className="mini"
                                      title="등록 해제 · 메타데이터에서 제거"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        onUnregister(cName, sName, tbl)
                                      }}
                                    >
                                      <IconTrash size={12} />
                                    </button>
                                  </div>
                                </div>
                              </li>
                            ))}
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
      </ul>
    </div>
  )
}
