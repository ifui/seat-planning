/**
 * 仓储共有逻辑：数据归一化、备份导出与解析。
 * IndexedDB 与 SQLite 两种实现共用这一份，避免两套后端行为分叉。
 */
import type { Assignment, LayoutPackage, LayoutPreset, Member, Project, RosterPlan, Snapshot } from '../types'
import { nowISO } from '../engine/sheet'
import type { ImportSummary, Tables } from './repository'

/** 备份文件可接受的版本号 */
export const SUPPORTED_SCHEMA = ['2.0', '2.1', '2.2']

export const emptyTables = (): Tables => ({ rosters: [], layouts: [], projects: [], snapshots: [], presets: [] })

/** 写入前去掉响应式代理，保证能结构化克隆 / 序列化 */
export const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** 兼容旧数据：成员 active:boolean 迁移为 status（在位 / 请假） */
export function normalizeRoster(r: RosterPlan): RosterPlan {
  const members = (r.members ?? []).map((raw) => {
    const m = raw as Member & { active?: boolean }
    const status: Member['status'] =
      m.status === 'leave' || m.status === 'present' ? m.status : m.active === false ? 'leave' : 'present'
    const { active, ...rest } = m
    return { ...rest, status } as Member
  })
  // 名册顺序以 member.order 为准：旧数据没有 order 时沿用数组位置，
  // 随后统一重编为 0..n-1，保证刷新、快照与排座读取到的是同一个顺序
  const ordered = members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.order ?? a.i) - (b.m.order ?? b.i) || a.i - b.i)
    .map((x, i) => (x.m.order === i ? x.m : { ...x.m, order: i }))
  return { ...r, members: ordered }
}

/** 旧数据归一化：状态字段、项目名册快照 */
export function normalizeTables(t: Tables): Tables {
  const rosters = (t.rosters ?? []).map(normalizeRoster)
  // 仅迁移旧版本的「缺席 / 来宾」；在位与请假原样保留
  const fixStatus = (a: Assignment): Assignment => {
    const s = (a as { status?: string }).status
    return s === 'present' || s === 'leave' ? a : { ...a, status: 'present' }
  }
  const normalizeProject = (p: Project): Project => {
    // 旧项目没有快照：以当前名册补一份，之后就与名册解耦
    const live = rosters.find((r) => r.id === p.rosterPlanId)
    const snapshot = p.rosterSnapshot
      ? normalizeRoster(p.rosterSnapshot)
      : live
        ? normalizeRoster(JSON.parse(JSON.stringify(live)))
        : undefined
    return {
      ...p,
      rosterSnapshot: snapshot,
      // 名册变动不再联动项目，已排好的分配保持不变
      assignments: (p.assignments ?? []).map(fixStatus)
    }
  }
  return {
    ...t,
    rosters,
    projects: (t.projects ?? []).map(normalizeProject),
    snapshots: (t.snapshots ?? []).map((s) => ({ ...s, assignments: (s.assignments ?? []).map(fixStatus) }))
  }
}

/** 全量备份 JSON（两种后端输出一致） */
export function exportJson(t: Tables): string {
  return JSON.stringify(
    {
      schemaVersion: '2.2',
      exportedAt: nowISO(),
      rosters: t.rosters,
      layouts: t.layouts,
      projects: t.projects,
      snapshots: t.snapshots,
      presets: t.presets
    },
    null,
    2
  )
}

/** 解析并校验备份文件：返回归一化后的数据与各表条数 */
export function parseBackup(json: string): { tables: Tables; summary: ImportSummary } {
  let data: any
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  if (!data || typeof data !== 'object') throw new Error('备份文件内容为空')
  const ver = String(data.schemaVersion ?? '')
  if (!ver) throw new Error('备份文件缺少 schemaVersion 版本号')
  if (!SUPPORTED_SCHEMA.includes(ver)) {
    const major = ver.split('.')[0]
    throw new Error(
      major === '2' ? `不支持的备份版本 ${ver}，当前仅支持 ${SUPPORTED_SCHEMA.join(' / ')}` : `备份版本 ${ver} 与当前应用不兼容`
    )
  }

  const warnings: string[] = []
  const pick = <T extends { id?: unknown }>(key: string): T[] => {
    const v = data[key]
    if (v === undefined) return []
    if (!Array.isArray(v)) {
      warnings.push(`字段 ${key} 格式异常，已跳过`)
      return []
    }
    const valid = v.filter((x: any) => x && typeof x === 'object' && typeof x.id === 'string')
    if (valid.length !== v.length) warnings.push(`${key} 中有 ${v.length - valid.length} 条记录缺少 id，已跳过`)
    return valid as T[]
  }

  const tables = normalizeTables({
    rosters: pick<RosterPlan>('rosters'),
    layouts: pick<LayoutPackage>('layouts'),
    projects: pick<Project>('projects'),
    snapshots: pick<Snapshot>('snapshots'),
    presets: pick<LayoutPreset>('presets')
  })
  const { rosters, layouts, projects, snapshots, presets } = tables
  if (!rosters.length && !layouts.length && !projects.length && !presets.length) {
    throw new Error('备份文件中没有可导入的数据')
  }

  return {
    tables,
    summary: {
      schemaVersion: ver,
      rosters: rosters.length,
      layouts: layouts.length,
      projects: projects.length,
      snapshots: snapshots.length,
      presets: presets.length,
      warnings
    }
  }
}

/** 合并写入用：同 ID 覆盖、新 ID 追加 */
export function upsert<T extends { id: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) list[i] = item
  else list.push(item)
}

/** 字节数估算：设置中心展示用量 */
export function bytesOf(v: unknown[]): number {
  return v.length ? new TextEncoder().encode(JSON.stringify(v)).length : 0
}
