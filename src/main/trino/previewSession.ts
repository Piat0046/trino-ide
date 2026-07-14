import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { QueryResult } from 'trino-client'
import type {
  GetPreviewPageRequest,
  PreviewPage,
  PreviewSessionState,
  PreviewSessionUpdate,
  QueryErrorInfo,
  StartPreviewRequest
} from '@shared/types'
import {
  mapQueryStats,
  openQueryStream,
  queryResultsIncludingInitial,
  type ResolvedConn,
  type TrinoQueryStream,
  TrinoQueryError
} from './client'

/** Preview 한 세션이 디스크에 기록할 수 있는 최대 크기(256 MiB). */
export const PREVIEW_MAX_BYTES = 256 * 1024 * 1024
/** Renderer 입력이 우회돼도 한 세션이 보관할 수 있는 최대 행 수. */
export const PREVIEW_MAX_ROWS = 50_000
/** 단일 IPC가 한 번에 역직렬화할 수 있는 최대 행 수. */
export const PREVIEW_MAX_PAGE_ROWS = 10_000
/** 한 번의 Renderer IPC 응답으로 역직렬화할 수 있는 최대 NDJSON byte 범위(16 MiB). */
export const PREVIEW_MAX_IPC_PAGE_BYTES = 16 * 1024 * 1024
/** 단일 셀이 비정상적으로 커도 한 행이 로컬 메모리/IPC를 독점하지 않게 한다(8 MiB). */
export const PREVIEW_MAX_ROW_BYTES = 8 * 1024 * 1024
/** 한 번의 파일 write에 모으는 목표 크기. 큰 단일 행은 PREVIEW_MAX_ROW_BYTES까지 허용한다. */
export const PREVIEW_WRITE_BATCH_BYTES = 1024 * 1024
const ALLOWED_PREVIEW_MAX_ROWS = new Set([1_000, 10_000, PREVIEW_MAX_ROWS])

const UPDATE_THROTTLE_MS = 100
const OPERATION_TIMEOUT_MS = 2_000
const DEFAULT_TEMP_BASE = join(tmpdir(), 'trino-ide-preview')
const DEFAULT_PROCESS_ROOT = join(DEFAULT_TEMP_BASE, `${process.pid}-${randomUUID()}`)

export interface PreviewAppendResult {
  appendedRows: number
  hitSizeLimit: boolean
}

export interface PreviewReadSnapshot {
  rows: unknown[][]
  availableRows: number
}

export interface PreviewSpoolLimits {
  maxRowBytes?: number
  maxWriteBatchBytes?: number
}

/**
 * 행 하나를 NDJSON 한 줄로 저장하고, 각 행 경계의 UTF-8 byte offset만 메모리에 둔다.
 * offsets[n]은 n번째 행의 시작이며 마지막 원소는 파일 끝 위치다.
 */
