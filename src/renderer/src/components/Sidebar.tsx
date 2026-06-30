import type { HistoryEntry, HostConfig, QueryFolder, SavedLibrary, SavedQuery } from '@shared/types'
import { HostList } from './HostList'
import { HistoryList } from './HistoryList'
import { SavedPanel } from './SavedPanel'

export type SidebarTab = 'hosts' | 'history' | 'saved'

interface Props {
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void

  // hosts
  hosts: HostConfig[]
  selectedHostId: string | null
  onSelectHost: (id: string) => void
  onAddHost: () => void
  onEditHost: (h: HostConfig) => void
  onDeleteHost: (h: HostConfig) => void

  // history
  history: HistoryEntry[]
  onLoadHistory: (entry: HistoryEntry) => void
  onRunHistory: (entry: HistoryEntry) => void
  onDeleteHistory: (id: string) => void
  onClearHistory: () => void

  // saved queries
  library: SavedLibrary
  onCreateFolder: () => void
  onRenameFolder: (folder: QueryFolder) => void
  onDeleteFolder: (folder: QueryFolder) => void
  onAddQueryToFolder: (folder: QueryFolder) => void
  onLoadSaved: (q: SavedQuery) => void
  onRunSaved: (q: SavedQuery) => void
  onRenameSaved: (q: SavedQuery) => void
  onDeleteSaved: (q: SavedQuery) => void
}

export function Sidebar(props: Props): JSX.Element {
  const { tab, onTabChange } = props
  const liveHostIds = new Set(props.hosts.map((h) => h.id))

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={'sidebar-tab' + (tab === 'hosts' ? ' active' : '')}
          onClick={() => onTabChange('hosts')}
        >
          Hosts
        </button>
        <button
          className={'sidebar-tab' + (tab === 'history' ? ' active' : '')}
          onClick={() => onTabChange('history')}
        >
          History
        </button>
        <button
          className={'sidebar-tab' + (tab === 'saved' ? ' active' : '')}
          onClick={() => onTabChange('saved')}
        >
          Saved
        </button>
      </div>

      {tab === 'hosts' && (
        <HostList
          hosts={props.hosts}
          selectedHostId={props.selectedHostId}
          onSelect={props.onSelectHost}
          onAdd={props.onAddHost}
          onEdit={props.onEditHost}
          onDelete={props.onDeleteHost}
        />
      )}
      {tab === 'history' && (
        <HistoryList
          history={props.history}
          liveHostIds={liveHostIds}
          onLoad={props.onLoadHistory}
          onRun={props.onRunHistory}
          onDelete={props.onDeleteHistory}
          onClear={props.onClearHistory}
        />
      )}
      {tab === 'saved' && (
        <SavedPanel
          library={props.library}
          onCreateFolder={props.onCreateFolder}
          onRenameFolder={props.onRenameFolder}
          onDeleteFolder={props.onDeleteFolder}
          onAddQuery={props.onAddQueryToFolder}
          onLoadQuery={props.onLoadSaved}
          onRunQuery={props.onRunSaved}
          onRenameQuery={props.onRenameSaved}
          onDeleteQuery={props.onDeleteSaved}
        />
      )}
    </aside>
  )
}
