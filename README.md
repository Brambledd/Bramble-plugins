# Bramble-plugins

DSH（DeepSeek Harness）记忆系统插件集——把 Clowder AI 的记忆架构以 Cordis 插件形式移植到 DSH。
零原生依赖（node:sqlite + FTS5 trigram），每个插件独立可装，共享一个证据索引。

> 架构蓝本分析与实施计划见 [plans/dsh-memory-plugins-plan.md](plans/dsh-memory-plugins-plan.md)。

## 插件

| 包 | 里程碑 | 能力 |
|---|---|---|
| [`@local/dsh-memory-core`](packages/core) | M1 | 证据库：FTS5 检索、revision 回源校验（fail-closed）、可重建派生索引、cue 消费账本、半衰期排序 |
| [`@local/dsh-memory-decisions`](packages/decisions) | M2 | 决策 cue：accepted 决策在判断点一次性浮现（agent/pre-step 注入）、supersede 失效、预算控制 |
| [`@local/dsh-memory-lessons`](packages/lessons) | M3 | 教训沉淀：提名（AI 无写真相权）→ 用户批准 → 物化 .md → 立即入索引，含确定性脱敏 |
| [`@local/dsh-memory-events`](packages/events) | M3 | 时间记忆：坐标幂等事件、墓碑硬遗忘、时间窗 + 半衰期检索、开环清单 |

## 核心契约（贯穿全部插件）

1. **真相在文件**：markdown 源文件是唯一真相；SQLite 索引是派生的、可随时重建的导航。
2. **回源校验 fail-closed**：派生读永远重新哈希源文件；不符即 `not_available + invalidationReason`。
3. **锚点=身份，revision=版本**：内容变化不换锚点；消费账本按 revision 精确作用域。
4. **AI 无直写真相权**：写入侧一律提名-批准流；遗忘权在用户。
5. **每条提示只出现一次**：cue 注入即记账，同 revision 永不重复。

## 快速开始

```bash
# 每个包都是标准 Cordis 插件（file: 链接或拷入 profile node_modules）
# profile package.json:
{
  "dependencies": {
    "@local/dsh-memory-core": "file:./packages/core",
    "@local/dsh-memory-decisions": "file:./packages/decisions"
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@local/dsh-memory-core",
    "@local/dsh-memory-decisions"
  ] } }
}
```

配置与工具说明见各包 README。测试：`node --test test/`（各包内）。

## 状态

M1-M3 已实现并经真实 DSH headless 链路验收（见各包 `M*-ACCEPTANCE.md`）。
M4（人物关系 + 向量检索）与 M5（打磨发布）见计划文档。

## 许可

MIT