export class PreviewRowSpool {
  private readonly offsets: number[] = [0]
  private closed = false
  private disposeTask?: Promise<void>

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle
  ) {}

  static async create(root: string): Promise<PreviewRowSpool> {
    await ensurePrivateDirectory(root)
    const path = join(root, `${randomUUID()}.ndjson`)
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600)
    return new PreviewRowSpool(path, handle)
  }

  get availableRows(): number {
    return this.offsets.length - 1
  }

  get storedBytes(): number {
    return this.offsets[this.offsets.length - 1] ?? 0
  }

  async append(
    rows: unknown[][],
    maxBytes = PREVIEW_MAX_BYTES,
    limits: PreviewSpoolLimits = {}
  ): Promise<PreviewAppendResult> {
    this.assertOpen()
    const maxRowBytes = limits.maxRowBytes ?? PREVIEW_MAX_ROW_BYTES
    const maxWriteBatchBytes = limits.maxWriteBatchBytes ?? PREVIEW_WRITE_BATCH_BYTES
    const start = this.storedBytes
    const relativeEnds: number[] = []
    let plannedBytes = 0
    let batch: Buffer[] = []
    let batchBytes = 0
    let writePosition = start
    let hitSizeLimit = false

    const flush = async (): Promise<void> => {
      if (batchBytes === 0) return
      const buffer = Buffer.concat(batch, batchBytes)
      await writeFully(this.handle, buffer, writePosition)
      writePosition += batchBytes
      batch = []
      batchBytes = 0
    }

    for (const row of rows) {
      const serialized = JSON.stringify(row)
      if (serialized === undefined) throw new Error('Preview 행을 JSON으로 직렬화할 수 없습니다.')
      const chunk = Buffer.from(`${serialized}\n`, 'utf8')
      if (chunk.byteLength > maxRowBytes || start + plannedBytes + chunk.byteLength > maxBytes) {
        hitSizeLimit = true
        break
      }
      if (batchBytes > 0 && batchBytes + chunk.byteLength > maxWriteBatchBytes) await flush()
      batch.push(chunk)
      batchBytes += chunk.byteLength
      plannedBytes += chunk.byteLength
      relativeEnds.push(plannedBytes)
      if (batchBytes >= maxWriteBatchBytes) await flush()
    }

    await flush()
    // dispose가 write 도중 시작됐다면 닫힌 파일의 offset을 절대 공개하지 않는다.
    this.assertOpen()
    // 모든 파일 쓰기가 완료된 뒤에만 새 행을 읽을 수 있다고 공개한다.
    for (const relativeEnd of relativeEnds) this.offsets.push(start + relativeEnd)

    return { appendedRows: relativeEnds.length, hitSizeLimit }
  }

  async readSnapshot(
    offset: number,
    limit: number,
    maxPageBytes = PREVIEW_MAX_IPC_PAGE_BYTES
  ): Promise<PreviewReadSnapshot> {
    this.assertOpen()
    assertWindow(offset, limit)
    // offsets는 append 완료 뒤에만 늘어나므로 이 값과 읽을 범위가 하나의 일관된 snapshot이다.
    const availableRows = this.availableRows
    const endRow = Math.min(offset + limit, availableRows)
    if (offset >= endRow) return { rows: [], availableRows }

    const startByte = this.offsets[offset]
    const endByte = this.offsets[endRow]
    const length = endByte - startByte
    if (length > maxPageBytes) {
      throw new Error('Preview 페이지 데이터가 너무 큽니다. 페이지당 행 수를 줄여주세요(큰 행은 1행).')
    }
    const buffer = Buffer.allocUnsafe(length)
    await readFully(this.handle, buffer, startByte)
    const text = buffer.toString('utf8')
    const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text
    const rows = withoutTrailingNewline
      ? withoutTrailingNewline.split('\n').map((line) => JSON.parse(line) as unknown[])
      : []
    return { rows, availableRows }
  }

  async readWindow(offset: number, limit: number): Promise<unknown[][]> {
    return (await this.readSnapshot(offset, limit)).rows
  }

  async dispose(): Promise<void> {
    if (!this.disposeTask) {
      this.closed = true
      this.disposeTask = (async () => {
        try {
          await this.handle.close()
        } finally {
          await rm(this.path, { force: true })
        }
      })()
    }
    await this.disposeTask
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('이미 폐기된 Preview 저장소입니다.')
  }
}

async function writeFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < buffer.byteLength) {
    const result = await handle.write(buffer, written, buffer.byteLength - written, position + written)
    if (result.bytesWritten <= 0) throw new Error('Preview 임시 파일 쓰기가 중단되었습니다.')
    written += result.bytesWritten
  }
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let read = 0
  while (read < buffer.byteLength) {
    const result = await handle.read(buffer, read, buffer.byteLength - read, position + read)
    if (result.bytesRead <= 0) throw new Error('Preview 임시 파일을 끝까지 읽지 못했습니다.')
    read += result.bytesRead
  }
}

