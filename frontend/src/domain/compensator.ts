import { readJson, writeJson } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

/**
 * 补偿器检查：判定与归类的唯一实现。
 *
 * 检查记录表、列表、导出、汇总都走本文件，不再各写一遍。
 * 口径只有两套：外观状况口径、伸缩量口径；二者冲突时，以现场检查人签字
 * 的那份（判定依据）为准；伸缩量缺失时先挂起；历史记录里已经判定过的
 * 部件状态保持原样，不再用新口径重新判。
 */

// —— 归类结论（检查记录表的「部件状态」、列表、导出、汇总共用这一套）——
export const CATEGORY_NORMAL = '状态正常'
export const CATEGORY_REPLACE = '需更换'
export const CATEGORY_PENDING = '挂起'

export type Category = typeof CATEGORY_NORMAL | typeof CATEGORY_REPLACE | typeof CATEGORY_PENDING

export type VerdictBasis = 'appearance' | 'extension'

export type AppearanceVerdict = typeof CATEGORY_NORMAL | typeof CATEGORY_REPLACE

export type ClassifyInput = {
  appearance: string
  /** 伸缩量数值（mm），现场没量或没登记时为空 */
  extension?: number | null
  /** 额定补偿能力（mm），按补偿器型号核定；缺省时按伸缩量绝对值兜底 */
  ratedExtension?: number | null
  /** 现场检查人签字采用的那份：外观状况 or 伸缩量 */
  verdictBasis?: VerdictBasis
  /** 判定后由判定台账带回来，导出等场景需要呈现 */
  reason?: string
}

export type Classified = {
  category: Category
  reason: string
  /** 各口径的判定过程，供列表/导出核对，避免再各写一遍 */
  appearanceVerdict: AppearanceVerdict
  extensionVerdict: AppearanceVerdict | typeof CATEGORY_PENDING
  conflict: boolean
}

// 外观状况里只要出现以下任一情形，外观口径即判「需更换」。
const APPEARANCE_REPLACE_KEYWORDS = [
  '腐蚀严重',
  '严重锈蚀',
  '锈蚀严重',
  '变形',
  '裂纹',
  '渗漏',
  '泄漏',
  '破损',
  '断裂',
  '焊缝开裂',
]

// 沿用既有补偿器口径核定：伸缩量超出额定补偿能力的 80% 判需更换。
const EXTENSION_LIMIT_RATIO = 0.8

// 判定台账：同一条补偿器检查记录只有一条，重复提交判定幂等重提只落一条。
const DECISION_STORAGE_KEY = 'district-heating:compensator-decisions:v1'
// 判定为需更换后推送到阀门井那边的待检查清单，按补偿器检查记录去重。
const VALVE_PENDING_STORAGE_KEY = 'district-heating:valve-well-pending:v1'
// 区分「还没读过」与「用户已经清空」，只在首次读取时播种历史台账。
const SEED_VERSION_KEY = 'district-heating:compensator-seed:v1'

export type DecisionRecord = {
  entryId: number
  category: Category
  basis: VerdictBasis
  appearanceVerdict: AppearanceVerdict
  extensionVerdict: AppearanceVerdict | typeof CATEGORY_PENDING
  reason: string
  inspector: string
  decidedAt: string
}

export type ValvePendingItem = {
  /** 来源补偿器检查记录，重复判定只更新这一条，不重复落单 */
  compensatorEntryId: number
  井编号: string
  所属管段: string
  来源检查编号: string
  提出人: string
  提出时间: string
}

// 历史检查周期里已经签字判定过的记录：部件状态按当时结论原样保留，
// 不随新口径重判；这里只播种判定台账，不再写别的副本。
export const SEED_DECISIONS: DecisionRecord[] = [
  {
    entryId: 3,
    category: CATEGORY_REPLACE,
    basis: 'extension',
    appearanceVerdict: CATEGORY_NORMAL,
    extensionVerdict: CATEGORY_REPLACE,
    reason: '外观与伸缩量判定冲突，按现场检查人签字的伸缩量单判需更换',
    inspector: '何建峰',
    decidedAt: '2026-08-20T10:30:00.000Z',
  },
  {
    entryId: 4,
    category: CATEGORY_NORMAL,
    basis: 'extension',
    appearanceVerdict: CATEGORY_REPLACE,
    extensionVerdict: CATEGORY_NORMAL,
    reason: '外观与伸缩量判定冲突，按现场检查人签字的伸缩量单判状态正常',
    inspector: '何建峰',
    decidedAt: '2026-07-15T14:05:00.000Z',
  },
]

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

/** 从「80mm」「80 毫米」这类登记值里取数值；取不到按缺失处理。 */
export function parseExtension(raw: unknown): number | null {
  if (isBlank(raw)) {
    return null
  }
  const matched = String(raw).match(/-?\d+(?:\.\d+)?/)
  if (!matched) {
    return null
  }
  const value = Number(matched[0])
  return Number.isFinite(value) ? value : null
}

