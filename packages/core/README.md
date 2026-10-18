# dsh-memory-core — DSH 记忆插件 M1（证据库核心）

Clowder AI 记忆系统在 DSH 上的插件化复刻，第一阶段：证据元模型 + 派生索引 + 回源校验。

## 核心契约（来自 M1 计划）

1. **真相在文件**：`*.md` 源文件是唯一真相；SQLite 索引是派生的、可随时重建的导航。
2. **回源校验（fail-closed）**：`memory_drill` 每次重新读取并重新哈希源文件；与索引 revision
   不符时返回 `not_available + invalidationReason`，绝不返回过期内容。
3. **锚点=身份，revision=版本**：内容变化不改变锚点；supersede 链与 cue 消费账本都按
   revision 精确作用域。
4. **派生索引可丢弃**：`application_id` 守卫 + `user_version` 版本；不兼容即原地重置，
   `rebuildAll()` 从已登记的源根目录全量恢复。

## 工具面

| 工具 | 作用 |
|---|---|
| `memory_search` | BM25 全文检索（trigram 分词，中文 ≥3 字直接命中，短词 LIKE 兜底）；返回锚点 + revision |
| `memory_drill` | 回源校验读取；`expectedRevision` 不符 → `stale_revision`；源文件改动 → `source_modified`；源文件删除 → `source_missing`；superseded → `inactive` |
| `memory_stats` | 索引健康快照（按 kind/status 计数、cue 账本、schema 版本、已登记根目录） |

## 配置（cordis.patch.yml 示例）

```yaml
- id: dsh-memory-core
  name: "@local/dsh-memory-core"
  config:
    dbPath: E:/ClowderAI/dsh-memory/dev/evidence.sqlite
    roots:
      - E:/ClowderAI/dsh-memory/dev/knowledge
    maxResults: 8
    reindexOnStart: true
    promptHint: true
```

## 运维脚本

```bash
node scripts/reindex.mjs --db dev/evidence.sqlite --root dev/knowledge   # 增量扫描
node scripts/reindex.mjs --db dev/evidence.sqlite --rebuild              # 全量重建
node scripts/reindex.mjs --db dev/evidence.sqlite --search "fts5 触发器"  # 检索
node scripts/reindex.mjs --db dev/evidence.sqlite --stats                # 健康快照
```

## 测试

```bash
node --test test/store.test.mjs test/plugin.test.mjs
```

覆盖：schema 初始化/外库拒绝/版本重置、扫描确定性（kind/anchor/status）、检索
（BM25/kind 过滤/中文 trigram/LIKE 兜底/superseded 沉底）、drill 全部失效模式、
cue 账本幂等与 revision 作用域、rebuild 平价 + 账本保留、无 churn 幂等重扫。

## 文档约定（源文件 frontmatter）

```markdown
---
title: 决策标题
status: accepted        # decision 无 status 视为 captured（fail-closed）
kind: decision          # decision | lesson | note | event | person | project
summary: 一句话摘要
keywords: 逗号分隔
---
```

锚点推导优先级：frontmatter `anchor` > 文件名 `ADR-###` > 相对路径 slug。

## 后续（M2+）

- `dsh-memory-decisions`：accepted 决策 cue 一次性浮现（消费账本已就位）
- `dsh-memory-lessons` / `dsh-memory-events`：提名-审核-物化、幂等事件、半衰期
- `dsh-memory-people`：实体/别名/提及 + 墓碑硬遗忘
- Phase 4：sqlite-vec 向量 + RRF 融合
