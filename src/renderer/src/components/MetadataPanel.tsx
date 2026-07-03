import { useState } from 'react'
import type { HostConfig, HostMetadata, MetadataRef } from '@shared/types'
import { IconChevronDown, IconChevronRight, IconPlus, IconSearch, IconTrash } from './icons'

interface Props {
  hosts: HostConfig[]
  /** 표시 대상 host (없으면 안내) */
  hostId: string | null
  metadata: HostMetadata | null
  onSelectHost: (id: string) => void
  onAddSchema: (catalog: string) => void
  onAddTable: (catalog: string, schema: string) => void
  onAddColumn: (catalog: string, schema: string, table: string) => void
  onDelete: (ref: MetadataRef, label: string) => void
}

/**
 * 성공 쿼리에서 학습한(또는 수동 추가한) catalog → schema → table 트리.
 * SavedPanel의 폴더/쿼리 트리 패턴을 3단계로 확장해 미러링한다.
 */
export function MetadataPanel({
  hosts,
  hostId,
  metadata,
  onSelectHost,
  onAddSchema,
  onAddTable,
  onAddColumn,
  onDelete
}: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const q = query.trim().toLowerCase()
  const hit = (s: string): boolean => !q || s.toLowerCase().includes(q)

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
        <div className="empty">연결을 선택하면 학습된 메타데이터가 표시됩니다.</div>
      </div>
    )
  }

  const catalogs = metadata ? Object.entries(metadata.catalogs) : []

  return (
    <div className="panel">
      {hostSelect}
      <div className="meta-search">
        <IconSearch size={13} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="catalog·schema·table 검색…"
        />
      </div>
      <ul className="list">
        {catalogs.length === 0 && (
          <li className="empty">
            아직 학습된 메타데이터가 없습니다.
            <br />
            쿼리를 성공적으로 실행하면 이 서버의 catalog·schema·table이 자동으로 쌓입니다.
          </li>
        )}
        {catalogs.map(([catName, cat]) => {
          const schemas = Object.entries(cat.schemas)
          const catVisible =
            hit(catName) ||
            schemas.some(([sn, s]) => hit(sn) || Object.keys(s.tables).some(hit))
          if (!catVisible) return null
          const cKey = catName
          const cOpen = !collapsed.has(cKey) || !!q
          return (
            <li key={cKey} className="folder">
              <div className="folder-row" onClick={() => toggle(cKey)}>
                <span className="caret">
                  {cOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                </span>
                <span className={'meta-icon' + (cat.source === 'manual' ? ' manual' : '')}>▤</span>
                <span className="folder-name">{catName}</span>
                {cat.source === 'manual' && <span className="meta-badge">수동</span>}
                <span className="folder-count">{schemas.length}</span>
                <div className="row-actions">
                  <button
                    className="mini"
                    title="스키마 추가(수동)"
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddSchema(catName)
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                  <button
                    title="삭제"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete({ catalog: catName }, catName)
                    }}
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              </div>
              {cOpen && (
                <ul className="query-list">
                  {schemas.length === 0 && <li className="empty small">비어 있음</li>}
                  {schemas.map(([schName, sch]) => {
                    const tables = Object.entries(sch.tables)
                    const schVisible =
                      hit(catName) || hit(schName) || tables.some(([tn]) => hit(tn))
                    if (!schVisible) return null
                    const sKey = catName + ' ' + schName
                    const sOpen = !collapsed.has(sKey) || !!q
                    return (
                      <li key={sKey} className="folder meta-sub">
                        <div className="folder-row" onClick={() => toggle(sKey)}>
                          <span className="caret">
                            {sOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                          </span>
                          <span
                            className={'meta-icon' + (sch.source === 'manual' ? ' manual' : '')}
                          >
                            ◇
                          </span>
                          <span className="folder-name">{schName}</span>
                          {sch.source === 'manual' && <span className="meta-badge">수동</span>}
                          <span className="folder-count">{tables.length}</span>
                          <div className="row-actions">
                            <button
                              className="mini"
                              title="테이블 추가(수동)"
                              onClick={(e) => {
                                e.stopPropagation()
                                onAddTable(catName, schName)
                              }}
                            >
                              <IconPlus size={12} />
                            </button>
                            <button
                              title="삭제"
                              onClick={(e) => {
                                e.stopPropagation()
                                onDelete({ catalog: catName, schema: schName }, schName)
                              }}
                            >
                              <IconTrash size={12} />
                            </button>
                          </div>
                        </div>
                        {sOpen && (
                          <ul className="query-list">
                            {tables.length === 0 && <li className="empty small">비어 있음</li>}
                            {tables
                              .filter(
                                ([tn, tb]) =>
                                  hit(catName) ||
                                  hit(schName) ||
                                  hit(tn) ||
                                  (tb.columns ?? []).some((c) => hit(c.name))
                              )
                              .map(([tblName, tbl]) => {
                                const cols = tbl.columns ?? []
                                const hasCols = cols.length > 0
                                const tKey = catName + ' ' + schName + ' ' + tblName
                                const tOpen = !collapsed.has(tKey) || !!q
                                return (
                                  <li key={tblName} className="folder meta-sub2">
                                    <div
                                      className="folder-row"
                                      title={`${catName}.${schName}.${tblName}`}
                                      onClick={() => hasCols && toggle(tKey)}
                                    >
                                      <span className="caret">
                                        {hasCols ? (
                                          tOpen ? (
                                            <IconChevronDown size={12} />
                                          ) : (
                                            <IconChevronRight size={12} />
                                          )
                                        ) : (
                                          <span className="caret-blank" />
                                        )}
                                      </span>
                                      <span className="meta-icon table">▦</span>
                                      <span className="folder-name">{tblName}</span>
                                      {tbl.source === 'manual' ? (
                                        <span className="meta-badge">수동</span>
                                      ) : tbl.count > 0 ? (
                                        <span className="meta-freq">{tbl.count}×</span>
                                      ) : null}
                                      {hasCols && <span className="folder-count">{cols.length}</span>}
                                      <div className="row-actions">
                                        <button
                                          className="mini"
                                          title="컬럼 추가(수동)"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            onAddColumn(catName, schName, tblName)
                                          }}
                                        >
                                          <IconPlus size={12} />
                                        </button>
                                        <button
                                          title="삭제"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            onDelete(
                                              { catalog: catName, schema: schName, table: tblName },
                                              tblName
                                            )
                                          }}
                                        >
                                          <IconTrash size={12} />
                                        </button>
                                      </div>
                                    </div>
                                    {hasCols && tOpen && (
                                      <ul className="query-list">
                                        {cols
                                          .filter(
                                            (c) =>
                                              hit(catName) ||
                                              hit(schName) ||
                                              hit(tblName) ||
                                              hit(c.name)
                                          )
                                          .map((c) => (
                                            <li
                                              key={c.name}
                                              className="query-row meta-col"
                                              title={`${c.name} ${c.type}`}
                                            >
                                              <span className="meta-icon col">│</span>
                                              <span className="query-name">{c.name}</span>
                                              {c.type && <span className="meta-coltype">{c.type}</span>}
                                              {c.source === 'manual' && (
                                                <span className="meta-badge">수동</span>
                                              )}
                                              <div className="row-actions">
                                                <button
                                                  title="삭제"
                                                  onClick={(e) => {
                                                    e.stopPropagation()
                                                    onDelete(
                                                      {
                                                        catalog: catName,
                                                        schema: schName,
                                                        table: tblName,
                                                        column: c.name
                                                      },
                                                      c.name
                                                    )
                                                  }}
                                                >
                                                  <IconTrash size={12} />
                                                </button>
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
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
