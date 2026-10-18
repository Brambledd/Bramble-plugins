# DSH 记忆系统插件化实现计划

目标：在 DSH（Cordis 插件 + profile patch 体系）上，以独立插件包形式复刻 Clowder AI 的五类记忆能力：
证据库、决策日志、教训沉淀、人物关系、时间记忆。

## 0. 总体架构

```
$DSH_HOME/profiles/memory/
├─ package.json            # 树外插件依赖（本地 file: 链接开发中插件）
├─ dsh.profile             # bundles: [base 插件集, @local/dsh-memory-*]
└─ cordis.patch.yml        # 用户覆盖层：开关、预算、路径

插件包（pnpm workspace，独立版本）:
@local/dsh-memory-core      证据元模型 + storage backend + 检索管线（所有功能的地基）
@local/dsh-memory-decisions 决策日志（ADR 文件 + cue 注入）
@local/dsh-memory-lessons   教训沉淀（提名-审核-物化流水线）
@local/dsh-memory-people    人物/实体（别名、提及、墓碑遗忘）
@local/dsh-memory-events    时间记忆（事件表 + 衰减 + 回访）
```

依赖方向：decisions/lessons/people/events → core →（peer）dsh-base / dsh-storage / dsh-skill / dsh-user-questions / dsh-schedule。

## 1. Phase 1 — memory-core（证据元模型，一切的地基）

**目标**：建立"真相在文件，SQLite 是可重建投影"的证据层。

1. **Storage backend**：仿照 `dsh-storage-json` 注册 `ctx.storage.mount('evidence', ...)`，引擎换 better-sqlite3：
   - `evidence_docs(anchor PK, kind, status, authority, title, summary, keywords, source_path, source_hash, superseded_by, updated_at)`
   - FTS5 外部内容表 + ai/ad/au 触发器（照抄 Clowder `schema.ts` 模式）
   - `evidence_vectors`（sqlite-vec vec0，Phase 4 再启用）
   - `schema_version` 表，迁移只追加不复用版本号
2. **回源校验**：所有读取带 `expectedRevision`（source_hash）校验，hash 不符返回 `not_available + invalidationReason`。
3. **检索工具**：注册 `memory_search` 工具（`dsh-tool-*` 模式）：FTS5 BM25 起步；CJK 查询留 RRF 加权接口（Phase 4 接向量）。
4. **注入面**：用 patch 层向 `dsh-system-prompt`/`dsh-agent-instructions` 注入一行 cue（"存在记忆库，判断点可用 memory_search"），不做自动 dump。
5. **失效传播**：`evidence-write-queue` 串行写入；删除/更正时同步清 FTS 触发器自动处理，向量失效留接口。

验收：写一批 markdown → 搜索命中 → 改源文件后旧 revision 检索返回失效原因。

## 2. Phase 2 — memory-decisions（决策日志）

**目标**：accepted 决策在判断点浮现一次，过期即失效。

1. 扫描 workspace `decisions/*.md`，解析 frontmatter `status:`，accepted 者索引为 `kind='decision'`、anchor=`ADR-###`。
2. **消费账本**：`cue_episodes(owner, family='decision', source_anchor, revision, terminal)` 表——同 revision 只提示一次。
3. **cue 注入**：`dsh-schedule` 在会话开启/判断点触发轻量检查；命中未消费决策时经 patch 向上下文注入一行（标题+摘要+anchor），agent 可 drill（`memory_drill` 工具回源读全文，校验 revision）。
4. 替代/退休：supersede 写 `superseded_by`，后续 cue 自动指向新版。

验收：两条 ADR，只提示一次；改 status 后旧版不再出现。

## 3. Phase 3 — memory-lessons（教训沉淀）+ memory-events（时间记忆）

**lessons**：
1. `lesson_nominate` 工具（AI 调用）：会话中总结出可复用教训时提名 → 候选表 `pending`，附 source 坐标。
2. 审核用 `dsh-user-questions`（ask_user 审批 UI）：批准/拒绝/暂缓。
3. 批准后**物化为文件**写入 `~/.dsh/lessons/*.md`（脱敏由提名时模板约束 + 简单 redactor），core 扫描器将其编译进全局索引——纪律同 Clowder：文件是真相。
4. 挂载：物化目录注册为 skill/知识源（`dsh-skill`），所有会话可见。

