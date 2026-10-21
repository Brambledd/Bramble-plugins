# 定向遗忘适配 Clowder AI 计划

## 架构对齐分析

Clowder AI 与 Bramble（DSH 版）的证据模型高度同构——这是适配的基础：

| 概念 | Bramble (DSH) | Clowder AI | 兼容性 |
|---|---|---|---|
| 条目标识 | anchor | anchor | ✅ 一致 |
| 条目结构 | kind/status/title/summary/keywords/sourcePath/revision/updatedAt | 相同字段 + packId/authority/activation/provenance | ✅ 超集 |
| 混合检索 | BM25(FTS5) + 向量 + RRF | BM25 + 向量 NN + RRF | ✅ 同构 |
| 行级删除 | store.removeByAnchor | **store.deleteByAnchor 已存在** | ✅ 已有 |
| 工具层 | memory_forget (DSH tool) | **缺失**——7-tool 记忆族全是只读 | ❌ 待建 |
| 图关系 | 无 | GraphResolver（anchor + relations + edges） | ⚠️ 需级联清理 |
| 消费加权排序 | 无 | F200 consumption-weighted ranking | ⚠️ 删除后需摘除消费信号 |

**关键差异**：Clowder 的证据分两个 scope——`docs`（项目知识：feature/ADR/架构文档）和 `threads`（历史消息），遗忘必须同时支持两个 scope 并明确区分。

## 实施计划（四个 Phase）

### Phase 1：API 层 — ForgetService + 路由

**新文件**：
- `packages/api/src/domains/memory/forget/ForgetService.ts`（移植 Bramble forget-service.js）
- `packages/api/src/routes/evidence-forget.ts`

**ForgetService 移植要点**（从 Bramble plugins/core/src/forget-service.js）：

```
executeForget(store: IEvidenceStore, options): Promise<ForgetResult>
├── scope 路由
│   ├── facts: 多探针检索（原短语 + 关键词分解 + 尾 bigram）
│   ├── topic: 全库扫描（按 targets 检索，含 docs+threads 双 scope）
│   └── timerange: updatedAt 确定性日期过滤
├── fresh-write 守卫（10 分钟窗口，仅动态条目）
├── 批量删除（store.deleteByAnchor）
├── 残留验证环（2 轮）
├── F6 replacement（可选写入新值）
└── 图边级联清理（Clowder 特有）
```

**Clowder 特有适配**：

1. **双 scope 处理**：`options.evidenceScope: 'docs' | 'threads' | 'all'`
   - docs 遗忘 → 软删除源文件（frontmatter status:deleted，同 Bramble 方案）
   - threads 遗忘 → 从消息索引移除该 passage（更敏感，需要确认机制）

2. **图边级联**：删除 evidence 前先查 GraphResolver 的相邻边，删除条目后同步删除指向它的边（防止图导航到悬空节点）

3. **消费信号清理**：F200 的 consumption ledger 中被删 anchor 的消费记录同步摘除（防止排序统计引用不存在的条目）

4. **supersededBy 处理**：被删条目如果被其他条目 supersede 引用，需要同步清理引用方的 supersededBy 字段

**API 路由**：
```
POST /api/evidence/forget
Body: {
  scope: "facts" | "topic" | "timerange",
  evidenceScope?: "docs" | "threads" | "all",   // Clowder 特有
  targets?: string[],
  since?: string, until?: string,
  replacement?: string
}
Response: { removed, protected, remaining, replacementWritten, details[] }
```

**权限**：参照 evidence.ts 现有的 authorizationPaths（local-operator / invocation-cat / agent-key-cat），forget 属于**写操作**，风险级别高于 read——需要更严格的授权路径声明。

### Phase 2：MCP 层 — cat_cafe_forget_evidence 工具

**新文件**：`packages/mcp-server/src/tools/forget-tools.ts`

**工具定义**（遵循 defineMcpTool + 完整治理元数据）：

