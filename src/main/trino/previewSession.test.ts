import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueryResult } from 'trino-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewSessionUpdate } from '@shared/types'
import {
  queryResultsIncludingInitial,
  type ResolvedConn,
  type TrinoQueryStream
} from './client'
import {
  PreviewRowSpool,
  PreviewSessionManager,
  type PreviewQueryFactory
} from './previewSession'

const roots: string[] = []
const conn: ResolvedConn = { url: 'http://trino.test:8080', user: 'preview-test' }

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trino-ide-preview-test-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function iterable(pages: QueryResult[]): AsyncIterable<QueryResult> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) yield page
    }
  }
}

function terminalUpdates(): {
  emit: (update: PreviewSessionUpdate) => void
  terminal: Promise<PreviewSessionUpdate>
  updates: PreviewSessionUpdate[]
} {
  const updates: PreviewSessionUpdate[] = []
  let resolve!: (update: PreviewSessionUpdate) => void
  const terminal = new Promise<PreviewSessionUpdate>((done) => {
    resolve = done
  })
  return {
    updates,
    terminal,
    emit(update) {
      updates.push(update)
      if (!['starting', 'running'].includes(update.state)) resolve(update)
    }
  }
}

describe('PreviewRowSpool', () => {
  it('uses UTF-8 byte offsets and reads arbitrary windows without corrupting NDJSON', async () => {
    const root = await tempRoot()
    const spool = await PreviewRowSpool.create(root)
    const rows = [
      ['한글😀', 'line\nquote"', null, { nested: ['값', 1] }],
      [42, true, '끝'],
      [{ json: { deep: '내용' } }]
    ]

    const appended = await spool.append(rows)
    const expectedBytes = rows.reduce(
      (sum, row) => sum + Buffer.byteLength(`${JSON.stringify(row)}\n`, 'utf8'),
      0
    )

    expect(appended).toEqual({ appendedRows: 3, hitSizeLimit: false })
    expect(spool.availableRows).toBe(3)
    expect(spool.storedBytes).toBe(expectedBytes)
    expect(await spool.readWindow(1, 1)).toEqual([rows[1]])
    expect(await spool.readWindow(0, 10)).toEqual(rows)

    const path = spool.path
    await spool.dispose()
    await expect(access(path)).rejects.toThrow()
  })

  it('never writes a partial row when the byte cap is reached', async () => {
    const spool = await PreviewRowSpool.create(await tempRoot())
    const first = ['한글']
    const firstBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`, 'utf8')

    expect(await spool.append([first, ['overflow']], firstBytes)).toEqual({
      appendedRows: 1,
      hitSizeLimit: true
    })
    expect(await spool.readWindow(0, 10)).toEqual([first])
    expect(spool.storedBytes).toBe(firstBytes)
    await spool.dispose()
  })

  it('rejects oversized page reads and a single row over the storage row cap', async () => {
    const spool = await PreviewRowSpool.create(await tempRoot())
    const rows = [['first'], ['second']]
    await spool.append(rows)
    const firstBytes = Buffer.byteLength(`${JSON.stringify(rows[0])}\n`, 'utf8')

    await expect(spool.readSnapshot(0, 2, firstBytes)).rejects.toThrow('페이지당 행 수를 줄여주세요')
    expect(await spool.append([['too-large']], 1000, { maxRowBytes: 4 })).toEqual({
      appendedRows: 0,
      hitSizeLimit: true
    })
    await spool.dispose()
  })

  it('returns rows and availableRows from the same published offset snapshot', async () => {
    const spool = await PreviewRowSpool.create(await tempRoot())
    await spool.append([['first'], ['second']])

    await expect(spool.readSnapshot(0, 1)).resolves.toEqual({
      rows: [['first']],
      availableRows: 2
    })
    await spool.dispose()
  })
})

describe('queryResultsIncludingInitial', () => {
  it('includes the initial POST result exactly once even if an iterator yields the same object', async () => {
    const initial: QueryResult = { id: 'query', data: [['initial']] }
    const following: QueryResult = { id: 'query', data: [['following']] }
    const results: QueryResult[] = []

    for await (const page of queryResultsIncludingInitial(iterable([initial, following]), initial)) {
      results.push(page)
    }

    expect(results).toEqual([initial, following])
  })
})

describe('PreviewSessionManager', () => {
  it('processes the initial POST result before following iterator pages', async () => {
    const root = await tempRoot()
    const cancel = vi.fn(async () => undefined)
    const queryFactory: PreviewQueryFactory = async (): Promise<TrinoQueryStream> => ({
      queryId: 'query_initial',
      initialResult: {
        id: 'query_initial',
        nextUri: 'http://trino.test/next/1',
        columns: [{ name: 'value', type: 'varchar' }],
        data: [['최초😀']]
      },
      pages: iterable([{ id: 'query_initial', data: [['second'], ['third']] }]),
      cancel
    })
    const manager = new PreviewSessionManager({ tempRoot: root, queryFactory, updateThrottleMs: 0 })
    const events = terminalUpdates()

    await manager.start(
      { sessionId: 'session-initial', hostId: 'host', sql: 'SELECT 1 LIMIT 1000', maxRows: 1000 },
      conn,
      1,
      events.emit
    )
    const final = await events.terminal
    const page = await manager.getPage({ sessionId: 'session-initial', offset: 0, limit: 100 }, 1)

    expect(final.state).toBe('finished')
    expect(final.columns).toEqual([{ name: 'value', type: 'varchar' }])
    expect(page.rows).toEqual([['최초😀'], ['second'], ['third']])
    expect(cancel).not.toHaveBeenCalled()
    await manager.disposeAll()
  })

  it('cancels explicitly when a server chunk crosses the selected row cap', async () => {
    const cancel = vi.fn(async () => undefined)
    const rows = Array.from({ length: 1001 }, (_, index) => [index])
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      updateThrottleMs: 0,
      queryFactory: async () => ({
        queryId: 'query-cap',
        initialResult: { id: 'query-cap', nextUri: 'next', data: rows },
        pages: iterable([]),
        cancel
      })
    })
    const events = terminalUpdates()

    await manager.start(
      { sessionId: 'session-cap', hostId: 'host', sql: 'SELECT * LIMIT 1000', maxRows: 1000 },
      conn,
      1,
      events.emit
    )
    const final = await events.terminal
    const page = await manager.getPage({ sessionId: 'session-cap', offset: 990, limit: 100 }, 1)

    expect(final.state).toBe('row_limit')
    expect(final.availableRows).toBe(1000)
    expect(page.rows).toEqual(Array.from({ length: 10 }, (_, index) => [990 + index]))
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith('query-cap')
    await manager.disposeAll()
  })

  it('labels an exact SQL LIMIT result as a Preview cap instead of a table total', async () => {
    const cancel = vi.fn(async () => undefined)
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      updateThrottleMs: 0,
      queryFactory: async () => ({
        queryId: 'query-exact-cap',
        initialResult: {
          id: 'query-exact-cap',
          data: Array.from({ length: 1000 }, (_, index) => [index])
        },
        pages: iterable([]),
        cancel
      })
    })
    const events = terminalUpdates()

    await manager.start(
      {
        sessionId: 'session-exact-cap',
        hostId: 'host',
        sql: 'SELECT * LIMIT 1000',
        maxRows: 1000
      },
      conn,
      1,
      events.emit
    )
    const final = await events.terminal

    expect(final.state).toBe('row_limit')
    expect(final.availableRows).toBe(1000)
    expect(cancel).toHaveBeenCalledWith('query-exact-cap')
    await manager.disposeAll()
  })

  it('keeps committed rows readable when a later iterator request fails', async () => {
    const cancel = vi.fn(async () => undefined)
    const pages: AsyncIterable<QueryResult> = {
      async *[Symbol.asyncIterator]() {
        yield { id: 'query-partial', data: [['kept']] }
        throw new Error('nextUri failed')
      }
    }
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      updateThrottleMs: 0,
      queryFactory: async () => ({
        queryId: 'query-partial',
        initialResult: { id: 'query-partial', nextUri: 'next' },
        pages,
        cancel
      })
    })
    const events = terminalUpdates()

    await manager.start(
      { sessionId: 'session-partial', hostId: 'host', sql: 'SELECT * LIMIT 1000', maxRows: 1000 },
      conn,
      2,
      events.emit
    )
    const final = await events.terminal
    const page = await manager.getPage({ sessionId: 'session-partial', offset: 0, limit: 100 }, 2)

    expect(final.state).toBe('failed')
    expect(final.error).toBe('nextUri failed')
    expect(page.rows).toEqual([['kept']])
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('query-partial'))
    expect(events.updates.at(-1)?.state).toBe('failed')
    await manager.disposeAll()
  })

  it('honors cancellation requested while the initial POST is still pending', async () => {
    let resolveStream!: (stream: TrinoQueryStream) => void
    const pending = new Promise<TrinoQueryStream>((resolve) => {
      resolveStream = resolve
    })
    const cancel = vi.fn(async () => undefined)
    const queryFactory = vi.fn(() => pending)
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      queryFactory,
      updateThrottleMs: 0
    })
    const events = terminalUpdates()

    await manager.start(
      { sessionId: 'session-cancel', hostId: 'host', sql: 'SELECT * LIMIT 1000', maxRows: 1000 },
      conn,
      7,
      events.emit
    )
    await manager.cancel('session-cancel', 7)
    expect((await events.terminal).state).toBe('cancelled')

    resolveStream({
      queryId: 'query-after-cancel',
      initialResult: { id: 'query-after-cancel', nextUri: 'next' },
      pages: iterable([]),
      cancel
    })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('query-after-cancel'))
    expect((await manager.getPage({ sessionId: 'session-cancel', offset: 0, limit: 10 }, 7)).state).toBe(
      'cancelled'
    )
    await manager.disposeAll()
  })

  it('turns an initial terminal Trino error into a structured failed update', async () => {
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      updateThrottleMs: 0,
      queryFactory: async () => ({
        queryId: 'query-error',
        initialResult: {
          id: 'query-error',
          error: {
            message: 'bad column',
            errorCode: 1,
            errorName: 'COLUMN_NOT_FOUND',
            errorType: 'USER_ERROR',
            failureInfo: { type: '', message: '', suppressed: [], stack: [] }
          }
        },
        pages: iterable([]),
        cancel: async () => undefined
      })
    })
    const events = terminalUpdates()

    await manager.start(
      { sessionId: 'session-error', hostId: 'host', sql: 'SELECT bad LIMIT 1000', maxRows: 1000 },
      conn,
      1,
      events.emit
    )
    const final = await events.terminal

    expect(final.state).toBe('failed')
    expect(final.errorInfo).toMatchObject({
      message: 'bad column',
      errorName: 'COLUMN_NOT_FOUND',
      errorType: 'USER_ERROR',
      errorCode: 1
    })
    await manager.disposeAll()
  })

  it('stores committed rows and terminates as size_limit when the byte cap is crossed', async () => {
    const first = ['kept']
    const firstBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`, 'utf8')
    const cancel = vi.fn(async () => undefined)
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      maxBytes: firstBytes,
      updateThrottleMs: 0,
      queryFactory: async () => ({
        queryId: 'query-size',
        initialResult: { id: 'query-size', data: [first, ['overflow']] },
        pages: iterable([]),
        cancel
      })
    })
    const events = terminalUpdates()

    await manager.start(
      { sessionId: 'session-size', hostId: 'host', sql: 'SELECT * LIMIT 1000', maxRows: 1000 },
      conn,
      1,
      events.emit
    )
    const final = await events.terminal
    const page = await manager.getPage({ sessionId: 'session-size', offset: 0, limit: 10 }, 1)

    expect(final.state).toBe('size_limit')
    expect(page.rows).toEqual([first])
    expect(cancel).toHaveBeenCalledWith('query-size')
    await manager.disposeAll()
  })

  it('bounds disposal while the initial POST is pending and safely cancels if it resolves late', async () => {
    const pending = deferred<TrinoQueryStream>()
    const cancel = vi.fn(async () => undefined)
    const root = await tempRoot()
    const manager = new PreviewSessionManager({
      tempRoot: root,
      queryFactory: () => pending.promise,
      cancelTimeoutMs: 10,
      disposeTimeoutMs: 10
    })

    await manager.start(
      { sessionId: 'session-pending-post', hostId: 'host', sql: 'SELECT 1 LIMIT 1000', maxRows: 1000 },
      conn,
      1,
      () => undefined
    )
    const completed = await Promise.race([
      manager.disposeAll().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
    ])
    expect(completed).toBe(true)
    await expect(access(root)).rejects.toThrow()

    pending.resolve({
      queryId: 'query-late',
      initialResult: { id: 'query-late', data: [['must-not-write']] },
      pages: iterable([]),
      cancel
    })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('query-late'))
    await expect(access(root)).rejects.toThrow()
  })

  it('bounds disposal when both nextUri and remote cancel never settle', async () => {
    const never = new Promise<never>(() => undefined)
    const cancel = vi.fn(() => never)
    const pages: AsyncIterableIterator<QueryResult> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => never
    }
    const root = await tempRoot()
    const manager = new PreviewSessionManager({
      tempRoot: root,
      queryFactory: async () => ({
        queryId: 'query-stuck',
        initialResult: { id: 'query-stuck', nextUri: 'next' },
        pages,
        cancel
      }),
      cancelTimeoutMs: 10,
      disposeTimeoutMs: 10
    })
    const events = terminalUpdates()

    await manager.start(
      { sessionId: 'session-stuck', hostId: 'host', sql: 'SELECT 1 LIMIT 1000', maxRows: 1000 },
      conn,
      1,
      events.emit
    )
    await vi.waitFor(() => expect(events.updates.some((update) => update.state === 'running')).toBe(true))
    const completed = await Promise.race([
      manager.disposeAll().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
    ])

    expect(completed).toBe(true)
    expect(cancel).toHaveBeenCalledWith('query-stuck')
    await expect(access(root)).rejects.toThrow()
  })

  it('reserves a sessionId before async initialization and retries a rejected initialization', async () => {
    const ready = deferred<void>()
    let prepareCalls = 0
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      prepareTempRoot: async () => {
        prepareCalls += 1
        if (prepareCalls === 1) await ready.promise
      },
      queryFactory: async () => ({
        queryId: 'query-duplicate',
        initialResult: { id: 'query-duplicate' },
        pages: iterable([]),
        cancel: async () => undefined
      }),
      updateThrottleMs: 0
    })

    const first = manager.start(
      { sessionId: 'session-duplicate', hostId: 'host', sql: 'SELECT 1 LIMIT 1000', maxRows: 1000 },
      conn,
      1,
      () => undefined
    )
    await expect(
      manager.start(
        { sessionId: 'session-duplicate', hostId: 'host', sql: 'SELECT 1 LIMIT 1000', maxRows: 1000 },
        conn,
        1,
        () => undefined
      )
    ).rejects.toThrow('이미 존재하는')
    ready.resolve()
    await first
    await manager.disposeAll()
    await expect(
      manager.start(
        { sessionId: 'session-after-close', hostId: 'host', sql: 'SELECT 1 LIMIT 1000', maxRows: 1000 },
        conn,
        1,
        () => undefined
      )
    ).rejects.toThrow('종료 중')
  })

  it('allows initialize to retry after a rejected preparation', async () => {
    let attempts = 0
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      prepareTempRoot: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('prepare failed')
      },
      queryFactory: async () => ({
        queryId: 'query-retry',
        initialResult: { id: 'query-retry' },
        pages: iterable([]),
        cancel: async () => undefined
      })
    })
    const request = {
      sessionId: 'session-retry',
      hostId: 'host',
      sql: 'SELECT 1 LIMIT 1000',
      maxRows: 1000
    }

    await expect(manager.start(request, conn, 1, () => undefined)).rejects.toThrow('prepare failed')
    await expect(manager.start(request, conn, 1, () => undefined)).resolves.toMatchObject({
      sessionId: 'session-retry'
    })
    expect(attempts).toBe(2)
    await manager.disposeAll()
  })

  it('keeps cancelled terminal state when cancellation races with an append', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const originalAppend = PreviewRowSpool.prototype.append
    const appendSpy = vi
      .spyOn(PreviewRowSpool.prototype, 'append')
      .mockImplementation(async function (
        this: PreviewRowSpool,
        ...args: Parameters<PreviewRowSpool['append']>
      ) {
        entered.resolve()
        await release.promise
        return originalAppend.apply(this, args)
      })
    const cancel = vi.fn(async () => undefined)
    const manager = new PreviewSessionManager({
      tempRoot: await tempRoot(),
      updateThrottleMs: 0,
      queryFactory: async () => ({
        queryId: 'query-append-race',
        initialResult: { id: 'query-append-race', data: [['committed']] },
        pages: iterable([]),
        cancel
      })
    })
    const events = terminalUpdates()

    try {
      await manager.start(
        {
          sessionId: 'session-append-race',
          hostId: 'host',
          sql: 'SELECT 1 LIMIT 1000',
          maxRows: 1000
        },
        conn,
        1,
        events.emit
      )
      await entered.promise
      await manager.cancel('session-append-race', 1)
      expect((await events.terminal).state).toBe('cancelled')
      release.resolve()
      await vi.waitFor(async () => {
        const page = await manager.getPage(
          { sessionId: 'session-append-race', offset: 0, limit: 10 },
          1
        )
        expect(page.rows).toEqual([['committed']])
        expect(page.state).toBe('cancelled')
      })
    } finally {
      release.resolve()
      appendSpy.mockRestore()
      await manager.disposeAll()
    }
  })
})
