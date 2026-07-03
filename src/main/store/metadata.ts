import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CatalogNode,
  ColumnNode,
  DeleteNodeInput,
  HostMetadata,
  ManualUpsertInput,
  MetaNode,
  MetadataRef,
  MetadataSource,
  RenameNodeInput,
  SchemaNode,
  TableNode
} from '@shared/types'

/**
 * 성공 쿼리에서 학습한 catalog/schema/table 메타데이터를 <userData>/metadata.json 에 host별로 저장한다.
 * learned = 성공 쿼리에서 관찰, manual = 사용자가 관리 창에서 직접 추가.
 * **불변식: manual 노드는 재학습·clearLearned가 지우거나 source를 덮어쓰지 않는다.**
 */
const VERSION = 1

interface MetadataFile {
  version: number
  /** history.json 소급 학습을 1회만 수행하기 위한 마커 */
  historyBackfilled?: boolean
  hosts: Record<string, HostMetadata>
}

function storePath(): string {
  return join(app.getPath('userData'), 'metadata.json')
}

function read(): MetadataFile {
  const p = storePath()
  if (!existsSync(p)) return { version: VERSION, hosts: {} }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<MetadataFile> | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.hosts !== 'object' || parsed.hosts === null) {
      return { version: VERSION, hosts: {} }
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : VERSION,
      historyBackfilled: parsed.historyBackfilled === true,
      hosts: parsed.hosts as Record<string, HostMetadata>
    }
  } catch {
    return { version: VERSION, hosts: {} }
  }
}

function write(data: MetadataFile): void {
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
}

function newNode(source: MetadataSource, now: number): MetaNode {
  return { source, firstSeen: now, lastSeen: now, count: source === 'learned' ? 1 : 0 }
}

/** 재관찰 시 lastSeen 갱신 + learned만 count 증가(manual은 source·count 유지). */
function touch(node: MetaNode, now: number): void {
  node.lastSeen = now
  if (node.source === 'learned') node.count += 1
}

/** ref 경로(catalog[.schema[.table]])를 host 트리에 upsert. 없는 노드는 source로 생성. */
function applyRef(host: HostMetadata, ref: MetadataRef, source: MetadataSource, now: number): void {
  let cat = host.catalogs[ref.catalog]
  if (!cat) cat = host.catalogs[ref.catalog] = { ...newNode(source, now), schemas: {} }
  else touch(cat, now)
  if (!ref.schema) return

  let sch = cat.schemas[ref.schema]
  if (!sch) sch = cat.schemas[ref.schema] = { ...newNode(source, now), tables: {} }
  else touch(sch, now)
  if (!ref.table) return

  const tbl = sch.tables[ref.table]
  if (!tbl) sch.tables[ref.table] = newNode(source, now)
  else touch(tbl, now)
}

/** ref가 가리키는 가장 깊은 노드 반환(없으면 undefined). */
function nodeAt(host: HostMetadata, ref: MetadataRef): MetaNode | undefined {
  const cat: CatalogNode | undefined = host.catalogs[ref.catalog]
  if (!cat || !ref.schema) return cat
  const sch: SchemaNode | undefined = cat.schemas[ref.schema]
  if (!sch || !ref.table) return sch
  return sch.tables[ref.table]
}

/**
 * host당 learned 테이블 수 상한. 초과하면 오래된(lastSeen 낮은) learned 테이블부터 정리한다.
 * manual 테이블과 manual 컬럼을 가진 테이블은 항상 보호한다.
 */
const MAX_LEARNED_TABLES = 1500

function pruneHost(host: HostMetadata): void {
  const learned: { cat: string; sch: string; tbl: string; lastSeen: number }[] = []
  for (const [catName, cat] of Object.entries(host.catalogs)) {
    for (const [schName, sch] of Object.entries(cat.schemas)) {
      for (const [tblName, tbl] of Object.entries(sch.tables)) {
        const hasManualCol = (tbl.columns ?? []).some((c) => c.source === 'manual')
        if (tbl.source === 'learned' && !hasManualCol) {
          learned.push({ cat: catName, sch: schName, tbl: tblName, lastSeen: tbl.lastSeen })
        }
      }
    }
  }
  if (learned.length <= MAX_LEARNED_TABLES) return
  learned.sort((a, b) => a.lastSeen - b.lastSeen)
  for (const e of learned.slice(0, learned.length - MAX_LEARNED_TABLES)) {
    delete host.catalogs[e.cat].schemas[e.sch].tables[e.tbl]
  }
  // 비게 된 learned 스키마/카탈로그 정리(manual은 보존)
  for (const [catName, cat] of Object.entries(host.catalogs)) {
    for (const [schName, sch] of Object.entries(cat.schemas)) {
      if (sch.source === 'learned' && Object.keys(sch.tables).length === 0) delete cat.schemas[schName]
    }
    if (cat.source === 'learned' && Object.keys(cat.schemas).length === 0) delete host.catalogs[catName]
  }
}

