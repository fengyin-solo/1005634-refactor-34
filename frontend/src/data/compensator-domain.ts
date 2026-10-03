import { listRows, saveRows } from './local-store'
import type { ActionResult, EntryRow } from './types'

/**
 * 补偿器检查：判定与归类的唯一口径。
 *
 * 过去列表按「外观状况」判状态，导出与汇总又按「伸缩量」另判一次——判成需更换的，
 * 导出里还是状态正常，检查记录的「部件状态」还写回旧口径那一套。本模块把判定与归类
 * 收拢成同一份实现：检查记录表（部件状态）、列表（当前状态/状态汇总/统计卡）、导出与
 * 汇总全部调用 classifyCompensator，不再各写一遍。
 *
 * 沿用既有补偿器检查口径：
 * - 外观状况：腐蚀、变形、泄漏、裂纹、破损等缺陷 -> 需更换；外观完好、未见异常 -> 状态正常。
 * - 伸缩量：超出设计允许补偿量（超标/超限/超出允许范围）-> 需更换；在允许范围内（合格/未超）-> 状态正常。
 * - 外观与伸缩量结论冲突时，以现场检查人签字的那一份检查记录为准（默认签字的是外观检查表；
 *   记录显式写明签字依据为伸缩量时从伸缩量）。
 * - 伸缩量缺失（或无法据此核定）的先挂起，补齐现场数据再判，不强行归类。
 * - 历史上已经判定过的部件，部件状态保持原样，不再重判、不重复落单。
 */

export const COMPENSATOR_KEY = 'compensator'
export const VALVE_WELL_KEY = 'valvewell'

/** 终态归类结论。 */
export const VERDICT_NORMAL = '状态正常'
export const VERDICT_REPLACE = '需更换'
/** 数据不足、先挂起待补的归类。 */
export const VERDICT_SUSPENDED = '挂起'

/** 流程态：尚未提交现场检查，没有现场数据，不参与判定。 */
const FLOW_AWAITING_INSPECTION = '待检查'
const FLOW_IN_INSPECTION = '检查中'

export const FINAL_VERDICTS = [VERDICT_NORMAL, VERDICT_REPLACE]

/** 记录里可显式标注「现场检查人签字的是哪一份」；缺省按外观状况签字。 */
const SIGNED_BASIS_FIELD = '签字依据'
const BASIS_APPEARANCE = '外观状况'
const BASIS_EXTENSION = '伸缩量'
/** 历史结论锁定标记：提交判定落锤后置真，此后不再重判。 */
const LOCKED_FIELD = '结论锁定'
const JUDGE_BASIS_FIELD = '判定依据'
/** 阀门井待检查项回写的来源检查编号，用于重提去重。 */
const SOURCE_REF_FIELD = '来源检查编号'

type SideVerdict = typeof VERDICT_NORMAL | typeof VERDICT_REPLACE
export type Classification = {
  /** 列表当前状态、部件状态、导出、汇总共用的这一份归类。 */
  state: string
  /** 核定结论；尚未检查时为 null。 */
  verdict: SideVerdict | null
  /** 历史已判定，结论原样保留。 */
  locked: boolean
  /** 是否挂起待补。 */
  suspended: boolean
  /** 结论依据，用于动作回执与落库追溯。 */
  basis: string
  reason: string
}

const APPEARANCE_DEFECT_KEYWORDS = [
  '腐蚀', '锈蚀', '变形', '泄漏', '渗漏', '裂纹', '开裂', '破损', '损坏', '损伤', '鼓包', '凹陷',
]
const APPEARANCE_FINE_KEYWORDS = ['完好', '正常', '无异常', '未见异常', '无缺陷', '无泄漏']

const EXTENSION_BAD_KEYWORDS = ['超标', '超限', '超出', '超过允许', '超量程', '越限', '超补偿']
const EXTENSION_FINE_KEYWORDS = ['合格', '正常', '允许范围内', '范围内', '未超', '达标']

/** 伸缩量缺失/未测的写法。 */
const EXTENSION_MISSING_PATTERN = /(^$)|(未测|待测|待补|缺失|暂无|没测|未填)|^[\s\-—/\\]+$/

