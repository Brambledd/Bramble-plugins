# Bramble Memory — 定向遗忘产品化计划

## 现状差距

Bemula 跑分 0.469 的全部删除智能都在 **benchmark Python 适配器**里，npm 插件（0.1.3）只有：

| 能力 | benchmark 适配器 | npm 插件现状 |
|---|---|---|
| 自然语言遗忘意图识别 | LLM plan（scope/targets/replacement） | ❌ 无 |
| 主题范围删除（F3） | 事实清单枚举 → 逐条检索 → 批量删除 | ❌ 无 |
| 时间范围删除（F5） | keywords 日期 token 确定性过滤 | ❌ 无 |
| 替换旧值（F6） | 删旧 + 写新一步完成 | ❌ 无 |
| 残留验证环 | 删后再搜 → 漏网再删 | ❌ 无 |
| fresh-write 守卫 | 保护最近写入不被误删 | ❌ 无 |
| 事实级删除（vs 文件级） | 按 anchor 精确删除条目 | ❌ 无（只能删整文件） |
| 防复活守卫 | suppressed 清单 | ❌ 无 |
| **事件墓碑硬遗忘** | — | ✅ 已有（event_forget） |
| **孤儿清理** | — | ✅ 已有（删文件→重扫） |

## 架构决策

### 核心原则：agent 是大脑，工具是手

DSH 的 agent 本身就是 LLM。**不需要在插件内部再调一个 LLM 做意图解析**——让 agent 自己解析用户的自然语言遗忘请求，然后调用结构化的删除工具。

```
用户："忘掉我的家庭住址"
  ↓
Agent（LLM）自己理解意图，生成结构化参数
  ↓
调用 memory_forget(scope="facts", targets=["home address", "家庭住址"])
  ↓
工具内部：检索 → fresh guard → 删除 → 残留验证 → 返回摘要
```

### 新增三个工具到 core 插件

#### 1. `memory_forget` — 结构化遗忘（主要入口）

```javascript
参数：{
  scope: "facts" | "topic" | "timerange",
  targets: ["搜索短语1", "搜索短语2"],     // facts/topic 用
  since: "2026-01-01",                   // timerange 用（可选）
  until: "2026-02-01",                   // timerange 用（可选）
  replacement: "新值文本"                  // F6 替换用（可选）
}

内部流程：
1. 按 scope 分路径定位候选条目
   - facts: 多探针检索（原短语 + 关键词分解）
   - topic: 全库扫描 + 关键词匹配
   - timerange: keywords 日期 token 确定性过滤
2. fresh-write 守卫（排除最近 10 分钟写入的条目）
3. 批量删除（removeByAnchor）
4. 残留验证（用 targets 再搜一轮，漏网再删，上限 2 轮）
5. 若有 replacement → observe 写入新值
6. 返回：{ removed: N, remaining: M, replacement_written: bool }

system prompt 指导 agent 如何解析用户的遗忘请求为这些参数。
```

#### 2. `memory_remove` — 按 anchor 精确删除（底层原语）

```javascript
参数：{ anchors: ["ADR-001", "turn-s1-0003"] }
→ 直接删除指定条目（带 fresh guard + 防复活守卫）
```

#### 3. `memory_consolidate` — 推断固化（可选，Phase 2）

```javascript
参数：{}
→ 扫描全部 note 条目，用 LLM 提取主题命名的高层推断
→ 写入 kind=inference 条目（带 basis 锚点）
```

## 实施计划

### Phase 1：memory_forget + memory_remove（核心能力）

**改动文件**：`packages/core/index.js` + `packages/core/src/forget-service.js`（新）

1. 新建 `forget-service.js`（纯逻辑，可测试）：
   - `executeForget(store, options)` — 完整遗忘流程
   - 多探针检索（原短语 + 关键词分解 + 尾 bigram）
   - fresh-write 守卫（`_fresh_anchors` 逻辑）
   - 残留验证环（上限 2 轮）
   - F6 替换写入
   - timerange 确定性过滤（keywords 日期 token）

2. 在 `index.js` 注册 `memory_forget` 工具：
   - 接收结构化参数
   - 调用 forget-service
   - 更新 system prompt（教 agent 如何从自然语言映射到参数）

3. 在 `index.js` 注册 `memory_remove` 工具：
   - 接收 anchor 数组
   - 调用 store.removeByAnchor + 防复活守卫

**测试**：
- `test/forget-service.test.mjs` — 单元测试（无 LLM 依赖）
  - facts 路径：多探针检索 → 删除 → 验证
  - topic 路径：全库扫描 → 删除
  - timerange 路径：日期过滤 → 删除
  - fresh guard：最近写入不被删
  - 残留环：漏网条目被第二轮捕获
  - F6 替换：旧值删 + 新值写
  - 防复活：inference 条目删除后记入 suppressed
- E2E：headless 起动 → agent 调用 memory_forget → 验证

### Phase 2：system prompt 遗忘指导 + memory_consolidate

**改动文件**：`packages/core/index.js`（prompt 扩展）

1. system prompt 增加遗忘指导段：
   ```
   When the user asks to forget/delete/remove information:
   - Single fact: memory_forget(scope="facts", targets=["描述"])
   - Whole topic: memory_forget(scope="topic", targets=["主题关键词"])
   - Time range: memory_forget(scope="timerange", since="...", until="...")
   - Replace value: memory_forget(scope="facts", targets=["旧值"], replacement="新值")
   ```

2. `memory_consolidate` 工具（可选）：
   - 需要 LLM 访问 → 通过 inject "llm" 获取
   - 或者：agent 自己做 consolidation（在 system prompt 中指导）
   - 推荐：**agent 自己做**（DSH 哲学：agent 是大脑）——agent 用 memory_search 读全部条目，自己综合推断，然后用 lesson_nominate 或直接 observe 写入

### Phase 3：npm 发版 + E2E 验证

1. 版本 bump 到 0.2.0（新功能）
2. 全量测试回归
3. npm publish
4. headless E2E：真实对话中测试遗忘流程
5. Bemula 重跑（benchmark adapter 改为调产品工具而非自有逻辑）

## 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| agent 误解遗忘请求 → 参数错误 | 误删或漏删 | memory_forget 返回候选摘要，agent 可复查 |
| 无 LLM 的 fresh guard 时间窗 | 10 分钟窗口可能太短/长 | 可配置 |
| 残留环过度删除 | PR 下降 | 保留 fresh guard + 可配置轮数 |
| 向后兼容 | 0.1.x 用户升级 | 新工具是增量添加，不影响现有工具 |

## 预期效果

用户在 DSH 对话中说"忘掉我的家庭住址"→ agent 自动调用 memory_forget → 存储级删除 → 后续任何查询/攻击都无法提取 → 同主题新值可正常写入 → Bemula 产品版验收。