/**
 * 外观状况口径：按现场看到的外观判。
 * 先剥掉「无变形 / 未见裂纹 / 未发现渗漏」这类带否定前缀的描述，
 * 再做关键词命中，避免把否定句误判成缺陷。
 */
export function classifyByAppearance(appearance: string): AppearanceVerdict {
  const text = String(appearance ?? '')
  const stripped = text.replace(
    /(?:无|没有|未见|未发现|无明显|无任何)[^，。；,;]{0,8}?(?:腐蚀严重|严重锈蚀|锈蚀严重|变形|裂纹|渗漏|泄漏|破损|断裂|焊缝开裂)/g,
    '',
  )
  return APPEARANCE_REPLACE_KEYWORDS.some((keyword) => stripped.includes(keyword))
    ? CATEGORY_REPLACE
    : CATEGORY_NORMAL
}

/** 伸缩量口径：伸缩量缺失先挂起；有值再按既有补偿器口径核定。 */
export function classifyByExtension(
  extension?: number | null,
  ratedExtension?: number | null,
): AppearanceVerdict | typeof CATEGORY_PENDING {
  if (extension === null || extension === undefined || !Number.isFinite(extension)) {
    return CATEGORY_PENDING
  }
  const limit =
    ratedExtension !== null &&
    ratedExtension !== undefined &&
    Number.isFinite(ratedExtension) &&
    ratedExtension > 0
      ? ratedExtension * EXTENSION_LIMIT_RATIO
      : Math.abs(extension)
  return Math.abs(extension) > limit ? CATEGORY_REPLACE : CATEGORY_NORMAL
}

/**
 * 唯一的归类入口。返回最终部件状态与两套口径的判定过程。
 * 外观状况与伸缩量冲突时，以现场检查人签字的那份（verdictBasis）为准；
 * 伸缩量口径自身因数据缺失挂起时，挂起优先，等数据补齐再判。
 */
export function classifyCompensator(input: ClassifyInput): Classified {
  const appearanceVerdict = classifyByAppearance(input.appearance)
  const extensionVerdict = classifyByExtension(input.extension, input.ratedExtension)

  if (extensionVerdict === CATEGORY_PENDING) {
    return {
      category: CATEGORY_PENDING,
      reason: '伸缩量缺失，先挂起，待补测后再判',
      appearanceVerdict,
      extensionVerdict,
      conflict: false,
    }
  }

  const conflict = appearanceVerdict !== extensionVerdict
  if (!conflict) {
    return {
      category: appearanceVerdict,
      reason:
        appearanceVerdict === CATEGORY_REPLACE
          ? '外观状况与伸缩量均判需更换'
          : '外观状况与伸缩量均判状态正常',
      appearanceVerdict,
      extensionVerdict,
      conflict: false,
    }
  }

  if (!input.verdictBasis) {
    // 两套口径打架但现场签字的那份还没确认，不替检查人做主，先挂起。
    return {
      category: CATEGORY_PENDING,
      reason: '外观状况与伸缩量判定冲突，待现场检查人签字确认以哪份为准',
      appearanceVerdict,
      extensionVerdict,
      conflict: true,
    }
  }

  const category = input.verdictBasis === 'appearance' ? appearanceVerdict : extensionVerdict
  return {
    category,
    reason:
      input.reason ??
      `外观口径判${appearanceVerdict}、伸缩量口径判${extensionVerdict}，按现场检查人签字的${
        input.verdictBasis === 'appearance' ? '外观状况' : '伸缩量'
      }单取${category}`,
    appearanceVerdict,
    extensionVerdict,
    conflict: true,
  }
}

export function readDecisions(): DecisionRecord[] {
  if (!readJson<boolean>(SEED_VERSION_KEY, false)) {
    writeJson(SEED_VERSION_KEY, true)
    const existing = readJson<DecisionRecord[]>(DECISION_STORAGE_KEY, [])
    const merged = [...existing]
    for (const seed of SEED_DECISIONS) {
      if (!merged.some((item) => item.entryId === seed.entryId)) {
        merged.push(seed)
      }
    }
    writeJson(DECISION_STORAGE_KEY, merged)
    return merged
  }
  return readJson<DecisionRecord[]>(DECISION_STORAGE_KEY, [])
}

function saveDecisions(records: DecisionRecord[]): void {
  writeJson(DECISION_STORAGE_KEY, records)
}

export function findDecision(entryId: number): DecisionRecord | undefined {
  return readDecisions().find((item) => item.entryId === entryId)
}

/**
 * 对一条检查记录做归类。历史记录里已经判定过的部件状态保持原样，
 * 台账里的结论直接返回，不再拿新口径重判；没有判定台账的才按现口径归类。
 */