**events**：
1. `event_mark` 工具：来源坐标哈希幂等（重复 mark 返回 inserted=false）。
2. 表结构带 since/until 可查；纠错走提案-裁决（user-questions），hard_forget 写墓碑行，后续 mark 返回 suppressed。
3. **衰减排序**：检索得分乘 `T/(T+age)`，kind→半衰期表（decision 180 天 / lesson 90 / event 45，默认 45）。
4. **收尾巡逻**：`dsh-schedule` durable reminder 在会话关闭后触发 reflection job（`dsh-jobs-local`），产出 ≤N 条候选（预算控制），经 ask_user 逐条裁决。
5. 承诺类事件（open loop）到期由 schedule 投递回原会话。

## 4. Phase 4 — memory-people（人物/实体）+ 向量检索

**people（单用户简化版）**：
1. `entity_registry` + `entity_aliases`（NFKC + locale 小写归一）+ `entity_mentions`（surface→anchor/passage）三表，确定性抽取：wikilink/markdown 链接正则，不用 LLM。
2. `person_propose` 工具产候选 → ask_user 裁决 → settled；每条裁决有 undo 键。
3. **硬遗忘**：`memory_forget_person` → 删 mentions/aliases/registry + 写 `forget_tombstones` + `BEFORE INSERT RAISE(ABORT)` 触发器（SQLite 单库内即可实现 Clowder 的墓碑语义，无需 Redis/Lua）。
4. 无需 owner 键空间隔离（DSH 单用户），保留 future multi-owner 列位。

**向量**：
1. 引入 sqlite-vec；embedding 后端做成接口（默认调 LLM API 的 embedding endpoint）。
2. RRF 融合 BM25 + NN；CJK 查询 NN 权重 ×1.5；MMR 去重。
3. 向量失效：source_hash 变化 → `vector-invalidation` 标记 → 后台 repack job（dsh-jobs-local）。

## 5. 治理与横切（贯穿各 Phase）

- **权限**：写入仅限插件内部队列；agent 只有 nominate/search/drill 三个工具，无直写。
- **预算**：每日候选/提示上限写进 `cordis.patch.yml` 用户层。
- **可重建性**：提供 `memory_rebuild` 命令——删库后从源文件全量重建索引，作为终极自愈。
- **观测**：presented/drilled/applied/dismissed 计数接 `dsh-session-telemetry`/OTel。
- **守卫**（学习 Clowder 的 check:* 风格）：schema 版本唯一性、墓碑不可插入、cue 一次消费的回归测试。

## 6. 里程碑

| 里程碑 | 内容 | 预估量级 |
|---|---|---|
| M1 | memory-core：存储 backend + FTS5 检索工具 + revision 回源 | ~1-2 周 |
| M2 | memory-decisions：ADR 扫描 + 一次消费 cue + drill | ~1 周 |
| M3 | memory-lessons + memory-events：提名审核流、幂等事件、衰减、收尾巡逻 | ~2 周 |
| M4 | memory-people：实体/别名/提及 + 墓碑硬遗忘；向量检索 RRF | ~2-3 周 |
| M5 | 打磨：预算、遥测、rebuild 命令、发布 profile 模板 `dsh --profile memory` | ~1 周 |

## 7. 风险与对策

- **sqlite-vec 原生依赖**：Windows 构建风险 → 先 BM25-only 发布，向量作为可选 peer 依赖。
- **cue 骚扰**：严格一次消费 + 每日预算 + 只在判断点注入。
- **索引/真相漂移**：强制 source_hash 回源校验，任何派生读失败即降级为 not_available，fail-closed。
- **profile 兼容**：插件声明 DSH peer 版本范围，走 plugin-manager 的 version-exemptions 流程豁免需用户显式确认。