function textOf(value: EntryRow[string] | undefined): string {
  return String(value ?? '').trim()
}

/** 关键词前若带否定前缀（无/未/没），不算命中缺陷或超标。 */
function matchKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => {
    const index = text.indexOf(keyword)
    if (index < 0) {
      return false
    }
    const before = text.slice(Math.max(0, index - 2), index)
    return !/[无未没]|没有/.test(before)
  })
}

/** 外观状况口径 -> 需更换 / 状态正常 / 记载不足无法核定。 */
export function classifyAppearance(raw: string): SideVerdict | null {
  const text = raw.trim()
  if (!text || /^(尚未检查|待检查|待补)/.test(text)) {
    return null
  }
  if (matchKeyword(text, APPEARANCE_DEFECT_KEYWORDS)) {
    return VERDICT_REPLACE
  }
  if (APPEARANCE_FINE_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return VERDICT_NORMAL
  }
  return null
}

/** 伸缩量口径 -> 需更换 / 状态正常 / 缺失（先挂起）。 */
export function classifyExtension(raw: string): SideVerdict | null {
  const text = raw.trim()
  if (EXTENSION_MISSING_PATTERN.test(text)) {
    return null
  }
  if (matchKeyword(text, EXTENSION_BAD_KEYWORDS)) {
    return VERDICT_REPLACE
  }
  if (EXTENSION_FINE_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return VERDICT_NORMAL
  }
  // 只填了裸数值、没有合格/超标字样，没有额定值可比，不强行归类。
  return null
}

function isHistoricalVerdict(row: EntryRow): boolean {
  return Boolean(row[LOCKED_FIELD]) || FINAL_VERDICTS.includes(String(row.status))
}

/**
 * 唯一的判定/归类入口。列表、检查记录部件状态、导出、汇总都以此为准。
 */
export function classifyCompensator(row: EntryRow): Classification {
  const rawStatus = String(row.status ?? '')

  // 历史记录里已经判定过的部件：结论保持原样，不再按现状数据重判。
  if (isHistoricalVerdict(row)) {
    const historical = FINAL_VERDICTS.includes(textOf(row['部件状态']))
      ? textOf(row['部件状态'])
      : rawStatus
    return {
      state: historical,
      verdict: historical as SideVerdict,
      locked: true,
      suspended: false,
      basis: '历史结论',
      reason: '历史已判定，部件状态保持原样',
    }
  }

  // 还没提交现场检查：不参与判定。
  if (rawStatus === FLOW_AWAITING_INSPECTION) {
    return {
      state: FLOW_AWAITING_INSPECTION,
      verdict: null,
      locked: false,
      suspended: false,
      basis: '尚未检查',
      reason: '尚未提交现场检查',
    }
  }

  const appearance = classifyAppearance(textOf(row['外观状况']))
  const extension = classifyExtension(textOf(row['伸缩量']))
  const signed = textOf(row[SIGNED_BASIS_FIELD]).includes('伸缩')
    ? BASIS_EXTENSION
    : BASIS_APPEARANCE

  // 伸缩量缺失：先挂起，等补齐再判。
  if (extension === null) {
    return {
      state: VERDICT_SUSPENDED,
      verdict: null,
      locked: false,
      suspended: true,
      basis: '伸缩量缺失',
      reason: '伸缩量缺失，先挂起，补齐现场数据后再提交判定',
    }
  }

  // 外观检查表未载明可核定结论时，以有结论的伸缩量为准。
  if (appearance === null) {
    return {
      state: extension,
      verdict: extension,
      locked: false,
      suspended: false,
      basis: `${BASIS_EXTENSION}（外观检查表未载明缺陷）`,
      reason: `伸缩量口径核定为「${extension}」`,
    }
  }

  // 两份口径一致。
  if (appearance === extension) {
    return {
      state: extension,
      verdict: extension,
      locked: false,
      suspended: false,
      basis: `${BASIS_APPEARANCE}、${BASIS_EXTENSION}一致`,
      reason: `外观状况与伸缩量均核定为「${extension}」`,
    }
  }

  // 冲突：以现场检查人签字的那一份为准。
  const verdict = signed === BASIS_APPEARANCE ? appearance : extension
  return {
    state: verdict,
    verdict,
    locked: false,
    suspended: false,
    basis: `现场检查人签字（${signed}）`,
    reason: `外观状况与伸缩量结论冲突，按现场检查人签字的${signed}核定为「${verdict}」`,
  }
}

