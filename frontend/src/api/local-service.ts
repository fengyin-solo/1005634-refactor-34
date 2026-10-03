import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  CATEGORY_REPLACE,
  readValvePending,
  resolveEntry,
  submitDecision,
  type Category,
  type ValvePendingItem,
  type VerdictBasis,
} from '@/domain/compensator'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === 'compensator') {
    return exportCompensatorEntries(meta)
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

// 补偿器检查记录导出：部件状态与当前状态都取自统一归类，列表判什么、
// 汇总怎么算、导出就写什么，不再按伸缩量另判一遍。
const COMPENSATOR_EXPORT_FIELDS = [
  '检查编号',
  '所属管段',
  '补偿器型号',
  '伸缩量',
  '额定补偿能力',
  '外观状况',
  '阀门井编号',
  '检查人',
  '检查日期',
]

function exportCompensatorEntries(meta: ModuleMeta): { filename: string; content: string } {
  const header = [
    '编号',
    ...COMPENSATOR_EXPORT_FIELDS,
    '外观口径',
    '伸缩量口径',
    '判定依据',
    '部件状态',
    '当前状态',
    '归类说明',
  ]
  const lines = [header.join(',')]
  for (const row of listRows('compensator')) {
    const resolved = resolveEntry(row)
    const basis = resolved.signed
      ? resolved.basis === 'appearance'
        ? '外观状况（现场签字）'
        : '伸缩量（现场签字）'
      : ''
    const status = displayStatus(row.status, resolved.category, resolved.signed)
    lines.push(
      [
        row.id,
        ...COMPENSATOR_EXPORT_FIELDS.map((field) => row[field] ?? ''),
        resolved.appearanceVerdict,
        resolved.extensionVerdict,
        basis,
        resolved.category,
        status,
        resolved.reason,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 列表与导出共用的状态呈现：
 * - 已签字判定（含历史结论）：当前状态直接是归类结论，与部件状态一致；
 * - 还没判：保留检查流程状态（待检查/检查中），若归类挂起则标注「挂起」。
 */
export function displayStatus(workflowStatus: string, category: Category, signed: boolean): string {
  if (signed) {
    return category
  }
  return category === '挂起' ? `${workflowStatus}·挂起` : workflowStatus
}

export type CompensatorDecisionInput = {
  entryId: number
  inspector: string
  basis: VerdictBasis
}

/**
 * 提交补偿器现场判定：走统一归类，落判定台账（重复提交只更新同一条），
 * 再把结论写回检查记录——部件状态、流程状态同一份归类，不再各写一套；
 * 判定结论同步落到阀门井待检查清单。
 */
export function submitCompensatorDecision(
  input: CompensatorDecisionInput,
): ActionResult & { category?: Category } {
  const key = 'compensator'
  const rows = listRows(key)
  const result = submitDecision(rows, input)
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  const index = rows.findIndex((row) => Number(row.id) === input.entryId)
  const updated: EntryRow = {
    ...rows[index],
    // 检查记录表的部件状态写回统一归类结论（历史台账里的结论同样原样保留）。
    部件状态: result.record.category,
    status: result.record.category,
    pending: false,
    abnormal: result.record.category === CATEGORY_REPLACE,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return {
    ok: true,
    category: result.record.category,
    message: result.duplicated
      ? `判定已更新（仍为同一条记录）：${result.record.category}。${result.record.reason}`
      : `判定已提交：${result.record.category}。${result.record.reason}`,
  }
}

export function listValvePending(): ValvePendingItem[] {
  return readValvePending()
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
