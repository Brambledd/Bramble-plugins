// CJK short-note control: does the hash vector lane help SHORT Chinese
// notes? Three query regimes — (a) exact-term >=3 chars (BM25 trigram
// territory), (b) 2-char key terms (trigram blind spot, LIKE/probe rescue),
// (c) synonym paraphrase (true vocabulary gap). Compares BM25-only vs
// hybrid (hash backend + CJK x1.5 boost) on the same corpus.
import { EvidenceStore } from '../packages/core/src/store.js';
import { createEmbeddingBackend } from '../packages/core/src/embedding.js';
import { computeRevision } from '../packages/core/src/util.js';

const NOTES = [
  ['n1', '用户计划明年三月去日本京都看樱花，已经订好了大阪的酒店，正在研究从关西机场到京都的交通方式。'],
  ['n2', '用户正在学习 Rust 语言，觉得所有权机制很难理解，打算先写几个小项目练手，目标是半年内能独立开发命令行工具。'],
  ['n3', '用户的猫叫团子，今年三岁，最近总是挑食，兽医建议换成湿粮并增加喂水频率。'],
  ['n4', '用户负责的项目组下周要迁移代码仓库到内网 GitLab，需要提前备份所有分支和标签，还要通知团队成员更新远程地址。'],
  ['n5', '用户喜欢在周末骑车穿越城市绿道，最远一次骑了六十公里，下一步想购买一辆更轻量的碳纤维公路车。'],
  ['n6', '用户的母亲高血压，医生开了氨氯地平，需要每天早晚各测量一次血压并记录在家庭健康本上。'],
  ['n7', '用户打算考取 PMP 项目管理证书，报名了十二月的考试，每天晚上复习一小时，重点背十五节的过程组知识。'],
  ['n8', '用户的公司搬到了高新区新办公楼，通勤时间从二十分钟变成一个小时，正在考虑地铁还是自驾。'],
  ['n9', '用户在装修新房，倾向原木风客厅，厨房要做嵌入式烤箱，预算控制在三十万以内，工期预计四个月。'],
  ['n10', '用户的孩子九月份上小学一年级，已经买好书包和文具，正在纠结报名公立小学还是私立双语学校。'],
];

// queries: [query, goldNote, regime]
const QUERIES = [
  ['用户为什么觉得 Rust 所有权机制难', 'n2', 'exact'],
  ['用户母亲的高血压吃什么药', 'n6', 'exact'],
  ['用户新房装修什么风格', 'n9', 'exact'],
  ['用户的猫团子情况', 'n3', '2char'],
  ['团子挑食怎么办', 'n3', '2char'],
  ['用户骑车情况', 'n5', '2char'],
  ['项目组仓库迁移要做什么', 'n4', '2char'],
  ['出行旅游目的地赏花', 'n1', 'synonym'],
  ['编程语言学习困难', 'n2', 'synonym'],
  ['宠物健康饮食问题', 'n3', 'synonym'],
  ['上班通勤方式选择', 'n8', 'synonym'],
  ['孩子教育学校选择', 'n10', 'synonym'],
  ['健康管理血压监测', 'n6', 'synonym'],
  ['运动健身装备购买', 'n5', 'synonym'],
  ['房屋装修预算工期', 'n9', 'synonym'],
  ['职业资格认证备考', 'n7', 'synonym'],
];

function run(withVec) {
  const store = new EvidenceStore(':memory:');
  if (withVec) store.attachEmbedding(createEmbeddingBackend({ enabled: true, backend: 'hash' }));
  for (const [anchor, summary] of NOTES) {
    store.upsert({ anchor, kind: 'note', status: 'active', authority: 'standard', title: summary.slice(0, 40), summary, keywords: [], sourcePath: null, revision: computeRevision(summary), supersededBy: null });
  }
  return {
    query: (q) => store.search({ query: q, limit: 3 }).items.map((i) => i.anchor),
    close: () => store.close(),
  };
}

const regimes = { exact: [0, 0], '2char': [0, 0], synonym: [0, 0] };
const detail = [];
for (const [q, gold, regime] of QUERIES) {
  const bm = run(false);
  const hy = run(true);
  const bmTop = bm.query(q)[0] ?? '-';
  const hyTop = hy.query(q)[0] ?? '-';
  bm.close(); hy.close();
  if (bmTop === gold) regimes[regime][0] += 1;
  if (hyTop === gold) regimes[regime][1] += 1;
  detail.push({ q, gold, bm25: bmTop, hybrid: hyTop });
}

console.log('regime      BM25  hybrid  (top-1 accuracy)');
for (const [r, [b, h]] of Object.entries(regimes)) {
  const n = QUERIES.filter((x) => x[2] === r).length;
  console.log(`${r.padEnd(10)}  ${(b / n).toFixed(2)}   ${(h / n).toFixed(2)}   (n=${n})`);
}
console.log('\ndisagreements (bm25 wrong / hybrid right, and vice versa):');
for (const d of detail) {
  if (d.bm25 !== d.hybrid) console.log(`  [${d.gold}] bm25=${d.bm25} hybrid=${d.hybrid} q="${d.q}"`);
}
