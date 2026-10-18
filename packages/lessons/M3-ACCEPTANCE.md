# M3 验收报告 — lessons（教训沉淀）+ events（时间记忆）

日期：2026-10-18 · 状态：**已验收** · 全仓 34/34 测试绿（core 15 + decisions 8 + lessons 5 + events 7）· 真实 headless e2e 通过

## 交付物

### @local/dsh-memory-lessons（M3a：教训蒸馏）

| 文件 | 内容 |
|---|---|
| `src/candidate-store.js` | 候选库（独立 truth-side SQLite）：nominate→pending→approve/reject→materialize，slug 消歧 |
| `src/redactor.js` | 确定性脱敏（API key/Bearer/email/IPv4/长 hex 五类模式，无 LLM） |
| `index.js` | 4 工具：`lesson_nominate`（只提名）/ `lesson_approve`（用户明确批准后物化 .md + **立即重扫入索引**）/ `lesson_reject`（留审计行）/ `lesson_pending` |

治理纪律（移植 Clowder DistillationService）：**AI 无权写真相**——nominate 只进候选库且先脱敏；
物化仅在 approve 后发生，产物是 markdown 文件（文件即真相，索引可重建）；同标题自动消歧文件名。

### @local/dsh-memory-events（M3b：时间记忆）

| 文件 | 内容 |
|---|---|
| `src/event-store.js` | 事件库（独立 truth-side SQLite）：坐标哈希幂等 mark、tombstone 硬遗忘 + re-mark 抑制、since/until 时间窗 + 半衰期排序、dueAt 开环清单、FTS5 trigram 检索 |
| `index.js` | 4 工具：`event_mark` / `event_search` / `event_forget`（**eventKey 或 sourceKey 双路解析**）/ `event_stats` |

移植 Clowder EventMemoryStore（F227）语义：typed 子库而非平行架构；幂等 by source coordinate；
硬遗忘=行删除+墓碑（再 mark 返回 suppressed）；纠错=forget+re-mark 组合（单用户下提案流的等价折叠）。

### core 增量（向后兼容）

- `computeRecencyDecay`（`T/(T+age)`，`KIND_HALF_LIVES`：decision 180/lesson 90/person 365/project 120/note·event 45 天）融入 `search` 排序（`-log(decay)` 对数惩罚，可关）——移植 Clowder recency-decay。

## 真实链路 e2e（glm-5.3-flash headless）

**Lessons 闭环**：agent 收到"提炼教训"指令 → `lesson_nominate`（提名）→ 收到用户明确批准 →
`lesson_approve`（物化 `lesson-fts5-external-content-tables-need-three-sync-tri.md`）→
`memory_search(kinds=[lesson])` **当场检索到**（还按衰减排序发现了 M1 fixtures 里的同主题既有教训）✔

**Events 全生命周期**：双次 mark（第二次 inserted=false 幂等）→ 按用户指令以 **sourceKey** 遗忘 →
同坐标 re-mark suppressed → stats total=0/tombstones=1（硬遗忘真实生效）✔

## 过程中发现并修复的问题（真实 agent 暴露）

1. **工具 output 契约违规**：M3 初版工具的 `output` 只有 `schema` 没有 `render`——真实注册表强制
   `{schema, render}`（M1 core 全带所以没暴露）。补齐后 headless 报错消失。
2. **event_forget 的 agent 引用陷阱**：真实 agent 把 `sourceKey` 想当然当 `eventKey` 传入（stderr 推理
   "eventKey = m3-e2e/run-1 presumably"）——tombstone 落在错误坐标，真事件未删（stats total=1 泄露）。
   修复：events 表增加 `source_key` 列，`forget` 双路解析（64-hex 按主键、否则按 source_key 查行），
   未知坐标返回 `not_found` 且不产生墓碑。修复后 e2e：按 sourceKey 遗忘 → total=0 → re-mark suppressed ✔
   （补单测覆盖"sourceKey 与 eventKey 遗忘同一行"和"未知坐标不建墓碑"）。

## 测试明细

- lessons 5 项：脱敏五类模式、nominate→approve 物化/双批失败、slug 消歧、plugin 级
  nominate→approve→**立即检索**闭环（redaction 全程在场）
- events 7 项：显式/派生坐标幂等、硬遗忘抑制、sourceKey 遗忘等价性、时间窗+半衰期排序、
  开环 due 清单、坐标确定性、plugin 全生命周期
- 回归：core 15/15（含新增衰减排序测试）、decisions 8/8

## 架构落位（与 Clowder 的对应）

| Clowder | 本实现 |
|---|---|
| DistillationService 三态流 + 物化 .md + GlobalIndexBuilder | lessons 候选库 → 物化 → indexRoot 立即入索引 |
| SecretScanner/DeidentificationService | redactor 确定性五模式 |
| EventMemoryStore 坐标幂等 + forget fence（RAISE ABORT） | events 墓碑表 + re-mark suppressed |
| recency-decay T/(T+age) + KIND_HALF_LIVES | core computeRecencyDecay 融入排序 |
| 提案-裁决流 | 单用户折叠：nominate+用户明确批准 / forget+re-mark |

## 已知边界

- 脱敏是模式级（非语义级）——语义脱敏需 LLM 参与，违背"提名确定性"纪律，留边界说明
- 开环（dueAt）目前只有查询面（`dueOpenLoops`），schedule 投递回会话属 M5
- lesson_approve 的"用户明确批准"是对话层契约（prompt hint 声明），无技术强制——单用户可接受，
  多用户场景需接 ask_user 审批 UI

## M4 就绪度

people 插件可直接复用：core 衰减、events 的墓碑模式（person 硬遗忘同构）、lessons 的治理流
（人物记忆提案 = nominate 变体）。向量检索（sqlite-vec + RRF）独立于 people，可并行。
