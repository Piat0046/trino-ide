import { type KeyboardEvent } from 'react'
import { EditorTabs, type TabView } from './EditorTabs'
import { FilterBar } from './FilterBar'
import { buildPreviewSql, LIMIT_PRESETS, type PreviewFilter } from '../lib/previewQuery'
import type { PreviewSpec } from '../lib/tabs'
import { IconExternal, IconPlay, IconStop } from './icons'

interface Props {
  // 탭 스트립(SqlEditor와 동일 스트립 공유)
  tabs: TabView[]
  activeTabId: string
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  split: boolean
  onToggleSplit?: () => void
  inspectorOpen?: boolean
  onToggleInspector?: () => void
  // 프리뷰
  preview: PreviewSpec
  /** 마지막으로 실행된 SQL(변경 대기 ● 판정용) */
  lastRunSql: string
  /** 필터 컬럼 후보(첫 결과의 columns) */
  columns: { name: string; type: string }[]
  running: boolean
  /** 상단 칩: "연결 · catalog.schema.table" */
  hostLabel: string
  onChangeFilters: (filters: PreviewFilter[]) => void
  onChangeLimit: (limit: number) => void
  onRun: () => void
  onCancel: () => void
  onClear: () => void
  onOpenInEditor: () => void
}

/**
 * 테이블 프리뷰 탭 상단 슬롯(#54) — [탭 스트립 + 컨트롤 바 + 필터 바]만(내용 높이).
 * 하단 ResultsPane이 나머지를 가득 채운다(고정 분할·v-splitter 없음). 필터 추가는 그리드 컬럼
 * 우클릭으로만(위쪽에 prepend). 서버 재조회는 "조회"(⌘↵) 명시 액션에서만.
 */
export function PreviewPane({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  split,
  onToggleSplit,
  inspectorOpen,
  onToggleInspector,
  preview,
  lastRunSql,
  columns,
  running,
  hostLabel,
  onChangeFilters,
  onChangeLimit,
  onRun,
  onCancel,
  onClear,
  onOpenInEditor
}: Props): JSX.Element {
  // 변경 대기: 현재 필터/LIMIT로 만든 SQL이 마지막 실행 SQL과 다르면 ●
  const staged = buildPreviewSql(preview, preview.filters, preview.limit) !== lastRunSql
  const limitInPresets = LIMIT_PRESETS.includes(preview.limit)
  const hasFilters = preview.filters.length > 0

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!running) onRun()
    }
  }

  return (
    <div className={'editor-pane preview-pane' + (split ? ' compact' : '')} onKeyDown={handleKeyDown}>
      <EditorTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNew={onNewTab}
        split={split}
        onToggleSplit={onToggleSplit}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
      />

      <div className="toolbar preview-toolbar">
        <span className="preview-target" title={hostLabel}>
          {hostLabel}
        </span>
        {!hasFilters && (
          <span className="preview-filterhint">컬럼 헤더 우클릭 → 필터 추가</span>
        )}
        <span className="spacer" />
        {hasFilters && (
          <button
            className="ghost"
            disabled={running}
            title="모든 필터를 지우고 다시 조회해요 · 서버 조회 1회"
            onClick={onClear}
          >
            필터 비우기
          </button>
        )}
        <label className="preview-limit" title="표시 행 상한 (더 보려면 늘려 조회)">
          LIMIT
          <select
            aria-label="표시 행 상한"
            value={preview.limit}
            onChange={(e) => onChangeLimit(Number(e.target.value))}
          >
            {!limitInPresets && <option value={preview.limit}>{preview.limit}</option>}
            {LIMIT_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <button title="이 조회를 SQL 문장으로 편집기에서 열어요" onClick={onOpenInEditor}>
          <IconExternal size={14} />
          <span className="btn-label">SQL 편집기로 열기</span>
        </button>
        {running ? (
          <button className="danger" onClick={onCancel} title="실행 중지">
            <IconStop size={13} />
            <span className="btn-label">중지</span>
          </button>
        ) : (
          <button
            className={'primary' + (staged ? ' staged' : '')}
            onClick={onRun}
            title={
              staged
                ? '대기 중인 필터·LIMIT를 적용해 서버에서 다시 가져와요 (⌘↵) · 서버 조회 1회'
                : '서버에서 다시 조회 · 서버 조회 1회 (⌘↵)'
            }
          >
            {staged && <span className="staged-dot" aria-hidden />}
            <IconPlay size={13} />
            <span className="btn-label">조회</span>
          </button>
        )}
      </div>

      <FilterBar
        columns={columns}
        filters={preview.filters}
        appliedFilters={preview.appliedFilters ?? []}
        onChange={onChangeFilters}
        onApply={onRun}
        disabled={running}
      />
    </div>
  )
}
