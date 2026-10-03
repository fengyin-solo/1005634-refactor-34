<template>
  <section class="page" data-module="compensator">
    <header class="page-head">
      <div>
        <h2>补偿器检查管理</h2>
        <p class="page-desc">
          外观状况与伸缩量两套口径由同一份归类实现核定：冲突时以现场检查人签字的那份为准，伸缩量缺失先挂起，历史已判定结论原样保留；列表、导出、汇总共用。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记补偿器检查记录</button>
        <button class="btn" type="button" @click="exportRows">导出补偿器检查清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>部件状态</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td :title="resolveRow(row).reason">
            <span :class="categoryClass(resolveRow(row).category)">
              {{ resolveRow(row).category }}
              <em v-if="!resolveRow(row).signed" class="signed-hint">（未签字）</em>
            </span>
          </td>
          <td>{{ statusText(row) }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="runAction('提交检查', row)">提交检查</button>
            <button class="link" type="button" @click="toggleDecision(row)">
              {{ decidingId === Number(row.id) ? '收起判定' : resolveRow(row).signed ? '重新判定' : '提交判定' }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无补偿器检查数据，可先登记补偿器检查记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 现场检查人签字判定：两套口径冲突时以这里勾选的那份为准；伸缩量缺失只允许挂起 -->
    <form v-if="decidingRow" class="decision-panel" @submit.prevent="confirmDecision">
      <h3>现场判定 · {{ decidingRow['检查编号'] }}（{{ decidingRow['所属管段'] }}）</h3>
      <p class="decision-verdicts">
        <span>外观口径：<b>{{ panelPreview.appearanceVerdict }}</b></span>
        <span>伸缩量口径：<b>{{ panelPreview.extensionVerdict }}</b></span>
        <span v-if="panelPreview.conflict" class="conflict-hint">两口径冲突，以签字单为准</span>
      </p>
      <p v-if="panelPreview.category === '挂起'" class="error-text">{{ panelPreview.reason }}</p>
      <label class="filter-item">
        <span>签字采用的检查单</span>
        <select v-model="decisionBasis" :disabled="panelPreview.category === '挂起'">
          <option value="appearance">外观状况单</option>
          <option value="extension">伸缩量记录单</option>
        </select>
      </label>
      <label class="filter-item">
        <span>现场检查人签字</span>
        <input v-model="decisionInspector" placeholder="检查人姓名" />
      </label>
      <div class="page-actions">
        <button class="btn primary" type="submit" :disabled="panelPreview.category === '挂起'">
          确认提交判定
        </button>
        <button class="btn ghost" type="button" @click="cancelDecision">取消</button>
      </div>
    </form>

    <footer class="page-foot">
      <span>共 {{ total }} 条补偿器检查记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  displayStatus,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitCompensatorDecision,
} from '@/api/local-service'
import {
  classifyByAppearance,
  classifyByExtension,
  parseExtension,
  resolveEntry,
  CATEGORY_PENDING,
  CATEGORY_REPLACE,
  CATEGORY_NORMAL,
  type Category,
  type VerdictBasis,
} from '@/domain/compensator'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('compensator')
// 列与导出字段同源，部件状态不再读登记值，统一从归类实现取。
const columns = [
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

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(true)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const decidingId = ref<number | null>(null)
const decisionBasis = ref<VerdictBasis>('appearance')
const decisionInspector = ref('')

const decidingRow = computed(() =>
  rows.value.find((row) => Number(row.id) === decidingId.value) ?? null,
)

// 面板内按当前勾选依据实时预判签字后会落什么结论；伸缩量缺失时只有挂起。
const panelPreview = computed(() => {
  const empty = {
    appearanceVerdict: CATEGORY_NORMAL,
    extensionVerdict: CATEGORY_PENDING,
    category: CATEGORY_PENDING as Category,
    conflict: false,
    reason: '',
  }
  const row = decidingRow.value
  if (!row) {
    return empty
  }
  const appearanceVerdict = classifyByAppearance(String(row['外观状况'] ?? ''))
  const extensionVerdict = classifyByExtension(
    parseExtension(row['伸缩量']),
    parseExtension(row['额定补偿能力']),
  )
  if (extensionVerdict === CATEGORY_PENDING) {
    return {
      ...empty,
      appearanceVerdict,
      extensionVerdict,
      reason: '伸缩量缺失，先挂起，补齐伸缩量并复测后再判定',
    }
  }
  const conflict = appearanceVerdict !== extensionVerdict
  const category = (
    conflict
      ? decisionBasis.value === 'appearance'
        ? appearanceVerdict
        : extensionVerdict
      : appearanceVerdict
  ) as Category
  return {
    appearanceVerdict,
    extensionVerdict,
    category,
    conflict,
    reason: conflict ? '外观与伸缩量判定冲突，将按现场签字采用的检查单归类' : '',
  }
})

const resolvedRows = computed(() =>
  rows.value.map((row) => ({ row, resolved: resolveEntry(row) })),
)

// 汇总与列表、导出同一份归类。
const stats = computed(() => [
  {
    label: '待检查补偿器',
    value: resolvedRows.value.filter(({ resolved, row }) =>
      ['待检查', '检查中'].includes(String(row.status)) && !resolved.signed,
    ).length,
  },
  {
    label: '挂起补偿器',
    value: resolvedRows.value.filter(({ resolved }) => resolved.category === CATEGORY_PENDING).length,
  },
  {
    label: '状态正常补偿器',
    value: resolvedRows.value.filter(({ resolved }) => resolved.category === CATEGORY_NORMAL).length,
  },
  {
    label: '需更换补偿器',
    value: resolvedRows.value.filter(({ resolved }) => resolved.category === CATEGORY_REPLACE).length,
  },
])

const statusSummary = computed(() =>
  [CATEGORY_NORMAL, CATEGORY_REPLACE, CATEGORY_PENDING].map((status) => ({
    status,
    count: resolvedRows.value.filter(({ resolved }) => resolved.category === status).length,
  })),
)

function resolveRow(row: EntryRow) {
  return resolveEntry(row)
}

function statusText(row: EntryRow): string {
  const resolved = resolveEntry(row)
  return displayStatus(String(row.status), resolved.category, resolved.signed)
}

function categoryClass(category: Category): string {
  if (category === CATEGORY_REPLACE) {
    return 'tag tag-replace'
  }
  if (category === CATEGORY_PENDING) {
    return 'tag tag-pending'
  }
  return 'tag tag-normal'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  setMessage('补偿器检查记录登记入口尚未接入审批流', false)
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  setMessage(result.message, result.ok)
  reload()
}

function toggleDecision(row: EntryRow) {
  if (decidingId.value === Number(row.id)) {
    cancelDecision()
    return
  }
  decidingId.value = Number(row.id)
  const resolved = resolveEntry(row)
  decisionBasis.value = resolved.basis ?? 'appearance'
  decisionInspector.value = String(row['检查人'] ?? '')
}

function cancelDecision() {
  decidingId.value = null
}

function confirmDecision() {
  if (decidingId.value === null) {
    return
  }
  const result = submitCompensatorDecision({
    entryId: decidingId.value,
    inspector: decisionInspector.value.trim(),
    basis: decisionBasis.value,
  })
  setMessage(result.message, result.ok)
  if (result.ok) {
    cancelDecision()
  }
  reload()
}

function setMessage(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '补偿器检查列表读取失败', false)
  }
}

onMounted(reload)
</script>

<style scoped>
.tag {
  font-style: normal;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
}
.tag-normal {
  background: #e7f6ec;
  color: #177245;
}
.tag-replace {
  background: #fdecec;
  color: #b42318;
}
.tag-pending {
  background: #fdf3e0;
  color: #b25e09;
}
.signed-hint {
  color: var(--muted);
  font-size: 12px;
}
.decision-panel {
  margin-top: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}
.decision-panel h3 {
  width: 100%;
  margin: 0;
  font-size: 14px;
}
.decision-verdicts {
  width: 100%;
  display: flex;
  gap: 16px;
  margin: 0;
  font-size: 13px;
}
.conflict-hint {
  color: #b25e09;
}
.ok-text {
  color: #177245;
}
</style>