/** resolve/reject 여부와 무관하게 지정 시간 안에서만 기다린다. false면 timeout이다. */
async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (completed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(completed)
    }
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    void promise.then(() => finish(true), () => finish(true))
  })
}

/** 기존 symlink/타 사용자 디렉터리를 거부하고 현재 사용자 전용 권한으로 고정한다. */
async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Preview 임시 경로가 안전한 디렉터리가 아닙니다.')
  }
  const getuid = process.getuid
  if (getuid && info.uid !== getuid.call(process)) {
    throw new Error('Preview 임시 경로의 소유자가 현재 사용자와 다릅니다.')
  }
  await chmod(path, 0o700)
}

function assertWindow(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Preview offset은 0 이상의 정수여야 합니다.')
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PREVIEW_MAX_PAGE_ROWS) {
    throw new Error(`Preview limit은 1~${PREVIEW_MAX_PAGE_ROWS} 사이의 정수여야 합니다.`)
  }
}

export type PreviewQueryFactory = (
  conn: ResolvedConn,
  sql: string
) => Promise<TrinoQueryStream>

export interface PreviewSessionManagerOptions {
  tempRoot: string
  queryFactory?: PreviewQueryFactory
  prepareTempRoot?: () => Promise<void>
  maxBytes?: number
  maxRowBytes?: number
  maxWriteBatchBytes?: number
  maxPageBytes?: number
  updateThrottleMs?: number
  cancelTimeoutMs?: number
  disposeTimeoutMs?: number
  now?: () => number
}

interface PreviewSession {
  readonly id: string
  readonly ownerId: number
  readonly conn: ResolvedConn
  readonly sql: string
  readonly maxRows: number
  readonly spool: PreviewRowSpool
  readonly emit: (update: PreviewSessionUpdate) => void
  state: PreviewSessionState
  columns: PreviewSessionUpdate['columns']
  stats?: PreviewSessionUpdate['stats']
  error?: string
  errorInfo?: QueryErrorInfo
  warnings?: string[]
  infoUri?: string
  queryId?: string
  stream?: TrinoQueryStream
  task?: Promise<void>
  cancelRequested: boolean
  disposed: boolean
  disposePromise?: Promise<void>
  cancelPromise?: Promise<void>
  updateTimer?: ReturnType<typeof setTimeout>
  lastUpdateAt: number
}

export class PreviewSessionManager {
  private readonly sessions = new Map<string, PreviewSession>()
  private readonly reservedIds = new Set<string>()
  private initialized?: Promise<void>
  private closing = false
  private readonly queryFactory: PreviewQueryFactory
  private readonly maxBytes: number
  private readonly maxRowBytes: number
  private readonly maxWriteBatchBytes: number
  private readonly maxPageBytes: number
  private readonly updateThrottleMs: number
  private readonly cancelTimeoutMs: number
  private readonly disposeTimeoutMs: number
  private readonly now: () => number