/** cat/sch/tbl 경로를 생성/확보하고 그 테이블 노드를 반환. */
function getOrCreateTable(
  host: HostMetadata,
  ref: MetadataRef,
  source: MetadataSource,
  now: number
): TableNode | undefined {
  if (!ref.catalog || !ref.schema || !ref.table) return undefined
  applyRef(host, { catalog: ref.catalog, schema: ref.schema, table: ref.table }, source, now)
  return host.catalogs[ref.catalog].schemas[ref.schema].tables[ref.table]
}

// ───────────────────────────── public API ─────────────────────────────

export function getHostMetadata(hostId: string): HostMetadata {
  return read().hosts[hostId] ?? { catalogs: {} }
}

/** 성공 쿼리에서 관찰한 참조를 학습(learned). ref는 호출부에서 host 기본값으로 보정된 값. */
export function learnReference(hostId: string, ref: MetadataRef): void {
  learnReferences(hostId, [ref])
}

/** 여러 참조를 한 번의 파일 쓰기로 학습(성공 쿼리 1건에 다중 테이블). */
export function learnReferences(hostId: string, refs: MetadataRef[]): void {
  const valid = refs.filter((r) => !!r.catalog)
  if (valid.length === 0) return
  const data = read()
  const host = (data.hosts[hostId] ??= { catalogs: {} })
  const now = Date.now()
  for (const ref of valid) applyRef(host, ref, 'learned', now)
  pruneHost(host)
  write(data)
}

/**
 * 단일 테이블 SELECT * 결과에서 관찰한 컬럼을 그 테이블에 귀속(learned).
 * manual 컬럼은 보존하고, learned 컬럼은 관찰된 집합으로 교체한다(관찰 순서 유지).
 */
export function learnColumns(
  hostId: string,
  ref: MetadataRef,
  columns: { name: string; type: string }[]
): void {
  if (!ref.catalog || !ref.schema || !ref.table || columns.length === 0) return
  const data = read()
  const host = (data.hosts[hostId] ??= { catalogs: {} })
  const tbl = getOrCreateTable(host, ref, 'learned', Date.now())
  if (!tbl) return
  const manualCols = (tbl.columns ?? []).filter((c) => c.source === 'manual')
  const observed = new Set(columns.map((c) => c.name.toLowerCase()))
  // 관찰 순서대로: 같은 이름의 manual 컬럼이 있으면 그걸 유지, 없으면 learned로
  const merged: ColumnNode[] = columns.map((c) => {
    const m = manualCols.find((x) => x.name.toLowerCase() === c.name.toLowerCase())
    return m ?? { name: c.name, type: c.type, source: 'learned' }
  })
  // 관찰되지 않은 manual 컬럼은 뒤에 유지
  for (const m of manualCols) if (!observed.has(m.name.toLowerCase())) merged.push(m)
  tbl.columns = merged
  pruneHost(host)
  write(data)
}

/** 사용자가 직접 추가/수정한 항목(manual). column이 있으면 수동 컬럼, 아니면 노드를 manual로 보호 승격. */
export function upsertManual(input: ManualUpsertInput): HostMetadata {
  const { hostId, catalog, schema, table, column, columnType } = input
  if (!catalog) return getHostMetadata(hostId)
  const data = read()
  const host = (data.hosts[hostId] ??= { catalogs: {} })
  const now = Date.now()

  if (column && schema && table) {
    // 수동 컬럼 추가/수정(테이블 경로 확보 후 컬럼 upsert)
    const tbl = getOrCreateTable(host, { catalog, schema, table }, 'manual', now)
    if (tbl) {
      const cols = tbl.columns ?? []
      const node: ColumnNode = { name: column, type: columnType ?? '', source: 'manual' }
      const idx = cols.findIndex((c) => c.name.toLowerCase() === column.toLowerCase())
      if (idx >= 0) cols[idx] = node
      else cols.push(node)
      tbl.columns = cols
    }
  } else {
    const ref: MetadataRef = { catalog, schema, table }
    applyRef(host, ref, 'manual', now)
    const leaf = nodeAt(host, ref)
    if (leaf) leaf.source = 'manual'
  }
  write(data)
  return host
}

