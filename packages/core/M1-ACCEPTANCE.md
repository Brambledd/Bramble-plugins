# M1 验收报告 — @local/dsh-memory-core

日期：2026-10-18 · 状态：**已验收** · 测试 14/14 绿 · 真实 DSH 链路验证通过

## 交付物

| 路径 | 内容 |
|---|---|
| `index.js` | Cordis 插件入口（name/inject/Config/apply），注册 3 工具 + 提示注入 + 生命周期清理 |
| `src/schema.js` | SQLite schema 生命周期：application_id 守卫 + user_version + 不兼容原地重置（DSH 官方派生索引惯例） |
| `src/store.js` | EvidenceStore：upsert / search / drill（回源校验）/ supersede / cue 账本 / stats / wipe |
| `src/scanner.js` | 真相侧扫描器：确定性 kind/anchor/status 推导（无 LLM）、幂等重扫、全量重建 |
| `src/util.js` | revision 哈希、frontmatter 解析、FTS 查询构造、枚举 |
| `test/*.test.mjs` | 14 项验收测试（store 10 + plugin 4） |
| `scripts/reindex.mjs` | 运维脚本：scan / rebuild / search / stats |
| `cordis.patch.yml` | bundle 层（insert 插件条目，`dsh.bundle.patch` 声明于 package.json） |

## 核心契约与实现对照

| 计划契约 | 实现 | 验证 |
|---|---|---|
| 真相在文件，SQLite 是可重建投影 | 扫描器索引 `*.md`；`rebuildAll()` 从登记根目录全量恢复；cue 账本（行为真相）在 rebuild 中保留 | `rebuild: wipe + rescan restores parity, ledger preserved` ✔ |
| 回源校验 fail-closed | drill 每次重读 + 重哈希源文件；六种失效模式：not_found / no_source / source_missing / source_modified / stale_revision / inactive | 单测 ✔ + 真实 agent 会话内改源文件 → drill 立即 `source_modified` ✔ |
| 锚点=身份，revision=版本 | anchor 由 frontmatter > ADR-### > 路径 slug 推导（不含内容哈希）；revision=sha256；内容变化不换锚点 | `indexRoot scans fixtures with deterministic kinds, anchors and statuses` ✔ |
| FTS5 检索（CJK 可用） | trigram 分词器（中文 ≥3 字直接命中）+ 渐进 MATCH（AND→OR→前缀）+ LIKE 兜底（1–2 字中文）；superseded/retired 沉底不隐藏 | `search: BM25 hits, kind filter, CJK trigram and LIKE fallback, demotion` ✔ |
| decision 无 status 视为未接受 | `inferStatus` 对 decision 默认 `captured`（fail-closed） | ADR-003 草稿被索引为 captured ✔ |
| 派生库防误用 | 外库（application_id 不符）拒绝；不兼容版本原地重置；版本号永不复用（V1 起步） | `foreign database is rejected` / `stale schema version resets` ✔ |
| cue 一次消费（M2 地基） | `cue_episodes` UNIQUE(owner, family, anchor, revision)；幂等记录；按 revision 作用域 | `cue ledger: one terminal consumption per revision, revision-scoped` ✔ |
| 无 churn 幂等重扫 | 内容未变 upsert 保留 updated_at | `idempotent reindex keeps updated_at stable` ✔ |

## 真实 DSH 链路验证（四级递进）

1. **配置组合**：`dsh --profile memory-dev --dump-config` — 插件条目 + patch 配置（dbPath/roots）正确进入组合树 ✔
2. **模块加载**：`--dump-config-schema` — 插件被真实 loader 加载，schemastery Config 被内省 ✔
3. **启动副作用**：headless profile（base+headless+memory-core）启动 → `apply()` 执行 → evidence.sqlite 自动创建 + 5 文档入索引（3 decision/1 lesson/1 note；2 accepted/1 captured/2 active）✔
4. **真实 agent 端到端**（glm-5.3-flash 驱动的 headless 会话）：
   - `memory_stats` → 正确报告索引全貌 ✔
   - `memory_search "fts5 triggers"` → 命中 FTS5 触发器教训 ✔
   - `memory_search "node sqlite driver"` + `memory_drill ADR-001`（带 revision）→ ok，内容验证 ✔
   - 会话内改源文件 → `memory_drill` → **`source_modified` fail-closed** ✔

## 过程中发现并修复的问题

1. **anchor 内容哈希后缀缺陷**：初版给非 ADR 锚点加 hash8 后缀——内容变化会产生新锚点，破坏 supersede 链与 cue 消费语义。改为纯 slug（锚点=身份）。
2. **真实 agent 暴露的 revision 截断陷阱**：render 显示 8 位短哈希诱导 agent 传截断值 → 误报 stale_revision。修复：drill 接受 ≥8 位十六进制前缀（git 惯例，大小写不敏感；歧义仍 fail-closed）+ render 显示完整哈希 + 参数描述明确。修复后真实 agent 一次成功。
3. **FTS5 unicode61 对中文无效**：改用 trigram 分词器（node:sqlite 3.53.1 实测），2 字词由 LIKE 兜底相位承接。

## 配置示例（已在 memory-dev / memory-dev-h 两个 profile 验证）

```yaml
- id: dsh-memory-core
  name: "@local/dsh-memory-core"
  config:
    dbPath: E:/ClowderAI/dsh-memory/dev/evidence.sqlite
    roots: [E:/ClowderAI/dsh-memory/dev/knowledge]
    maxResults: 8
    reindexOnStart: true
    promptHint: true
```

## 已知边界（按计划留待后续）

- 向量检索（sqlite-vec + RRF）→ Phase 4
- cue 浮现/注入（消费账本已就位，浮现逻辑属 M2 decisions）
- 多进程并发写：WAL + busy_timeout=5000 覆盖单写者场景；M2+ 若需跨插件共写再加写队列
- Windows 下 headless e2e 的 stderr reasoning 噪音是 dsh 行为，与本插件无关

## M2 就绪度

`cue_episodes` 账本、`INACTIVE_STATUSES`、`supersede`、`getByAnchor`、`drill` 的 revision 契约均已就位，
`dsh-memory-decisions` 可直接以独立插件复用同一 dbPath（SQLite WAL 多连接安全）。