  constructor(private readonly options: PreviewSessionManagerOptions) {
    this.queryFactory = options.queryFactory ?? openQueryStream
    this.maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES
    this.maxPageBytes = options.maxPageBytes ?? PREVIEW_MAX_IPC_PAGE_BYTES
    this.maxRowBytes = Math.min(options.maxRowBytes ?? PREVIEW_MAX_ROW_BYTES, this.maxPageBytes)
    this.maxWriteBatchBytes = options.maxWriteBatchBytes ?? PREVIEW_WRITE_BATCH_BYTES
    this.updateThrottleMs = options.updateThrottleMs ?? UPDATE_THROTTLE_MS
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? OPERATION_TIMEOUT_MS
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? OPERATION_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  initialize(): Promise<void> {
    if (!this.initialized) {
      const attempt = (async () => {
        await this.options.prepareTempRoot?.()
        await ensurePrivateDirectory(this.options.tempRoot)
      })()
      this.initialized = attempt
      void attempt.catch(() => {
        if (this.initialized === attempt) this.initialized = undefined
      })
    }
    return this.initialized
  }

  async start(
    request: StartPreviewRequest,
    conn: ResolvedConn,
    ownerId: number,
    emit: (update: PreviewSessionUpdate) => void
  ): Promise<PreviewSessionUpdate> {
    validateStartRequest(request)
    if (this.closing) throw new Error('Preview 세션 관리자가 종료 중입니다.')
    if (this.sessions.has(request.sessionId) || this.reservedIds.has(request.sessionId)) {
      throw new Error('이미 존재하는 Preview sessionId입니다.')
    }
    // 첫 await 전에 예약해 initialize/spool 생성 중 concurrent start의 TOCTOU를 막는다.
    this.reservedIds.add(request.sessionId)
    let spool: PreviewRowSpool | undefined
    try {
      await this.initialize()
      if (this.closing) throw new Error('Preview 세션 관리자가 종료 중입니다.')
      spool = await PreviewRowSpool.create(this.options.tempRoot)
      if (this.closing) throw new Error('Preview 세션 관리자가 종료 중입니다.')
      const session: PreviewSession = {
        id: request.sessionId,
        ownerId,
        conn,
        sql: request.sql,
        maxRows: request.maxRows,
        spool,
        emit,
        state: 'starting',
        columns: [],
        cancelRequested: false,
        disposed: false,
        lastUpdateAt: 0
      }
      this.sessions.set(session.id, session)
      session.task = this.consume(session)
      return this.snapshot(session)
    } catch (error) {
      await spool?.dispose().catch(() => undefined)
      throw error
    } finally {
      this.reservedIds.delete(request.sessionId)
    }
  }

  async getPage(request: GetPreviewPageRequest, ownerId: number): Promise<PreviewPage> {
    assertWindow(request.offset, request.limit)
    const session = this.requireOwnedSession(request.sessionId, ownerId)
    const snapshot = await session.spool.readSnapshot(
      request.offset,
      request.limit,
      this.maxPageBytes
    )
    return {
      sessionId: session.id,
      offset: request.offset,
      rows: snapshot.rows,
      availableRows: snapshot.availableRows,
      state: session.state
    }
  }

  async cancel(sessionId: string, ownerId: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.ownerId !== ownerId || session.disposed || isTerminal(session.state)) return
    session.cancelRequested = true
    session.state = 'cancelled'
    this.emitNow(session)
    await this.cancelRemote(session)
  }

