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

export interface QueryStatsSummary {
  state: string
  elapsedMs?: number
  processedRows?: number
  processedBytes?: number
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

/** IPC 경계에서 throw 대신 명시적으로 성공/실패를 표현 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

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
}