/** rec의 oldKey를 newKey로 옮긴다(newKey가 이미 있거나 same이면 이동하지 않음). */
function renameKey<T>(rec: Record<string, T>, oldKey: string, newKey: string): void {
  if (oldKey === newKey || rec[newKey] || !rec[oldKey]) return
  rec[newKey] = rec[oldKey]
  delete rec[oldKey]
}

/** 노드 이름 변경 + manual 승격(사용자가 손댄 항목 보호). 형제에 같은 이름이 있으면 이동은 생략. */
export function renameNode(input: RenameNodeInput): HostMetadata {
  const { hostId, catalog, schema, table, column, newName } = input
  const data = read()
  const host = data.hosts[hostId]
  if (!host || !newName) return host ?? { catalogs: {} }
  const cat = host.catalogs[catalog]
  if (!cat) return host

  if (!schema) {
    renameKey(host.catalogs, catalog, newName)
    cat.source = 'manual'
  } else {
    const sch = cat.schemas[schema]
    if (!sch) return host
    if (!table) {
      renameKey(cat.schemas, schema, newName)
      sch.source = 'manual'
    } else {
      const tbl = sch.tables[table]
      if (!tbl) return host
      if (!column) {
        renameKey(sch.tables, table, newName)
        tbl.source = 'manual'
      } else {
        const cols = tbl.columns ?? []
        const idx = cols.findIndex((c) => c.name.toLowerCase() === column.toLowerCase())
        const dup = cols.some(
          (c, i) => i !== idx && c.name.toLowerCase() === newName.toLowerCase()
        )
        if (idx >= 0 && !dup) cols[idx] = { ...cols[idx], name: newName, source: 'manual' }
      }
    }
  }
  write(data)
  return host
}

/** 특정 노드 삭제(하위 연쇄삭제). column이 있으면 그 컬럼만 삭제. */
export function deleteNode(input: DeleteNodeInput): HostMetadata {
  const { hostId, catalog, schema, table, column } = input
  const data = read()
  const host = data.hosts[hostId]
  if (!host) return { catalogs: {} }
  const cat = host.catalogs[catalog]
  if (cat) {
    if (!schema) delete host.catalogs[catalog]
    else {
      const sch = cat.schemas[schema]
      if (sch) {
        if (!table) delete cat.schemas[schema]
        else if (column) {
          const tbl = sch.tables[table]
          if (tbl?.columns) {
            tbl.columns = tbl.columns.filter((c) => c.name.toLowerCase() !== column.toLowerCase())
            if (tbl.columns.length === 0) delete tbl.columns
          }
        } else delete sch.tables[table]
      }
    }
  }
  write(data)
  return host
}

/** learned 항목만 비운다. manual 노드와 그 조상은 보존. */
export function clearLearned(hostId: string): HostMetadata {
  const data = read()
  const host = data.hosts[hostId]
  if (!host) return { catalogs: {} }
  for (const [catName, cat] of Object.entries(host.catalogs)) {
    for (const [schName, sch] of Object.entries(cat.schemas)) {
      for (const [tblName, tbl] of Object.entries(sch.tables)) {
        const manualCols = (tbl.columns ?? []).filter((c) => c.source === 'manual')
        // learned 테이블이고 manual 컬럼도 없으면 통째로 제거
        if (tbl.source === 'learned' && manualCols.length === 0) {
          delete sch.tables[tblName]
          continue
        }
        // 보존 대상: learned 컬럼만 벗겨내고 manual 컬럼은 남긴다
        tbl.columns = manualCols.length ? manualCols : undefined
      }
      if (sch.source === 'learned' && Object.keys(sch.tables).length === 0) delete cat.schemas[schName]
    }
    if (cat.source === 'learned' && Object.keys(cat.schemas).length === 0) delete host.catalogs[catName]
  }
  write(data)
  return host
}

/** 해당 host의 메타데이터 전체 삭제(manual 포함). */
export function clearAll(hostId: string): void {
  const data = read()
  delete data.hosts[hostId]
  write(data)
}

// ───────────────────────────── 소급 학습 마커 ─────────────────────────────

export function isBackfilled(): boolean {
  return read().historyBackfilled === true
}

export function markBackfilled(): void {
  const data = read()
  data.historyBackfilled = true
  write(data)
}
