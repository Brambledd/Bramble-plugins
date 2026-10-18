# M4 验收报告 — 向量检索（混合检索管线）

日期：2026-10-18 · 状态：**已验收** · 全仓 **42/42 测试绿**（core 15 + vector 8 + decisions 8 + lessons 5 + events 6）· 真实 headless e2e 通过（含 schema v1→v2 在线升级）

> 按用户决策，M4 只做向量检索；人物关系模块取消。

## 交付物（全部在 core 包内）

| 文件 | 内容 |
|---|---|
| `src/embedding.js` | EmbeddingService：`HashEmbedding`（默认，确定性 n-gram 随机投影，零依赖零网络）+ `OpenAICompatibleEmbedding`（任意 OpenAI 兼容端点，apiKeyEnv 凭据）+ cosine |
| `src/vector-store.js` | BLOB 向量存储（Float32 序列化），freshness 以文档当前 revision 为准（JOIN 口径统一），KNN 全扫余弦 |
| `src/store.js` | 混合检索管线：`runHybrid`（RRF k=60 融合 → 衰减 → demote → MMR λ=0.7）；`searchHybrid`（异步后端路径）；`embedBackfill`（预算回填） |
| `src/schema.js` | schema v2：`evidence_vectors(anchor, revision, model, dims, vec, updated_at)`；v1 库启动自动原地重置升级（已实测） |
| `index.js` | vector 配置（backend/baseUrl/apiKeyEnv/model/dimensions/backfillBatch）+ 启动回填 + `memory_search` 走 `searchHybrid` + render 显示 matchMode |

## 关键设计决策

1. **零原生依赖的向量路**：BLOB + JS 余弦而非 sqlite-vec——个人知识库规模（10k×256 维 ≈ 10MB 扫描）无性能压力，免去 Windows 原生构建风险；sqlite-vec 留作将来可选加速（node:sqlite 的 `allowExtension`/`loadExtension` 已验证可用）。
2. **双后端**：hash 默认开箱即用（同步、离线、确定性——同文本永远同向量，测试可复现）；openai-compatible 走配置（异步，`searchHybrid` 路径），凭据只从环境变量读取、绝不落盘。
3. **vec-only 命中必须存活融合**：向量路的存在意义就是 FTS 搜不到的文档；融合前先把向量命中解析为完整 item。
4. **失效与文档 revision 联动**：向量行的 freshness 永远以 `evidence_docs.source_hash` 当前值为准（发现并修复了 freshFor 与调用方期望值比较的缺陷）；rebuild 清空向量（派生纪律）；model 身份隔离（backend-a 的向量不被 backend-b 使用）。

## Clowder 契约对照

| Clowder（SqliteEvidenceStore） | 本实现 |
|---|---|
| BM25 + sqlite-vec 双路 RRF | BM25(trigram) + BLOB 向量 RRF（k=60） |
| CJK_NN_WEIGHT = 1.5 | `cjkBoost`：中文查询向量路权重 ×1.5（单测验证精确 1.5 倍） |
| MMR 多样性 | `mmrRerank` λ=0.7（近重复文档不再挤占前排，单测覆盖） |
| vector-invalidation（revision 变更失效） | freshFor JOIN 当前 revision；stale 向量对检索不可见；backfill 重算恢复 |
| EmbeddingService 抽象 | 双后端接口 + 注入点（测试用确定性 async fake） |

## 真实链路 e2e（glm-5.3-flash headless）

1. **在线升级**：dev 库从 schema v1 启动 → 自动重置 → 重扫 7 文档 → 向量回填 7/7 fresh，`schemaVersion: 2, vectorBackend: hash-256` ✔
2. **跨词汇中文检索**：新教训文档刻意避开"FTS5"用词（"外部内容索引表不会自动同步…必须手写三个同步触发器"），查询 **"怎么避免索引和文件对不上"** → `matchMode: hybrid:fts+vec`，最佳命中该中文教训，同主题英文 FTS5 教训同现，agent 正确总结"必须手写三个同步触发器" ✔

## 过程中发现并修复的问题

1. **衰减符号反转（真 bug，回归测试抓出）**：M3 的衰减惩罚按"bm25 越小越好"写为 `score -= log(decay)`；M4 换到 RRF"越大越好"分数后未翻转符号，导致**旧内容反而加分**。诊断脚本实锤（stale 得分 +1.71），修复为 `score += log(decay)`。
2. **freshFor 失效口径错误（向量测试抓出）**：与调用方传入的期望 revision 比较而非文档当前 revision——传入旧值时 stale 向量被当作 fresh。修正为 JOIN 文档表，与 loadFresh/stats 统一。
3. **matchMode 对 agent 不可见（真实 e2e 抓出）**：输出结构里有但 render 文本没有，agent 无法引用。render 首行加入 `[hybrid:fts+vec]` 标注，复测 agent 正确报告。
4. 测试侧两处自伤：model 隔离断言选了 FTS 必命中的查询（改为直测 knn 过滤）；openai mock 未算 URL 拼接后缀、Float32 精度断言（近似比较）。

## 配置示例

```yaml
- id: dsh-memory-core
  name: "@local/dsh-memory-core"
  config:
    dbPath: E:/ClowderAI/dsh-memory/dev/evidence.sqlite
    roots: [E:/ClowderAI/dsh-memory/dev/knowledge]
    vector:
      enabled: true          # 默认 hash 后端，开箱即用
      # backend: openai     # 切换真实语义质量：
      # baseUrl: https://api.example.com/v1
      # apiKeyEnv: MY_EMB_KEY
      # model: text-embedding-3-small
      backfillBatch: 64
```

## 已知边界

- hash 后端是**词法 n-gram** 语义（重叠召回），不是神经网络语义；跨词汇能力来自 n-gram 宽容度而非理解。真正的语义质量需配置 openai 后端（管线已就绪、mock e2e 已验证 HTTP 路径）。
- 查询向量对 async 后端每次实时计算（无查询缓存）——个人规模无碍，高频场景可加 LRU。

## M5 就绪度

剩余：发布打磨（profile 模板化、`dsh plugin` 安装路径、README 汇总）、可选 open loop schedule 投递、（按用户决策取消 people）。
