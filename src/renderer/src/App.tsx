import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type {
  HistoryEntry,
  HostConfig,
  HostInput,
  QueryFolder,
  SavedLibrary,
  SavedQuery
} from '@shared/types'
import { ActivityRail, type ExplorerSection } from './components/ActivityRail'
import { HostList } from './components/HostList'
import { HistoryList } from './components/HistoryList'
import { SavedPanel } from './components/SavedPanel'
import { HostDialog } from './components/HostDialog'
import { SqlEditor } from './components/SqlEditor'
import { ResultsPane } from './components/ResultsPane'
import { StatusBar } from './components/StatusBar'
import { SaveQueryDialog, type SaveQueryResult } from './components/SaveQueryDialog'
import { PromptDialog } from './components/PromptDialog'
import { CloseTabDialog } from './components/CloseTabDialog'
import { ConfirmDialog, type ConfirmConfig } from './components/ConfirmDialog'
import { IconChevronLeft, IconPlus, IconTrash } from './components/icons'
import { type EditorTab, isDirty, makeBound, makeScratch, nextUntitled } from './lib/tabs'

const api = window.api

const EMPTY_LIBRARY: SavedLibrary = { folders: [], queries: [] }

// explorer 사이드바 크기 범위
const MIN_EXPLORER = 190
const MAX_EXPLORER = 460
const DEFAULT_EXPLORER = 264

interface PromptConfig {
  title: string
  initialValue?: string
  placeholder?: string
  onSubmit: (value: string) => void | Promise<void>
}

