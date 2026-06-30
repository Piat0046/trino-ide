import { useState } from 'react'
import type { QueryFolder, SavedLibrary, SavedQuery } from '@shared/types'

interface Props {
  library: SavedLibrary
  onRenameFolder: (folder: QueryFolder) => void
  onDeleteFolder: (folder: QueryFolder) => void
  /** 현재 에디터 SQL을 이 폴더에 새 쿼리로 저장 */
  onAddQuery: (folder: QueryFolder) => void
  onLoadQuery: (q: SavedQuery) => void
  onRunQuery: (q: SavedQuery) => void
  onRenameQuery: (q: SavedQuery) => void
  onDeleteQuery: (q: SavedQuery) => void
}

export function SavedPanel({
  library,
  onRenameFolder,
  onDeleteFolder,
  onAddQuery,
  onLoadQuery,
  onRunQuery,
  onRenameQuery,
  onDeleteQuery
}: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const queriesOf = (folderId: string): SavedQuery[] =>
    library.queries.filter((q) => q.folderId === folderId)

  return (
    <div className="panel">
      <ul className="list">
        {library.folders.length === 0 && (
          <li className="empty">
            폴더가 없습니다.
            <br />
            상단 + 로 폴더를 만드세요.
          </li>
        )}
        {library.folders.map((folder) => {
          const isCollapsed = collapsed.has(folder.id)
          const queries = queriesOf(folder.id)
          return (
            <li key={folder.id} className="folder">
              <div className="folder-row" onClick={() => toggle(folder.id)}>
                <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                <span className="folder-name">{folder.name}</span>
                <span className="folder-count">{queries.length}</span>
                <div className="row-actions">
                  <button
                    title="이 폴더에 새 쿼리 만들기 (빈 SQL)"
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddQuery(folder)
                    }}
                  >
                    ＋쿼리
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onRenameFolder(folder)
                    }}
                  >
                    이름
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteFolder(folder)
                    }}
                  >
                    삭제
                  </button>
                </div>
              </div>
              {!isCollapsed && (
                <ul className="query-list">
                  {queries.length === 0 && <li className="empty small">비어 있음</li>}
                  {queries.map((q) => (
                    <li
                      key={q.id}
                      className="query-row"
                      onClick={() => onLoadQuery(q)}
                      onDoubleClick={() => onRunQuery(q)}
                      title="클릭: 탭으로 열기 · 더블클릭: 실행"
                    >
                      <span className="dot" />
                      <span className="query-name">{q.name}</span>
                      <div className="row-actions">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onRunQuery(q)
                          }}
                        >
                          실행
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onRenameQuery(q)
                          }}
                        >
                          이름
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onDeleteQuery(q)
                          }}
                        >
                          삭제
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
    </div>
  )
}