/**
 * 列表/导出/汇总共用的同一份归类：把通用 status 与「部件状态」字段统一改写成
 * classifyCompensator 的结论。返回副本，不动存储。
 */
export function decorateCompensatorRow(row: EntryRow): EntryRow {
  const { state } = classifyCompensator(row)
  return { ...row, status: state, 部件状态: state }
}

/** 判定为需更换的，落到阀门井那边的待检查清单；同一检查编号只落一条。 */
function queueValveWellInspection(source: EntryRow): boolean {
  const rows = listRows(VALVE_WELL_KEY)
  const ref = textOf(source['检查编号'])
  const alreadyQueued = rows.some((row) => textOf(row[SOURCE_REF_FIELD]) === ref)
  if (alreadyQueued) {
    return false
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const today = new Date().toISOString().slice(0, 10)
  const entry: EntryRow = {
    id: nextId,
    status: '待检查',
    pending: true,
    abnormal: false,
    井编号: `VALV-${ref}`,
    所属管段: textOf(source['所属管段']),
    井盖状况: '待检查',
    阀门型号: '—',
    检查人: '待安排',
    检查日期: today,
    养护措施: `补偿器 ${ref} 判定需更换，待入井核查`,
    井体状态: '待检查',
    [SOURCE_REF_FIELD]: ref,
  }
  saveRows(VALVE_WELL_KEY, [...rows, entry])
  return true
}

/** 补偿器动作入口：提交检查走流程，提交判定走统一口径，动作回执幂等。 */
export function applyCompensatorAction(id: number, action: string): ActionResult {
  if (action !== '提交检查' && action !== '提交判定') {
    return { ok: false, message: `补偿器检查记录没有登记「${action}」这个动作` }
  }

  const rows = listRows(COMPENSATOR_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的补偿器检查记录` }
  }
  const row = rows[index]
  const classification = classifyCompensator(row)

  if (classification.locked) {
    // 重复提交判定：结论不动、不重落阀门井，只回这一条。
    return {
      ok: false,
      message: `该部件历史已判定为「${classification.state}」，结论保持原样，无需重复提交`,
    }
  }

  if (action === '提交检查') {
    if (String(row.status) !== FLOW_AWAITING_INSPECTION) {
      return { ok: false, message: '现场检查已提交，可直接提交判定' }
    }
    const updated: EntryRow = { ...row, status: FLOW_IN_INSPECTION, pending: true }
    const next = [...rows]
    next[index] = updated
    saveRows(COMPENSATOR_KEY, next)
    const after = classifyCompensator(updated)
    return {
      ok: true,
      message: after.suspended
        ? '现场检查已提交；伸缩量缺失，已先挂起，补齐后再提交判定'
        : '现场检查已提交，可提交判定',
    }
  }

  // 提交判定：按唯一口径核定。
  if (String(row.status) === FLOW_AWAITING_INSPECTION) {
    return { ok: false, message: '请先提交现场检查，再提交判定' }
  }
  if (classification.suspended) {
    return { ok: false, message: classification.reason }
  }
  const verdict = classification.verdict
  if (!verdict) {
    return { ok: false, message: '现场数据不足以核定，补齐外观状况与伸缩量后再提交判定' }
  }

  const updated: EntryRow = {
    ...row,
    status: verdict,
    部件状态: verdict,
    pending: false,
    abnormal: verdict === VERDICT_REPLACE,
    [LOCKED_FIELD]: true,
    [JUDGE_BASIS_FIELD]: classification.basis,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(COMPENSATOR_KEY, next)

  let message = `已按${classification.basis}核定：部件状态为「${verdict}」，检查记录、列表与导出已同步`
  if (verdict === VERDICT_REPLACE) {
    const queued = queueValveWellInspection(updated)
    message += queued ? '，已列入阀门井待检查清单' : '，阀门井待检查清单中已有同项，不重复落单'
  }
  return { ok: true, message }
}