export default function App(): JSX.Element {
  const [hosts, setHosts] = useState<HostConfig[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [section, setSection] = useState<ExplorerSection>('saved')
  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('explorerWidth'))
    return Number.isFinite(v) && v >= MIN_EXPLORER && v <= MAX_EXPLORER ? v : DEFAULT_EXPLORER
  })
  const [explorerCollapsed, setExplorerCollapsed] = useState<boolean>(
    () => localStorage.getItem('explorerCollapsed') === '1'
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostConfig | null>(null)

  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [library, setLibrary] = useState<SavedLibrary>(EMPTY_LIBRARY)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [promptState, setPromptState] = useState<PromptConfig | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmConfig | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const askConfirm = (cfg: ConfirmConfig): void => setConfirmState(cfg)
  const [rowLimit, setRowLimit] = useState<number | null>(300)

  // ----- 멀티 탭 -----
  const [tabs, setTabs] = useState<EditorTab[]>(() => [
    makeScratch('', null, 'Untitled query 1')
  ])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [closingTabId, setClosingTabId] = useState<string | null>(null)
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  const activeId = activeTab?.id ?? ''

  const updateTab = useCallback((id: string, patch: Partial<EditorTab>): void => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const tabTitle = (t: EditorTab): string =>
    t.savedQueryId ? (library.queries.find((q) => q.id === t.savedQueryId)?.name ?? t.title) : t.title

  // ----- refresh -----
  const refreshHosts = useCallback(async () => {
    const list = await api.listHosts()
    setHosts(list)
    setSelectedHostId((cur) => cur ?? list[0]?.id ?? null)
  }, [])
  const refreshHistory = useCallback(async () => setHistory(await api.listHistory()), [])
  const refreshSaved = useCallback(async () => setLibrary(await api.listSaved()), [])

  useEffect(() => {
    void refreshHosts()
    void refreshHistory()
    void refreshSaved()
    void api.getSettings().then((s) => setRowLimit(s.rowLimit))
  }, [refreshHosts, refreshHistory, refreshSaved])

  // 실행 진행 stats 스트리밍 → 해당 requestId 탭에 반영
  useEffect(() => {
    return api.onQueryProgress((p) => {
      setTabs((prev) =>
        prev.map((t) => (t.requestId === p.requestId ? { ...t, progress: p.stats } : t))
      )
    })
  }, [])

  // 토스트 자동 소멸
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(t)
  }, [toast])

  // ⌘1..9 로 해당 순번 탭 전환
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1
        if (idx < tabs.length) {
          e.preventDefault()
          setActiveTabId(tabs[idx].id)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tabs])

  // host가 로드되면 hostId 없는 탭에 기본 연결 채움
  useEffect(() => {
    if (!selectedHostId) return
    setTabs((prev) => prev.map((t) => (t.hostId ? t : { ...t, hostId: selectedHostId })))
  }, [selectedHostId])

  // library 변경 시: 삭제된 저장 쿼리에 바인딩된 탭은 스크래치로 변환(작업 보존)
  useEffect(() => {
    setTabs((prev) =>
      prev.map((t) =>
        t.savedQueryId && !library.queries.some((q) => q.id === t.savedQueryId)
          ? { ...t, savedQueryId: null, baseSql: '' }
          : t
      )
    )
  }, [library])

  const changeRowLimit = (limit: number | null): void => {
    setRowLimit(limit)
    void api.updateSettings({ rowLimit: limit })
  }

  // ----- host CRUD -----
  const openAdd = (): void => {
    setEditingHost(null)
    setDialogOpen(true)
  }
  const openEdit = (h: HostConfig): void => {
    setEditingHost(h)
    setDialogOpen(true)
  }
  const handleSaveHost = async (input: HostInput): Promise<void> => {
    const saved = await api.saveHost(input)
    setDialogOpen(false)
    await refreshHosts()
    selectHost(saved.id)
  }
  const handleDeleteHost = (h: HostConfig): void =>
    askConfirm({
      title: '연결 삭제',
      message: `'${h.name}' 연결을 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true,
      onConfirm: async () => {
        await api.deleteHost(h.id)
        setSelectedHostId((cur) => (cur === h.id ? null : cur))
        await refreshHosts()
      }
    })

  const selectHost = (id: string): void => {
    if (activeId) updateTab(activeId, { hostId: id })
    setSelectedHostId(id)
  }

  // ----- 탭 조작 -----
  const newScratchTab = (): void => {
    const name = nextUntitled(tabs.map((t) => t.title))
    const tab = makeScratch('', activeTab?.hostId ?? selectedHostId, name)
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  /** 저장 쿼리를 탭으로 연다(이미 열려 있으면 그 탭 포커스). 연 탭을 반환 */
  const openSaved = (q: SavedQuery): EditorTab => {
    const existing = tabs.find((t) => t.savedQueryId === q.id)
    if (existing) {
      setActiveTabId(existing.id)
      return existing
    }
    const tab = makeBound(q, selectedHostId)
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
    return tab
  }

  const doCloseTab = (id: string): void => {
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    if (next.length === 0) {
      const fresh = makeScratch('', selectedHostId, 'Untitled query 1')
      setTabs([fresh])
      setActiveTabId(fresh.id)
      return
    }
    setTabs(next)
    if (activeId === id) setActiveTabId(next[Math.min(idx, next.length - 1)].id)
  }

  const closeTab = (id: string): void => {
    const t = tabs.find((x) => x.id === id)
    if (!t) return
    if (isDirty(t)) setClosingTabId(id)
    else doCloseTab(id)
  }

  // ----- query execution (탭별) -----
  const executeQuery = async (
    tabId: string,
    sqlText: string,
    hostId: string,
    page: number,
    recordHistory: boolean
  ): Promise<void> => {
    const id = crypto.randomUUID()
    updateTab(tabId, { running: true, requestId: id, error: null, errorInfo: null, progress: null })
    try {
      const res = await api.runQuery({ hostId, sql: sqlText, requestId: id, rowLimit, page, recordHistory })
      if (res.ok) updateTab(tabId, { result: res.value, error: null, errorInfo: null })
      else updateTab(tabId, { error: res.error, errorInfo: res.errorInfo ?? null, result: null })
    } catch (e) {
      updateTab(tabId, { error: e instanceof Error ? e.message : String(e), result: null })
    } finally {
      updateTab(tabId, { running: false, requestId: null, progress: null })
      if (recordHistory) void refreshHistory()
    }
  }

  const runFresh = (tabId: string, sqlText: string, hostId: string): void => {
    updateTab(tabId, { lastRun: { sql: sqlText, hostId } })
    void executeQuery(tabId, sqlText, hostId, 0, true)
  }

  const runQuery = (sqlToRun: string): void => {
    const t = activeTab
    if (!t || t.running) return
    if (!t.hostId) {
      setToast('연결을 먼저 선택하세요.')
      return
    }
    if (!sqlToRun.trim()) {
      setToast('실행할 SQL이 없습니다.')
      return
    }
    runFresh(t.id, sqlToRun, t.hostId)
  }
  const cancelQuery = async (): Promise<void> => {
    if (activeTab?.requestId) await api.cancelQuery(activeTab.requestId)
  }
  const goToPage = (page: number): void => {
    const t = activeTab
    if (!t?.lastRun || page < 0) return
    void executeQuery(t.id, t.lastRun.sql, t.lastRun.hostId, page, false)
  }

  // ----- 저장(💾) -----
  const onSave = async (): Promise<void> => {
    const t = activeTab
    if (!t) return
    if (t.savedQueryId) {
      await api.updateQuery({ id: t.savedQueryId, sql: t.sql })
      updateTab(t.id, { baseSql: t.sql })
      await refreshSaved()
    } else {
      setSaveDialogOpen(true)
    }
  }
  const handleSaveQuery = async (res: SaveQueryResult): Promise<void> => {
    const t = activeTab
    if (!t) return
    let folderId = res.folderId
    if (res.newFolderName) folderId = (await api.createFolder(res.newFolderName)).id
    if (!folderId) return
    const created = await api.createQuery({ folderId, name: res.name, sql: t.sql })
    await refreshSaved()
    updateTab(t.id, { savedQueryId: created.id, title: res.name, baseSql: t.sql })
    setSaveDialogOpen(false)
    setSection('saved')
    if (pendingCloseTabId === t.id) {
      doCloseTab(t.id)
      setPendingCloseTabId(null)
    }
  }

  // ----- 닫기 확인 모달 동작 -----
  const closingTab = tabs.find((t) => t.id === closingTabId) ?? null
  const confirmDiscard = (): void => {
    if (closingTabId) doCloseTab(closingTabId)
    setClosingTabId(null)
  }
  const confirmSave = async (): Promise<void> => {
    const t = closingTab
    setClosingTabId(null)
    if (!t) return
    if (t.savedQueryId) {
      await api.updateQuery({ id: t.savedQueryId, sql: t.sql })
      updateTab(t.id, { baseSql: t.sql })
      await refreshSaved()
      doCloseTab(t.id)
    } else {
      // 스크래치 → 다른 이름으로 저장 후 닫기
      setActiveTabId(t.id)
      setPendingCloseTabId(t.id)
      setSaveDialogOpen(true)
    }
  }

  // ----- history actions (항상 새 스크래치 탭) -----
  const openHistoryTab = (entry: HistoryEntry): EditorTab => {
    const hostId = hosts.some((h) => h.id === entry.hostId) ? entry.hostId : selectedHostId
    const tab = makeScratch(entry.sql, hostId, nextUntitled(tabs.map((t) => t.title)))
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
    return tab
  }
  const loadHistory = (entry: HistoryEntry): void => {
    openHistoryTab(entry)
  }
  const runHistory = (entry: HistoryEntry): void => {
    const tab = openHistoryTab(entry)
    if (tab.hostId) runFresh(tab.id, tab.sql, tab.hostId)
  }
  const deleteHistory = async (id: string): Promise<void> => {
    await api.deleteHistory(id)
    await refreshHistory()
  }
  const clearHistory = (): void => {
    if (!history.length) return
    askConfirm({
      title: '실행 기록 삭제',
      message: '모든 실행 기록을 지웁니다. 되돌릴 수 없습니다.',
      confirmLabel: '전체 삭제',
      danger: true,
      onConfirm: async () => {
        await api.clearHistory()
        await refreshHistory()
      }
    })
  }

  // ----- saved query actions -----
  const askName = (cfg: PromptConfig): void => setPromptState(cfg)
  const createFolder = (): void =>
    askName({
      title: '새 폴더',
      placeholder: '폴더 이름',
      onSubmit: async (name) => {
        await api.createFolder(name)
        await refreshSaved()
      }
    })
  const renameFolder = (folder: QueryFolder): void =>
    askName({
      title: '폴더 이름 변경',
      initialValue: folder.name,
      onSubmit: async (name) => {
        if (name === folder.name) return
        await api.renameFolder(folder.id, name)
        await refreshSaved()
      }
    })
  const deleteFolder = (folder: QueryFolder): void =>
    askConfirm({
      title: '폴더 삭제',
      message: `'${folder.name}' 폴더와 그 안의 쿼리를 모두 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true,
      onConfirm: async () => {
        await api.deleteFolder(folder.id)
        await refreshSaved()
      }
    })
  // 폴더에 빈 SQL 새 쿼리 생성 후 그 탭 열기
  const createQueryInFolder = async (folder: QueryFolder): Promise<void> => {
    const taken = [...tabs.map((t) => t.title), ...library.queries.map((q) => q.name)]
    const created = await api.createQuery({ folderId: folder.id, name: nextUntitled(taken), sql: '' })
    await refreshSaved()
    setSection('saved')
    openSaved(created)
  }
  const loadSaved = (q: SavedQuery): void => {
    openSaved(q)
  }
  const runSaved = (q: SavedQuery): void => {
    const tab = openSaved(q)
    const hostId = tab.hostId ?? selectedHostId
    if (!hostId) {
      setToast('먼저 연결을 선택하세요.')
      return
    }
    runFresh(tab.id, tab.sql, hostId)
  }
  const renameSaved = (q: SavedQuery): void =>
    askName({
      title: '쿼리 이름 변경',
      initialValue: q.name,
      onSubmit: async (name) => {
        if (name === q.name) return
        await api.updateQuery({ id: q.id, name })
        await refreshSaved()
      }
    })
  const deleteSaved = (q: SavedQuery): void =>
    askConfirm({
      title: '쿼리 삭제',
      message: `'${q.name}' 쿼리를 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true,
      onConfirm: async () => {
        await api.deleteQuery(q.id)
        await refreshSaved()
      }
    })

  const activeHostId = activeTab?.hostId ?? null
  const selectedHost = hosts.find((h) => h.id === activeHostId) ?? null
  const tabViews = tabs.map((t) => ({ id: t.id, title: tabTitle(t), dirty: isDirty(t) }))

  // 사이드바 크기/접힘 상태 영속화(localStorage)
  useEffect(() => {
    localStorage.setItem('explorerWidth', String(explorerWidth))
  }, [explorerWidth])
  useEffect(() => {
    localStorage.setItem('explorerCollapsed', explorerCollapsed ? '1' : '0')
  }, [explorerCollapsed])

  // 레일 아이콘: 접힌 상태면 펼치고, 같은 섹션을 다시 누르면 접는다(VS Code 관례)
  const onRailChange = (next: ExplorerSection): void => {
    if (explorerCollapsed) {
      setExplorerCollapsed(false)
      setSection(next)
    } else if (next === section) {
      setExplorerCollapsed(true)
    } else {
      setSection(next)
    }
  }

  // 스플리터 드래그로 explorer 너비 조절(min/max 범위)
  const startExplorerResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = explorerWidth
    const move = (ev: MouseEvent): void => {
      const w = Math.min(MAX_EXPLORER, Math.max(MIN_EXPLORER, startW + (ev.clientX - startX)))
      setExplorerWidth(w)
    }
    const end = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      document.body.classList.remove('col-resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    document.body.classList.add('col-resizing')
  }

  const explorerHeader = (): JSX.Element => {
    const collapseBtn = (
      <button className="icon-btn" title="사이드바 접기" onClick={() => setExplorerCollapsed(true)}>
        <IconChevronLeft size={15} />
      </button>
    )
    if (section === 'connections') {
      return (
        <div className="explorer-header">
          <span className="explorer-title">Connections</span>
          <div className="explorer-actions">
            <button className="icon-btn" title="연결 추가" onClick={openAdd}>
              <IconPlus size={15} />
            </button>
            {collapseBtn}
          </div>
        </div>
      )
    }
    if (section === 'saved') {
      return (
        <div className="explorer-header">
          <span className="explorer-title">Saved Queries</span>
          <div className="explorer-actions">
            <button className="icon-btn" title="새 폴더" onClick={createFolder}>
              <IconPlus size={15} />
            </button>
            {collapseBtn}
          </div>
        </div>
      )
    }
    return (
      <div className="explorer-header">
        <span className="explorer-title">History</span>
        <div className="explorer-actions">
          <button className="icon-btn" title="전체 삭제" disabled={history.length === 0} onClick={clearHistory}>
            <IconTrash size={15} />
          </button>
          {collapseBtn}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="app-body">
        <ActivityRail active={section} collapsed={explorerCollapsed} onChange={onRailChange} />
        {!explorerCollapsed && (
        <aside className="explorer" style={{ width: explorerWidth }}>
          {explorerHeader()}
          {section === 'connections' && (
            <HostList
              hosts={hosts}
              selectedHostId={activeHostId}
              onSelect={selectHost}
              onEdit={openEdit}
              onDelete={handleDeleteHost}
            />
          )}
          {section === 'saved' && (
            <SavedPanel
              library={library}
              onRenameFolder={renameFolder}
              onDeleteFolder={deleteFolder}
              onAddQuery={createQueryInFolder}
              onLoadQuery={loadSaved}
              onRunQuery={runSaved}
              onRenameQuery={renameSaved}
              onDeleteQuery={deleteSaved}
            />
          )}
          {section === 'history' && (
            <HistoryList
              history={history}
              liveHostIds={new Set(hosts.map((h) => h.id))}
              onLoad={loadHistory}
              onRun={runHistory}
              onDelete={deleteHistory}
            />
          )}
        </aside>
        )}
        {!explorerCollapsed && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            title="드래그로 크기 조절 · 더블클릭으로 접기"
            onMouseDown={startExplorerResize}
            onDoubleClick={() => setExplorerCollapsed(true)}
          />
        )}

        <div className="workspace">
          <SqlEditor
            tabs={tabViews}
            activeTabId={activeId}
            onSelectTab={setActiveTabId}
            onCloseTab={closeTab}
            onNewTab={newScratchTab}
            sql={activeTab?.sql ?? ''}
            onChange={(v) => activeId && updateTab(activeId, { sql: v })}
            onRun={runQuery}
            onCancel={cancelQuery}
            onSave={onSave}
            running={activeTab?.running ?? false}
            isScratch={activeTab ? activeTab.savedQueryId === null : true}
            hosts={hosts}
            hostId={activeHostId}
            onSelectHost={selectHost}
            rowLimit={rowLimit}
            onRowLimitChange={changeRowLimit}
          />
          <ResultsPane
            result={activeTab?.result ?? null}
            error={activeTab?.error ?? null}
            errorInfo={activeTab?.errorInfo ?? null}
            running={activeTab?.running ?? false}
            progress={activeTab?.progress ?? null}
            onCancel={cancelQuery}
            onPrevPage={() => activeTab?.result && goToPage(activeTab.result.page - 1)}
            onNextPage={() => activeTab?.result && goToPage(activeTab.result.page + 1)}
          />
        </div>
      </div>

      <StatusBar
        selectedHost={selectedHost}
        running={activeTab?.running ?? false}
        result={activeTab?.result ?? null}
        error={activeTab?.error ?? null}
      />

      {dialogOpen && (
        <HostDialog
          host={editingHost}
          onClose={() => setDialogOpen(false)}
          onSave={handleSaveHost}
          onTest={api.testHost}
        />
      )}
      {saveDialogOpen && (
        <SaveQueryDialog
          folders={library.folders}
          sqlPreview={activeTab?.sql ?? ''}
          onClose={() => {
            setSaveDialogOpen(false)
            setPendingCloseTabId(null)
          }}
          onSave={handleSaveQuery}
        />
      )}
      {promptState && (
        <PromptDialog
          title={promptState.title}
          initialValue={promptState.initialValue}
          placeholder={promptState.placeholder}
          onClose={() => setPromptState(null)}
          onSubmit={async (value) => {
            await promptState.onSubmit(value)
            setPromptState(null)
          }}
        />
      )}
      {closingTab && (
        <CloseTabDialog
          tabTitle={tabTitle(closingTab)}
          onSave={confirmSave}
          onDiscard={confirmDiscard}
          onCancel={() => setClosingTabId(null)}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          {...confirmState}
          onCancel={() => setConfirmState(null)}
          onConfirm={() => {
            confirmState.onConfirm()
            setConfirmState(null)
          }}
        />
      )}
      {toast && <div className="app-toast">{toast}</div>}
    </div>
  )
}
