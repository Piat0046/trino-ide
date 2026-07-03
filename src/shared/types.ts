// Main 프로세스와 Renderer가 공유하는 타입. 런타임 코드가 없어야 한다(타입 전용).

/** Renderer에 노출되는 host 정보. 비밀번호는 절대 포함하지 않는다. */
export interface HostConfig {
  id: string
  name: string
  /** 예: http://localhost:8080 또는 https://trino.example.com:443 */
  url: string
  user: string
  catalog?: string
  schema?: string
  /** https self-signed 인증서 검증을 무시할지 여부 */
  insecure?: boolean
  /** 저장된 비밀번호가 있는지 여부 (값 자체는 노출하지 않음) */
  hasPassword: boolean
}

/** host 생성/수정 시 Renderer가 보내는 입력. id가 있으면 수정. */
export interface HostInput {
  id?: string
  name: string
  url: string
  user: string
  catalog?: string
  schema?: string
  insecure?: boolean
  /** undefined/'' 이면 기존 비밀번호 유지(수정 시), 새 값이면 교체 */
  password?: string
}

export interface QueryColumn {
  name: string
  type: string
}

/** 스테이지(rootStage) 트리를 평면화한 요약 행 */
export interface StageSummary {
  stageId: string
  state: string
  /** 트리 깊이(들여쓰기용) */
  depth: number
  coordinatorOnly: boolean
  processedRows: number
  processedBytes: number
  physicalInputBytes: number
  cpuTimeMillis: number
  completedSplits: number
  runningSplits: number
  queuedSplits: number
  totalSplits: number
  failedTasks: number
}

export interface QueryStatsSummary {
  state: string
  elapsedMs?: number
  processedRows?: number
  processedBytes?: number
  // ↓ 이미 응답에 들어오지만 안 쓰던 '공짜' 계측치(추가 요청 없음)
  cpuTimeMillis?: number
  wallTimeMillis?: number
  queuedTimeMillis?: number
  physicalInputBytes?: number
  peakMemoryBytes?: number
  spilledBytes?: number
  completedSplits?: number
  runningSplits?: number
  queuedSplits?: number
  totalSplits?: number
  nodes?: number
  /** 스테이지별 요약(최종 payload에만 채움 — 진행 스트림엔 없음) */
  stages?: StageSummary[]
}

export interface QueryResultPayload {
  columns: QueryColumn[]
  rows: unknown[][]
  rowCount: number
  /** 수신 상한에 도달해 결과가 잘렸는지 여부(비페이지네이션 모드) */
  truncated: boolean
  stats?: QueryStatsSummary
  /** 서버에서 OFFSET/LIMIT 래핑(페이지네이션)이 적용됐는지 */
  paginated: boolean
  /** 0-based 현재 페이지 (비페이지네이션이면 0) */
  page: number
  /** 페이지 크기(= LIMIT). 비페이지네이션이면 null */
  pageSize: number | null
  /** 다음 페이지가 더 있을 수 있는지 */
  hasNext: boolean
  /** 페이지네이션인데 원본에 ORDER BY가 없어 순서가 보장되지 않을 수 있음 */
  orderByWarning: boolean
  /** 실제로 서버에 보낸 SQL(페이지네이션 래핑/덧붙임 포함). 페이지마다 OFFSET이 다르다 */
  executedSql: string
  /** Trino 경고(있을 때만). deprecated 문법 등 */
  warnings?: string[]
  /** 이 쿼리의 Trino Web UI 상세 페이지 URL(접근 권한·보관 기간 내에서만 열림) */
  infoUri?: string
  /** Trino 쿼리 ID(로그/지원 상관용) */
  queryId?: string
}

export interface RunQueryRequest {
  hostId: string
  sql: string
  /** Renderer가 발급하는 요청 식별자. 취소(query:cancel) 시 사용 */
  requestId: string
  /** 받을 결과 행 상한(= 페이지 크기). null이면 무제한. 미지정 시 main이 설정값을 사용 */
  rowLimit?: number | null
  /** 요청 페이지(0-based). rowLimit이 숫자이고 SELECT/WITH일 때만 페이지네이션 적용 */
  page?: number
  /** 히스토리에 기록할지. 페이지 이동 재실행 시 false로 보내 중복 기록 방지 */
  recordHistory?: boolean
}

/** 앱 전역 설정 */
export interface AppSettings {
  /** 기본 결과 행 상한. null이면 무제한 */
  rowLimit: number | null
}

/** 쿼리 실행 1건의 기록. host가 지워져도 표시할 수 있도록 hostName을 함께 보관한다. */
export interface HistoryEntry {
  id: string
  sql: string
  hostId: string
  hostName: string
  /** 실행 시작 시각(epoch ms) */
  ranAt: number
  ok: boolean
  rowCount?: number
  elapsedMs?: number
  error?: string
}

/** 저장된 쿼리를 담는 1단계 폴더 */
export interface QueryFolder {
  id: string
  name: string
  createdAt: number
}

/** 폴더에 저장된 이름붙은 SQL */
export interface SavedQuery {
  id: string
  folderId: string
  name: string
  sql: string
  createdAt: number
  updatedAt: number
}

/** 저장 쿼리 라이브러리 전체 */
export interface SavedLibrary {
  folders: QueryFolder[]
  queries: SavedQuery[]
}

export interface CreateQueryInput {
  folderId: string
  name: string
  sql: string
}

export interface UpdateQueryInput {
  id: string
  name?: string
  sql?: string
  folderId?: string
}

