# Bramble-plugins 端到端测试用例（重启后照跑）

> 使用方法：重启 DSH 进程后，新开会话，把每条用例的【发送】原话发给 agent，
> 对照【预期】核对结果。用例按依赖顺序排列，建议从头依次执行。
> 安装前基线：本进程 bundles 无 memory 插件，agent 工具面无任何 memory_*/lesson_*/event_*
> 工具（已采集存档）。所有用例在安装前都会得到"没有这个工具"的回答。

---

## T1 插件加载与健康检查（core）

**发送**：
> 调用 memory_stats，报告 schemaVersion、total、vectors 里的 fresh/stale 数量、vectorBackend。

**预期**：
- `schemaVersion: 2`，`total: 7`（5 条 fixtures + 1 条 M3 物化教训 + 1 条中文索引教训）
- `vectors: fresh: 7, stale: 0`，`vectorBackend: hash-256`
- 若 vectors 不是 7/7：等待几秒让启动回填完成后再问一次

## T2 跨词汇中文语义检索（core 向量路）

**发送**：
> 用 memory_search 搜中文"怎么避免索引和文件对不上"，报告 matchMode 和最佳命中的锚点与标题。

**预期**：
- `matchMode: hybrid:fts+vec`（BM25+向量双路融合，中文查询向量加权 1.5）
- 最佳命中 `lessons-lesson-external-content-no-auto-sync`（"外部内容索引表不会自动同步"）
- 次命中包含英文 FTS5 触发器教训——查询与文档零共同关键词也能召回

## T3 回源校验 drill（core fail-closed）

**发送**：
> 用 memory_search 找到 ADR-001 并拿到它的 revision，然后用这个 revision 调 memory_drill 读取 ADR-001。报告 drill 状态和内容第一行标题。

**预期**：
- `status: ok`，内容以 `# ADR-001: Choose node:sqlite as the evidence store driver` 开头
- revision 前缀（≥8 位十六进制）也应被接受

**（可选进阶）失效路径**：先让 agent 或你在终端给
`E:\ClowderAI\dsh-memory\dev\knowledge\decisions\ADR-001-choose-node-sqlite.md`
追加一行再让它 drill → 应返回 `not_available + source_modified`（不返回旧内容）；
把文件改回去后恢复 ok。

## T4 决策 cue 一次性浮现（decisions）

**发送**（第一条消息，新会话更干净）：
> 我们要给新的记忆索引选数据库驱动，之前有相关结论吗？

**预期**：
- 第一问：agent 引用已有的 ADR 决策内容（cue 注入引导 + agent 主动 search/drill）
- **紧接着第二问**（原话再发一遍）：agent 不再收到已消费 revision 的 cue——
  可让它明确回答"本轮是否注入了新 decision cue"，应答"没有"
- 预算保护：每轮最多 1 条、每日最多 10 条 cue，不会刷屏

## T5 教训提名-批准-物化闭环（lessons）

**发送**：
> 从我们这次协作里提炼一条教训："验收测试必须覆盖真实 agent 调用路径，stub 测试会漏掉 output 契约类缺陷"。
> 先用 lesson_nominate 提名（context 写：E2E 复测），然后我明确批准它，请调用 lesson_approve，
> 最后用 memory_search (kinds=[lesson]) 验证它能被检索到。报告 candidateId、filePath、anchor。

**预期**：
- 提名返回 candidateId（`les-` 前缀）+ 状态 pending
- 批准后物化文件落在
  `E:\ClowderAI\dsh-memory\dev\knowledge\lessons\lesson-*.md`
- **同一会话内** memory_search 立即能搜到（无需重启）
- 治理验证：让 agent 未经你批准直接 lesson_approve 一个新提名 → 它应引用规则拒绝或先征求你的批准

## T6 事件幂等 + 硬遗忘（events）

**发送**：
> 执行时间记忆练习：
> 1. event_mark title="E2E 复测事件" kind=milestone occurredAt=2026-10-18T20:00:00Z sourceKey="e2e-retest/run-1"，同样参数调两次，报告两次的 inserted；
> 2. 我要求遗忘它——用 sourceKey "e2e-retest/run-1" 调 event_forget；
> 3. 同坐标再 event_mark，报告是否 suppressed；
> 4. event_stats 报告 total 和 tombstones。每步一行。

**预期**：
- 第 1 步：第一次 `inserted: true`，第二次 `inserted: false`（坐标幂等）
- 第 2 步：遗忘成功（按 sourceKey 也能定位，不需要背 64 位 hash）
- 第 3 步：`suppressed: true`（墓碑硬遗忘，永不复活）
- 第 4 步：`total: 0`（该事件真被删了）、`tombstones: ≥1`

## T7 跨会话持久性（重启即验证）

重启进程这个动作本身就是本用例：所有记忆（证据库、教训、事件、cue 消费账本）
都在磁盘上。重启后重复 T1/T4 第二问/T6 第 3 步：
- T1 数字一致（库还在）
- T4 不重新 cue 已消费的决策（账本还在）
- T6 第 3 步依然 suppressed（墓碑还在）

---

## 一键回滚（如需卸载）

```powershell
# 恢复备份的 profile 文件，删除四个 junction，重启进程
Copy-Item C:\Users\19356\.dsh\profiles\web\package.json.bak-memory-* C:\Users\19356\.dsh\profiles\web\package.json -Force
Copy-Item C:\Users\19356\.dsh\profiles\web\cordis.patch.yml.bak-memory-* C:\Users\19356\.dsh\profiles\web\cordis.patch.yml -Force
Remove-Item C:\Users\19356\.dsh\profiles\web\node_modules\@local\dsh-memory* -Recurse -Force
```
