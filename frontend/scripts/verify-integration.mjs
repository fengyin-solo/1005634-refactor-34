import { SEED_ROWS } from '../src/data/seed'
import { exportEntries, listEntries, displayStatus } from '../src/api/local-service'
import { resolveEntry, readValvePending } from '../src/domain/compensator'

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
  if (!cond) failures++
}

const rows = listEntries('compensator').items
check('种子 6 条补偿器', rows.length === 6)

const byId = Object.fromEntries(rows.map((r) => [Number(r.id), r]))

// 历史已判定（id 3、4）：resolveEntry 直接取台账，部件状态保持原样
check('历史 id3 需更换保留', resolveEntry(byId[3]).category === '需更换')
check('历史 id3 显示已签字', resolveEntry(byId[3]).signed === true)
check('历史 id4 状态正常保留（即便外观含腐蚀严重）', resolveEntry(byId[4]).category === '状态正常')

// id5 伸缩量缺失 -> 挂起
check('id5 伸缩量缺失挂起', resolveEntry(byId[5]).category === '挂起')

// id1 一致正常、id2 冲突未签字挂起、id6 一致正常
check('id1 一致正常未签字', resolveEntry(byId[1]).category === '状态正常')
check('id2 冲突未签字挂起', resolveEntry(byId[2]).category === '挂起')
check('id6 一致正常', resolveEntry(byId[6]).category === '状态正常')

// 流程状态呈现：已判定显示归类；未判定保留流程，挂起带标记
check('历史行当前状态=归类', displayStatus(String(byId[3].status), '需更换', true) === '需更换')
check('挂起行当前状态带标记', displayStatus('待检查', '挂起', false) === '待检查·挂起')
check('普通未判定保留流程', displayStatus('检查中', '状态正常', false) === '检查中')

// 导出 CSV：历史 id4 外观口径需更换但部件状态仍为状态正常，证明导出不再另判
const csv = exportEntries('compensator').content
const lines = csv.split('\n')
check('导出行数=表头+6', lines.length === 7)
const id4Line = lines.find((l) => l.startsWith('4,'))
check('导出 id4 含部件状态=状态正常', id4Line.includes('状态正常'))
const id5Line = lines.find((l) => l.startsWith('5,'))
check('导出 id5 挂起', id5Line.includes('挂起'))
check('导出表头含两口径列', lines[0].includes('外观口径') && lines[0].includes('伸缩量口径'))

// 初始阀门井待检查清单：历史 id3 需更换的结论不在新清单（历史台账不重放推送）
check('初始阀门井待检为空（历史不重推）', readValvePending().length === 0)

console.log(failures === 0 ? '\n集成冒烟全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
