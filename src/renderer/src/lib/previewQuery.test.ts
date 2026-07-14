import { describe, expect, it } from 'vitest'
import {
  buildPreviewSql,
  PAGE_SIZE_PRESETS,
  resolvePreviewStartTarget,
  type PreviewFilter
} from './previewQuery'

const table = { catalog: 'lake"house', schema: 'analytics', table: 'events' }

describe('buildPreviewSql', () => {
  it('keeps a one-row local page option for rows near the IPC byte limit', () => {
    expect(PAGE_SIZE_PRESETS[0]).toBe(1)
  })

  it('uses the intended Preview while a disposable tab replacement is not mounted yet', () => {
    const intended = { hostId: 'host', preview: table, marker: 'new' }
    const staleScratch = { hostId: 'host', preview: null, marker: 'old' }
    const stalePreview = {
      hostId: 'host',
      preview: { ...table, table: 'other_table' },
      marker: 'old-preview'
    }

    expect(resolvePreviewStartTarget(staleScratch, intended, false)).toBe(intended)
    expect(resolvePreviewStartTarget(stalePreview, intended, false)).toBe(intended)
    expect(resolvePreviewStartTarget(staleScratch, intended, true)).toBeUndefined()
  })

  it('builds one bounded stream query without OFFSET or an implicit ORDER BY', () => {
    const sql = buildPreviewSql(table, [], 10_000)

    expect(sql).toBe('SELECT * FROM "lake""house"."analytics"."events" LIMIT 10000')
    expect(sql).not.toContain('OFFSET')
    expect(sql).not.toContain('ORDER BY')
  })

  it('adds only the user-selected server sort', () => {
    const sql = buildPreviewSql(table, [], 50_000, { column: 'created_at', dir: 'desc' })

    expect(sql).toContain(' ORDER BY "created_at" DESC LIMIT 50000')
    expect(sql.match(/ORDER BY/g)).toHaveLength(1)
  })

  it('keeps enabled valid filters and safely escapes values', () => {
    const filters: PreviewFilter[] = [
      { column: 'name', op: 'eq', value: "O'Reilly", colType: 'varchar' },
      { column: 'score', op: 'gt', value: '10', colType: 'bigint' },
      { column: 'ignored', op: 'eq', value: 'x', enabled: false },
      { column: 'empty', op: 'eq', value: '   ' }
    ]

    expect(buildPreviewSql(table, filters, 1000)).toBe(
      'SELECT * FROM "lake""house"."analytics"."events" WHERE "name" = \'O\'\'Reilly\' AND "score" > 10 LIMIT 1000'
    )
  })

  it('falls back to the default total cap for an invalid number', () => {
    expect(buildPreviewSql(table, [], Number.NaN)).toMatch(/ LIMIT 10000$/)
  })
})
