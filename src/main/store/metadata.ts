import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CatalogNode,
  DeleteNodeInput,
  HostMetadata,
  ManualUpsertInput,
  MetaNode,
  MetadataRef,
  MetadataSource,
  SchemaNode
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
  write(data)
}

/** 사용자가 직접 추가/수정한 항목(manual). 가장 깊은 지정 노드는 manual로 보호 승격한다. */
export function upsertManual(input: ManualUpsertInput): HostMetadata {
  const { hostId, catalog, schema, table } = input
  const ref: MetadataRef = { catalog, schema, table }
  if (!ref.catalog) return getHostMetadata(hostId)
  const data = read()
  const host = (data.hosts[hostId] ??= { catalogs: {} })
  applyRef(host, ref, 'manual', Date.now())
  const leaf = nodeAt(host, ref)
  if (leaf) leaf.source = 'manual'
  write(data)
  return host
}

/** 특정 노드 삭제(하위 연쇄삭제). */
export function deleteNode(input: DeleteNodeInput): HostMetadata {
  const { hostId, catalog, schema, table } = input
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
        else delete sch.tables[table]
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
        if (tbl.source === 'learned') delete sch.tables[tblName]
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