  async dispose(sessionId: string, ownerId: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.ownerId !== ownerId) return
    await this.disposeSession(session)
  }

  async disposeOwner(ownerId: number): Promise<void> {
    const owned = [...this.sessions.values()].filter((session) => session.ownerId === ownerId)
    await Promise.allSettled(owned.map((session) => this.disposeSession(session)))
  }

  async disposeAll(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.sessions.values()].map((session) => this.disposeSession(session)))
    await settleWithin(
      rm(this.options.tempRoot, { recursive: true, force: true }),
      this.disposeTimeoutMs
    )
  }

  private async consume(session: PreviewSession): Promise<void> {
    try {
      const stream = await this.queryFactory(session.conn, session.sql)
      session.stream = stream
      session.queryId = stream.queryId

      if (session.cancelRequested || session.disposed) {
        await this.cancelRemote(session)
        return
      }

      session.state = 'running'
      this.emitNow(session)

      // 최초 POST 응답을 포함하되, iterator가 같은 객체를 직접 내보내는 구현에서도 중복하지 않는다.
      for await (const page of queryResultsIncludingInitial(stream.pages, stream.initialResult)) {
        if (await this.consumePage(session, page)) return
      }

      if (session.disposed) return
      if (session.cancelRequested) {
        session.state = 'cancelled'
        this.emitNow(session)
        await this.cancelRemote(session)
      } else {
        session.state = 'finished'
        this.emitNow(session)
      }
    } catch (error) {
      if (session.disposed) return
      if (session.cancelRequested) {
        session.state = 'cancelled'
        this.emitNow(session)
      } else {
        session.state = 'failed'
        session.error = errorMessage(error)
        session.errorInfo = toQueryErrorInfo(error)
        this.emitNow(session)
        // nextUri/로컬 저장 실패도 서버 쿼리가 살아 있을 수 있으므로 failed를 유지한 채 정리한다.
        await this.cancelRemote(session)
      }
    }
  }

  /** 한 Trino 응답을 반영한다. cap/취소로 pump를 끝내야 하면 true. */
  private async consumePage(session: PreviewSession, page: QueryResult): Promise<boolean> {
    if (page.id) session.queryId = page.id
    if (page.infoUri && !session.infoUri) session.infoUri = page.infoUri
    if (page.warnings?.length) session.warnings = page.warnings
    if (page.stats) session.stats = mapQueryStats(page.stats)

    if (session.cancelRequested || session.disposed) {
      await this.cancelRemote(session)
      return true
    }
    if (page.error) throw new TrinoQueryError(page.error)
    if (page.columns && session.columns.length === 0) {
      session.columns = page.columns.map((column) => ({ name: column.name, type: column.type }))
    }

    if (page.data?.length) {
      const remaining = session.maxRows - session.spool.availableRows
      const candidates = (page.data as unknown[][]).slice(0, Math.max(remaining, 0))
      const appended = await session.spool.append(candidates, this.maxBytes, {
        maxRowBytes: this.maxRowBytes,
        maxWriteBatchBytes: this.maxWriteBatchBytes
      })

      // append await 동안 탭/창이 닫히거나 사용자가 취소할 수 있다. 취소가 cap 상태보다 우선한다.
      if (session.cancelRequested || session.disposed) {
        await this.cancelRemote(session)
        return true
      }

      if (appended.hitSizeLimit) {
        session.state = 'size_limit'
        this.emitNow(session)
        await this.cancelRemote(session)
        return true
      }

      // SQL LIMIT과 실제 전체 행 수는 구분할 수 없으므로 정확히 한도만큼 받은 경우도
      // 전체 행 수로 오해하지 않도록 보수적으로 row_limit으로 종료한다.
      if (session.spool.availableRows >= session.maxRows) {
        session.state = 'row_limit'
        this.emitNow(session)
        await this.cancelRemote(session)
        return true
      }
    }

    this.emitThrottled(session)
    return false
  }

  private async cancelRemote(session: PreviewSession): Promise<void> {
    if (!session.stream || !session.queryId) return
    if (!session.cancelPromise) {
      const stream = session.stream
      const queryId = session.queryId
      let attempt: Promise<void>
      try {
        attempt = Promise.resolve(stream.cancel(queryId)).then(() => undefined, () => undefined)
      } catch {
        attempt = Promise.resolve()
      }
      session.cancelPromise = settleWithin(attempt, this.cancelTimeoutMs).then(() => undefined)
    }
    await session.cancelPromise
  }

  private async disposeSession(session: PreviewSession): Promise<void> {
    if (!session.disposePromise) {
      session.disposePromise = (async () => {
        session.disposed = true
        session.cancelRequested = true
        if (session.updateTimer) clearTimeout(session.updateTimer)
        try {
          // cancel을 먼저 시작하고 pump가 끝나기를 기다리되, POST/nextUri가 멎어도 종료를 막지 않는다.
          const cancel = this.cancelRemote(session)
          const pump = session.task ?? Promise.resolve()
          await settleWithin(Promise.allSettled([cancel, pump]), this.disposeTimeoutMs)
          // timeout 뒤 pump가 늦게 깨어나도 disposed 검사와 spool.closed gate 때문에 write를 공개하지 않는다.
          await settleWithin(session.spool.dispose(), this.disposeTimeoutMs)
        } finally {
          if (this.sessions.get(session.id) === session) this.sessions.delete(session.id)
        }
      })()
    }
    await session.disposePromise
  }

  private requireOwnedSession(sessionId: string, ownerId: number): PreviewSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.ownerId !== ownerId || session.disposed) {
      throw new Error('Preview 세션을 찾을 수 없습니다.')
    }
    return session
  }

  private snapshot(session: PreviewSession): PreviewSessionUpdate {
    return {
      sessionId: session.id,
      state: session.state,
      columns: session.columns,
      availableRows: session.spool.availableRows,
      storedBytes: session.spool.storedBytes,
      stats: session.stats,
      error: session.error,
      errorInfo: session.errorInfo,
      warnings: session.warnings,
      infoUri: session.infoUri,
      queryId: session.queryId
    }
  }

  private emitThrottled(session: PreviewSession): void {
    if (session.disposed) return
    const remaining = this.updateThrottleMs - (this.now() - session.lastUpdateAt)
    if (remaining <= 0) {
      this.emitNow(session)
      return
    }
    if (session.updateTimer) return
    session.updateTimer = setTimeout(() => {
      session.updateTimer = undefined
      this.emitNow(session)
    }, remaining)
    session.updateTimer.unref?.()
  }

  private emitNow(session: PreviewSession): void {
    if (session.disposed) return
    if (session.updateTimer) {
      clearTimeout(session.updateTimer)
      session.updateTimer = undefined
    }
    session.lastUpdateAt = this.now()
    try {
      session.emit(this.snapshot(session))
    } catch {
      // Renderer가 닫히는 순간의 이벤트 전송 실패는 세션 정리에 영향을 주지 않는다.
    }
  }
}

