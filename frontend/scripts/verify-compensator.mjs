import {
  classifyCompensator,
  classifyByAppearance,
  classifyByExtension,
  parseExtension,
  resolveEntry,
  submitDecision,
  readValvePending,
  CATEGORY_NORMAL,
  CATEGORY_REPLACE,
  CATEGORY_PENDING,
} from '../src/domain/compensator'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name}`)
  }
}

// 1. 外观口径
check('外观-完好判正常', classifyByAppearance('外观完好，无锈蚀变形') === CATEGORY_NORMAL)
check('外观-腐蚀严重判更换', classifyByAppearance('波纹管局部腐蚀严重，有凹坑') === CATEGORY_REPLACE)
check('外观-浮锈不算更换', classifyByAppearance('表面浮锈，未见变形') === CATEGORY_NORMAL)

// 2. 伸缩量口径（80% 额定能力）
check('伸缩量解析', parseExtension('88mm') === 88)
check('伸缩量缺失返回 null', parseExtension('') === null)
check('伸缩量-未超限正常', classifyByExtension(42, 100) === CATEGORY_NORMAL)
check('伸缩量-超限更换', classifyByExtension(88, 100) === CATEGORY_REPLACE)
check('伸缩量-缺失挂起', classifyByExtension(null, 100) === CATEGORY_PENDING)

// 3. 统一归类：冲突按签字
const conflict = { appearance: '表面浮锈，未见变形', extension: 88, ratedExtension: 100 }
check('冲突无签字->挂起', classifyCompensator(conflict).category === CATEGORY_PENDING)
check(
  '冲突签字外观->正常',
  classifyCompensator({ ...conflict, verdictBasis: 'appearance' }).category === CATEGORY_NORMAL,
)
check(
  '冲突签字伸缩量->更换',
  classifyCompensator({ ...conflict, verdictBasis: 'extension' }).category === CATEGORY_REPLACE,
)

// 4. 一致
check(
  '两口径一致正常',
  classifyCompensator({ appearance: '完好', extension: 30, ratedExtension: 100 }).category ===
    CATEGORY_NORMAL,
)

// 5. 伸缩量缺失挂起，即便外观看起来坏
check(
  '缺失优先挂起',
  classifyCompensator({
    appearance: '腐蚀严重',
    extension: null,
    ratedExtension: 100,
    verdictBasis: 'appearance',
  }).category === CATEGORY_PENDING,
)

// 6. 提交流程：幂等、写回、阀门井清单
const rows = [
  {
    id: 101,
    status: '检查中',
    pending: true,
    abnormal: false,
    检查编号: 'COMP-T1',
    所属管段: 'SEC-X',
    外观状况: '表面浮锈，未见变形',
    伸缩量: '88mm',
    额定补偿能力: '100mm',
    阀门井编号: 'VALV-0009',
    检查人: '测试员',
  },
  {
    id: 102,
    status: '待检查',
    pending: true,
    abnormal: false,
    检查编号: 'COMP-T2',
    所属管段: 'SEC-Y',
    外观状况: '完好',
    伸缩量: '',
    额定补偿能力: '80mm',
    阀门井编号: '',
    检查人: '测试员',
  },
]

// 缺失伸缩量不允许判定
const blocked = submitDecision(rows, { entryId: 102, inspector: '测试员', basis: 'appearance' })
check('缺失伸缩量判定被拒', blocked.ok === false)
check('拒绝后无待检条目', readValvePending().length === 0)

// 签字伸缩量 -> 需更换
const r1 = submitDecision(rows, { entryId: 101, inspector: '测试员', basis: 'extension' })
check('首次判定成功', r1.ok && r1.category === CATEGORY_REPLACE && r1.duplicated === false)
check('阀门井清单落一条', readValvePending().length === 1)
check('待检条目井编号', readValvePending()[0].井编号 === 'VALV-0009')

// 重复提交只落一条
const r2 = submitDecision(rows, { entryId: 101, inspector: '测试员', basis: 'extension' })
check('重复判定标记 duplicated', r2.ok === true && r2.duplicated === true)
check('重复判定仍只一条', readValvePending().length === 1)

// 改判外观->正常，待检条目收走
const r3 = submitDecision(rows, { entryId: 101, inspector: '测试员', basis: 'appearance' })
check('改判正常', r3.ok && r3.category === CATEGORY_NORMAL)
check('改判后待检清单清空', readValvePending().length === 0)

// 7. 历史判定结论原样保留：resolveEntry 直接读台账，不因现口径变化
const hist = resolveEntry({ ...rows[0], id: 999, 外观状况: '完好', 伸缩量: '10mm' })
check('无台账走现口径', hist.signed === false && hist.category === CATEGORY_NORMAL)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