```typescript
defineMcpTool({
  name: 'cat_cafe_forget_evidence',
  description: '...（cross-reference 8-tool family，指引何时用 forget）...',
  operation: {
    kind: 'single',
    action: 'write',           // ← 写操作，区别于现有 7 个 read
    inputSchema: forgetInputSchema,
    boundary: {
      risk: { level: 'write', openWorld: false },  // ← 更高风险级别
      authorizationPaths: [...更严格的授权...],
    },
  },
  policy: {
    resourceFamily: 'evidence-navigation',
    runtimeProfiles: ['full'],   // ← 不进 readonly 档
    verification: [
      { kind: 'test', ref: 'test:packages/api/test/forget-routes.test.js' },
      { kind: 'test', ref: 'test:packages/mcp-server/test/forget-tools.test.js' },
    ],
  },
})
```

**注册**：`canonical-server-tools.ts` 的 `memory` family 数组加 `...forgetTools`

**关键治理约束**：
- `runtimeProfiles` 只含 `full`（readonly/desktop 模式不暴露 forget——防误删）
- 风险注释 `destructiveHint: true`（MCP 规范的破坏性操作标记）
- 授权路径必须覆盖 thread 遗忘场景（用户私有对话数据）

### Phase 3：指导层 — 更新 8-tool 家族文档

1. **memory-routing-partial.md**：三入口决策表加第四行（遗忘场景 → forget_evidence）
2. **7 个现有工具的 description 尾部 cross-reference 段**：加一句"遗忘/删除 → cat_cafe_forget_evidence"
3. **SERVER_INSTRUCTIONS.memory**：加遗忘指导段（何时触发、如何构造参数、确认流程）

### Phase 4：测试 + 治理验证

遵循项目测试规范（CONTRIBUTING.md）：

1. **API 单元测试**：`packages/api/test/forget-routes.test.js`
   - facts/topic/timerange 三路 scope
   - fresh-write 守卫
   - 残留环
   - F6 替换
   - 图边级联
   - 软删除源文件
2. **MCP 工具测试**：`packages/mcp-server/test/forget-tools.test.js`
   - 输入校验（scope/targets 必填）
   - readonly 模式不注册
3. **治理快照**：tool-governance-cli 的 surface snapshot 更新（新工具加入 registry）
4. **跨包回归**：`pnpm check` + `pnpm lint` + 全量 test

## 与 Bramble 版的对照表（能力映射）

| Bramble 能力（Bemula 0.469 验证） | Clowder 适配 | 备注 |
|---|---|---|
| facts 多探针删除 | ✅ 直接移植 | IEvidenceStore.search 支持多探针 |
| topic 全库扫描 | ✅ + evidenceScope 扩展 | docs/threads 分开扫 |
| timerange 日期过滤 | ✅ updatedAt 替代 keywords | Clowder updatedAt 可靠 |
| fresh-write 守卫 | ✅ 直接移植 | 同样仅动态条目 |
| 残留验证环 | ✅ 直接移植 | 2 轮上限 |
| F6 替换 | ✅ upsert 新条目 | store.upsert 已有 |
| 软删除源文件 | ✅ frontmatter status:deleted | 同 Bramble 方案 |
| 防复活（suppressed） | ⚠️ 改用 status 字段 | deleted 状态的条目 upsert 时跳过 |
| **图边级联清理** | 🆕 Clowder 特有 | Bramble 无图 |
| **消费信号清理** | 🆕 Clowder 特有 | F200 ledger |
| **多用户授权** | 🆕 Clowder 特有 | authorizationPaths |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| docs 遗忘误删项目知识（ADR/feature 文档） | forget 默认 evidenceScope=threads（对话记忆）；docs 遗忘需要显式声明 + 二次确认参数 |
| thread 遗忘侵犯其他参与者记忆 | authorizationPaths 限定 owner-private；agent-key 只能删自己 thread |
| 破坏 F200 排序统计 | 删除时同步清理 consumption ledger |
| 图悬空边 | 级联删除相邻边 |

## 工作量估算

| Phase | 内容 | 规模 |
|---|---|---|
| 1 | ForgetService + 路由 + 图级联 | ~400 行 |
| 2 | MCP 工具 + 治理元数据 | ~200 行 |
| 3 | 文档 + 描述更新 | ~100 行 |
| 4 | 测试 | ~300 行 |
| 合计 | | ~1000 行（含测试） |