function validateStartRequest(request: StartPreviewRequest): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.sessionId)) {
    throw new Error('Preview sessionId 형식이 올바르지 않습니다.')
  }
  if (!request.hostId || typeof request.hostId !== 'string') {
    throw new Error('Preview hostId가 필요합니다.')
  }
  if (!request.sql || typeof request.sql !== 'string') {
    throw new Error('Preview SQL이 필요합니다.')
  }
  if (!Number.isSafeInteger(request.maxRows) || !ALLOWED_PREVIEW_MAX_ROWS.has(request.maxRows)) {
    throw new Error('Preview maxRows는 1,000, 10,000, 50,000 중 하나여야 합니다.')
  }
}

function isTerminal(state: PreviewSessionState): boolean {
  return !['starting', 'running'].includes(state)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toQueryErrorInfo(error: unknown): QueryErrorInfo | undefined {
  if (!(error instanceof TrinoQueryError)) return undefined
  return {
    message: error.message,
    errorName: error.errorName,
    errorType: error.errorType,
    errorCode: error.errorCode,
    line: error.line,
    column: error.column
  }
}

/** 기본 앱 인스턴스의 temp root를 만들기 전에 죽은 프로세스의 잔여 디렉터리를 정리한다. */
async function prepareDefaultTempRoot(): Promise<void> {
  await ensurePrivateDirectory(DEFAULT_TEMP_BASE)
  const entries = await readdir(DEFAULT_TEMP_BASE, { withFileTypes: true })
  await Promise.allSettled(
    entries
      .filter((entry) => entry.isDirectory() && join(DEFAULT_TEMP_BASE, entry.name) !== DEFAULT_PROCESS_ROOT)
      .map(async (entry) => {
        const pid = Number.parseInt(entry.name.split('-', 1)[0] ?? '', 10)
        if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) return
        await rm(join(DEFAULT_TEMP_BASE, entry.name), { recursive: true, force: true })
      })
  )
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createDefaultPreviewSessionManager(): PreviewSessionManager {
  return new PreviewSessionManager({
    tempRoot: DEFAULT_PROCESS_ROOT,
    prepareTempRoot: prepareDefaultTempRoot
  })
}