export function resolveEntry(row: EntryRow): Classified & { signed: boolean; basis?: VerdictBasis } {
  const decision = findDecision(Number(row.id))
  if (decision) {
    return {
      category: decision.category,
      reason: decision.reason,
      appearanceVerdict: decision.appearanceVerdict,
      extensionVerdict: decision.extensionVerdict,
      conflict: decision.appearanceVerdict !== decision.extensionVerdict,
      signed: true,
      basis: decision.basis,
    }
  }
  const classified = classifyCompensator({
    appearance: String(row['外观状况'] ?? ''),
    extension: parseExtension(row['伸缩量']),
    ratedExtension: parseExtension(row['额定补偿能力']),
    verdictBasis: normalizeBasis(row['判定依据']),
  })
  return { ...classified, signed: false }
}

export function normalizeBasis(raw: unknown): VerdictBasis | undefined {
  if (raw === 'extension' || String(raw) === '伸缩量') {
    return 'extension'
  }
  if (raw === 'appearance' || String(raw) === '外观状况') {
    return 'appearance'
  }
  return undefined
}

export type SubmitResult =
  | {
      ok: true
      category: Category
      reason: string
      duplicated: boolean
      record: DecisionRecord
    }
  | { ok: false; message: string }

export type SubmitDecisionInput = {
  entryId: number
  inspector: string
  basis: VerdictBasis
}

/**
 * 提交现场检查人签字判定。
 * 重复提交判定重提只落一条：同记录已有结论时不新增，只更新同一条台账，
 * 并同步阀门井待检查清单（改判后旧结论对应的待检条目随之收走/落下）。
 */
export function submitDecision(
  rows: EntryRow[],
  input: SubmitDecisionInput,
  now: Date = new Date(),
): SubmitResult {
  const row = rows.find((item) => Number(item.id) === input.entryId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${input.entryId} 的补偿器检查记录` }
  }
  if (isBlank(input.inspector)) {
    return { ok: false, message: '现场检查人未签字，判定不能提交' }
  }

  const extension = parseExtension(row['伸缩量'])
  if (extension === null) {
    // 伸缩量缺失的先挂起，不允许在缺数据的情况下落判定结论。
    return { ok: false, message: '伸缩量缺失，先挂起；补齐伸缩量并复测后再提交判定' }
  }

  const classified = classifyCompensator({
    appearance: String(row['外观状况'] ?? ''),
    extension,
    ratedExtension: parseExtension(row['额定补偿能力']),
    verdictBasis: input.basis,
  })
  if (classified.category === CATEGORY_PENDING) {
    return { ok: false, message: classified.reason }
  }

  const records = readDecisions()
  const previous = records.find((item) => item.entryId === input.entryId)
  const record: DecisionRecord = {
    entryId: input.entryId,
    category: classified.category,
    basis: input.basis,
    appearanceVerdict: classified.appearanceVerdict,
    extensionVerdict: classified.extensionVerdict,
    reason: classified.reason,
    inspector: input.inspector,
    decidedAt: now.toISOString(),
  }
  const next = previous
    ? records.map((item) => (item.entryId === input.entryId ? record : item))
    : [...records, record]
  saveDecisions(next)
  syncValvePending(row, record)
  return {
    ok: true,
    category: record.category,
    reason: record.reason,
    duplicated: Boolean(previous),
    record,
  }
}

// —— 判定结论落到阀门井那边的待检查清单 ——

export function readValvePending(): ValvePendingItem[] {
  return readJson<ValvePendingItem[]>(VALVE_PENDING_STORAGE_KEY, [])
}

/**
 * 判定为需更换：在阀门井待检查清单里按补偿器记录落/更新一条；
 * 判定为状态正常（或改判回正常）：把此前落过的待检条目收走，不残留。
 */
function syncValvePending(row: EntryRow, decision: DecisionRecord): void {
  const items = readValvePending()
  const kept = items.filter((item) => item.compensatorEntryId !== decision.entryId)
  if (decision.category !== CATEGORY_REPLACE) {
    writeJson(VALVE_PENDING_STORAGE_KEY, kept)
    return
  }
  const 管段 = String(row['所属管段'] ?? '').trim()
  const item: ValvePendingItem = {
    compensatorEntryId: decision.entryId,
    井编号: resolveWellCode(row),
    所属管段: 管段,
    来源检查编号: String(row['检查编号'] ?? decision.entryId),
    提出人: decision.inspector,
    提出时间: new Date(decision.decidedAt).toLocaleString(),
  }
  writeJson(VALVE_PENDING_STORAGE_KEY, [...kept, item])
}

/** 优先用记录上登记的阀门井编号；没登记就按所属管段给阀门井对单。 */
function resolveWellCode(row: EntryRow): string {
  const explicit = String(row['阀门井编号'] ?? '').trim()
  if (explicit) {
    return explicit
  }
  const 管段 = String(row['所属管段'] ?? '').trim()
  return 管段 ? `待落实（管段：${管段}）` : '待落实'
}
