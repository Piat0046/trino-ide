import { useCallback, useEffect, useState } from 'react'
import type {
  HistoryEntry,
  HostConfig,
  HostInput,
  QueryFolder,
  QueryResultPayload,
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
import { IconPlus } from './components/icons'

const api = window.api

const DEFAULT_SQL = 'SELECT 1'
const EMPTY_LIBRARY: SavedLibrary = { folders: [], queries: [] }

interface PromptConfig {
  title: string
  initialValue?: string
  placeholder?: string
  onSubmit: (value: string) => void | Promise<void>
}

export default function App(): JSX.Element {
  const [hosts, setHosts] = useState<HostConfig[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [section, setSection] = useState<ExplorerSection>('connections')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostConfig | null>(null)

  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [library, setLibrary] = useState<SavedLibrary>(EMPTY_LIBRARY)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [promptState, setPromptState] = useState<PromptConfig | null>(null)
  const [rowLimit, setRowLimit] = useState<number | null>(300)

  const [sql, setSql] = useState(DEFAULT_SQL)
  const [loaded, setLoaded] = useState<{ name: string; sql: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResultPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  // 페이지 이동 재실행에 쓸, 마지막으로 "실행한" 쿼리(에디터 편집과 무관)
  const [lastRun, setLastRun] = useState<{ sql: string; hostId: string } | null>(null)

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
    setSelectedHostId(saved.id)
  }
  const handleDeleteHost = async (h: HostConfig): Promise<void> => {
    await api.deleteHost(h.id)
    setSelectedHostId((cur) => (cur === h.id ? null : cur))
    await refreshHosts()
  }

  // ----- query execution -----
  const executeQuery = async (
    sqlText: string,
    hostId: string,
    page: number,
    recordHistory: boolean
  ): Promise<void> => {
    if (running) return
    const id = crypto.randomUUID()
    setRequestId(id)
    setRunning(true)
    setError(null)
    try {
      const res = await api.runQuery({ hostId, sql: sqlText, requestId: id, rowLimit, page, recordHistory })
      if (res.ok) setResult(res.value)
      else {
        setError(res.error)
        setResult(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    } finally {
      setRunning(false)
      setRequestId(null)
      if (recordHistory) void refreshHistory()
    }
  }

  const runFresh = (sqlText: string, hostId: string): void => {
    setLastRun({ sql: sqlText, hostId })
    void executeQuery(sqlText, hostId, 0, true)
  }

  const runQuery = (): void => {
    if (selectedHostId) runFresh(sql, selectedHostId)
  }
  const cancelQuery = async (): Promise<void> => {
    if (requestId) await api.cancelQuery(requestId)
  }
  const goToPage = (page: number): void => {
    if (lastRun && page >= 0) void executeQuery(lastRun.sql, lastRun.hostId, page, false)
  }

  // ----- editor / tab -----
  const onSqlChange = (value: string): void => setSql(value)
  const loadIntoEditor = (name: string | null, sqlText: string): void => {
    setSql(sqlText)
    setLoaded(name ? { name, sql: sqlText } : null)
  }
  const dirty = loaded !== null && sql !== loaded.sql
  const queryName = loaded?.name ?? null

  // ----- history actions -----
  const loadHistory = (entry: HistoryEntry): void => {
    loadIntoEditor(null, entry.sql)
    if (hosts.some((h) => h.id === entry.hostId)) setSelectedHostId(entry.hostId)
  }
  const runHistory = (entry: HistoryEntry): void => {
    loadIntoEditor(null, entry.sql)
    if (hosts.some((h) => h.id === entry.hostId)) setSelectedHostId(entry.hostId)
    runFresh(entry.sql, entry.hostId)
  }
  const deleteHistory = async (id: string): Promise<void> => {
    await api.deleteHistory(id)
    await refreshHistory()
  }
  const clearHistory = async (): Promise<void> => {
    if (history.length && window.confirm('실행 기록을 모두 지울까요?')) {
      await api.clearHistory()
      await refreshHistory()
    }
  }

  // ----- saved query actions (window.prompt 미지원 → 모달) -----
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
  const deleteFolder = async (folder: QueryFolder): Promise<void> => {
    if (!window.confirm(`'${folder.name}' 폴더와 그 안의 쿼리를 모두 삭제할까요?`)) return
    await api.deleteFolder(folder.id)
    await refreshSaved()
  }
  const addQueryToFolder = (folder: QueryFolder): void => {
    if (!sql.trim()) {
      window.alert('에디터가 비어 있습니다.')
      return
    }
    askName({
      title: `'${folder.name}'에 쿼리 저장`,
      placeholder: '쿼리 이름',
      onSubmit: async (name) => {
        await api.createQuery({ folderId: folder.id, name, sql })
        await refreshSaved()
        setLoaded({ name, sql })
      }
    })
  }
  const loadSaved = (q: SavedQuery): void => loadIntoEditor(q.name, q.sql)
  const runSaved = (q: SavedQuery): void => {
    loadIntoEditor(q.name, q.sql)
    if (selectedHostId) runFresh(q.sql, selectedHostId)
    else window.alert('먼저 연결을 선택하세요.')
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
  const deleteSaved = async (q: SavedQuery): Promise<void> => {
    if (!window.confirm(`'${q.name}' 쿼리를 삭제할까요?`)) return
    await api.deleteQuery(q.id)
    await refreshSaved()
  }
  const handleSaveQuery = async (res: SaveQueryResult): Promise<void> => {
    let folderId = res.folderId
    if (res.newFolderName) folderId = (await api.createFolder(res.newFolderName)).id
    if (!folderId) return
    await api.createQuery({ folderId, name: res.name, sql })
    await refreshSaved()
    setLoaded({ name: res.name, sql })
    setSaveDialogOpen(false)
    setSection('saved')
  }

  const selectedHost = hosts.find((h) => h.id === selectedHostId) ?? null

  const explorerHeader = (): JSX.Element => {
    if (section === 'connections') {
      return (
        <div className="explorer-header">
          <span className="explorer-title">Connections</span>
          <div className="explorer-actions">
            <button className="icon-btn" title="연결 추가" onClick={openAdd}>
              <IconPlus size={15} />
            </button>
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
          </div>
        </div>
      )
    }
    return (
      <div className="explorer-header">
        <span className="explorer-title">History</span>
        <div className="explorer-actions">
          <button className="icon-btn" title="전체 삭제" disabled={history.length === 0} onClick={clearHistory}>
            ⌫
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="app-body">
        <ActivityRail active={section} onChange={setSection} />
        <aside className="explorer">
          {explorerHeader()}
          {section === 'connections' && (
            <HostList
              hosts={hosts}
              selectedHostId={selectedHostId}
              onSelect={setSelectedHostId}
              onEdit={openEdit}
              onDelete={handleDeleteHost}
            />
          )}
          {section === 'saved' && (
            <SavedPanel
              library={library}
              onRenameFolder={renameFolder}
              onDeleteFolder={deleteFolder}
              onAddQuery={addQueryToFolder}
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

        <div className="workspace">
          <SqlEditor
            sql={sql}
            onChange={onSqlChange}
            onRun={runQuery}
            onCancel={cancelQuery}
            onSave={() => setSaveDialogOpen(true)}
            running={running}
            hosts={hosts}
            selectedHostId={selectedHostId}
            onSelectHost={setSelectedHostId}
            rowLimit={rowLimit}
            onRowLimitChange={changeRowLimit}
            queryName={queryName}
            dirty={dirty}
          />
          <ResultsPane
            result={result}
            error={error}
            running={running}
            onPrevPage={() => result && goToPage(result.page - 1)}
            onNextPage={() => result && goToPage(result.page + 1)}
          />
        </div>
      </div>

      <StatusBar selectedHost={selectedHost} running={running} result={result} error={error} />

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
          sqlPreview={sql}
          onClose={() => setSaveDialogOpen(false)}
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
    </div>
  )
}