/** 실행 중 서버가 보내는 진행 상황(스트리밍). requestId로 탭을 찾는다. */
export interface QueryProgress {
  requestId: string
  stats: QueryStatsSummary
}

/** 구조화된 쿼리 에러. line/column은 Trino가 준 위치(있을 때만). */
export interface QueryErrorInfo {
  message: string
  errorName?: string
  errorType?: string
  errorCode?: number
  line?: number
  column?: number
}

/** 텍스트 파일 저장 요청(내보내기) */
export interface SaveTextInput {
  /** 저장 다이얼로그 기본 파일명(확장자 포함) */
  defaultName: string
  content: string
}
/** 파일 저장 결과. 사용자가 취소하면 saved:false */
export interface SaveFileResult {
  saved: boolean
  path?: string
}

/** IPC 경계에서 throw 대신 명시적으로 성공/실패를 표현. errorInfo는 구조화된 부가정보(있을 때). */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; errorInfo?: QueryErrorInfo }

/** ── 성공 쿼리 기반 메타데이터 자동완성 ──
 * host별로 성공 쿼리에서 관찰(learned)했거나 사용자가 직접 추가(manual)한
 * catalog → schema → table 계층. Trino에 별도 호출하지 않고 로컬에 축적한다. */
export type MetadataSource = 'learned' | 'manual'

/** 계층 노드의 공통 메타. count/lastSeen은 자동완성 정렬 신호로 쓴다. */
export interface MetaNode {
  source: MetadataSource
  /** 최초 관찰/등록 시각(epoch ms) */
  firstSeen: number
  /** 최근 관찰/등록 시각(epoch ms) */
  lastSeen: number
  /** learned 관찰 횟수(manual은 0으로 시작·유지) */
  count: number
}

/** 컬럼 노드. 단일 테이블 SELECT * 결과에서만 학습하거나(learned) 사용자가 직접 추가(manual). */
export interface ColumnNode {
  name: string
  type: string
  source: MetadataSource
}
/** columns는 신뢰 가능한 경우(단일 테이블 SELECT *)에만 채워진다. 없으면 미학습. */
export interface TableNode extends MetaNode {
  columns?: ColumnNode[]
}
export interface SchemaNode extends MetaNode {
  tables: Record<string, TableNode>
}
export interface CatalogNode extends MetaNode {
  schemas: Record<string, SchemaNode>
}

/** 한 host의 메타데이터 트리(키 = 객체 이름, 원본 케이스 보존) */
export interface HostMetadata {
  catalogs: Record<string, CatalogNode>
}

/** catalog는 항상 존재, schema/table/column은 계층 깊이에 따라 선택. */
export interface MetadataRef {
  catalog: string
  schema?: string
  table?: string
  /** 컬럼 레벨 조작 시(수동 추가/삭제). table이 있어야 유효. */
  column?: string
}
/** 수동 추가/수정 입력. column이 있으면 컬럼 추가(columnType 필요). */
export interface ManualUpsertInput extends MetadataRef {
  hostId: string
  columnType?: string
}
/** 노드 삭제 입력(하위 연쇄삭제) */
export interface DeleteNodeInput extends MetadataRef {
  hostId: string
}
/** 노드 이름 변경 입력. 대상 노드는 manual로 승격된다(사용자가 손댄 항목 보호). */
export interface RenameNodeInput extends MetadataRef {
  hostId: string
  newName: string
}

/** preload가 contextBridge로 노출하는 window.api의 형태 */
export interface TrinoIdeApi {
  listHosts(): Promise<HostConfig[]>
  saveHost(input: HostInput): Promise<HostConfig>
  deleteHost(id: string): Promise<void>
  testHost(input: HostInput): Promise<IpcResult<QueryResultPayload>>
  runQuery(req: RunQueryRequest): Promise<IpcResult<QueryResultPayload>>
  cancelQuery(requestId: string): Promise<void>
  listHistory(): Promise<HistoryEntry[]>
  deleteHistory(id: string): Promise<void>
  clearHistory(): Promise<void>
  listSaved(): Promise<SavedLibrary>
  createFolder(name: string): Promise<QueryFolder>
  renameFolder(id: string, name: string): Promise<void>
  deleteFolder(id: string): Promise<void>
  createQuery(input: CreateQueryInput): Promise<SavedQuery>
  updateQuery(input: UpdateQueryInput): Promise<SavedQuery>
  deleteQuery(id: string): Promise<void>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** OS 클립보드에 텍스트 복사 */
  copyToClipboard(text: string): Promise<void>
  /** 저장 다이얼로그를 열어 텍스트를 파일로 저장(내보내기) */
  saveTextFile(input: SaveTextInput): Promise<SaveFileResult>
  /** 외부 브라우저로 URL 열기(http/https만). Trino Web UI(infoUri)용 */
  openExternal(url: string): Promise<void>
  /** ── 메타데이터 자동완성 ── host별 catalog/schema/table 조회·수정 */
  getMetadata(hostId: string): Promise<HostMetadata>
  upsertMetadata(input: ManualUpsertInput): Promise<HostMetadata>
  renameMetadata(input: RenameNodeInput): Promise<HostMetadata>
  deleteMetadata(input: DeleteNodeInput): Promise<HostMetadata>
  clearLearnedMetadata(hostId: string): Promise<HostMetadata>
  clearAllMetadata(hostId: string): Promise<void>
  /** 실행 진행 상황 이벤트 구독. 반환값 호출로 구독 해제. */
  onQueryProgress(cb: (progress: QueryProgress) => void): () => void
}
