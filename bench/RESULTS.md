# LongMemEval 检索评测报告（bramble-memory）

数据集：[LongMemEval-S](https://arxiv.org/abs/2410.10813)（ICLR 2025）oracle 变体的全量 500 题、S 集完整干扰 haystack（~115k token/题）。
协议：检索阶段评测（论文三阶段框架的 indexing+retrieval）——每题独立建证据库 → 索引 haystack 会话 → 用问题原文检索 → 与 `answer_session_ids` 金标比对。无 reader LLM / judge，答案生成质量不在本报告范围。

## 主结果（500 题，全题型）

| 配置 | R@1 | R@3 | R@5 | MRR |
|---|---|---|---|---|
| **session + BM25（推荐基线）** | **0.786** | **0.900** | **0.924** | **0.849** |
| session + hash 向量融合 | 0.378 | 0.490 | 0.614 | 0.485 |
| turn + BM25 | 0.782 | 0.886 | 0.918 | 0.839 |
| session 无日期 token（消融） | 0.786 | 0.900 | 0.924 | 0.849 |
| turn 无日期 token（消融） | 0.782 | 0.886 | 0.918 | 0.839 |

分题型 R@5（session-BM25 / turn-BM25）：

| 题型 | n | session | turn |
|---|---|---|---|
| temporal-reasoning | 133 | 0.872 | 0.887 |
| multi-session | 133 | 0.962 | 0.932 |
| knowledge-update | 78 | 0.962 | **0.987** |
| single-session-user | 70 | 0.914 | 0.957 |
| single-session-assistant | 56 | **1.000** | **1.000** |
| single-session-preference | 30 | **0.767** | 0.567 |

## 四个发现

1. **hash 向量车道在长文本语料上是毒药（关键产品发现）**：启用后 R@5 从 0.924 崩到 0.614。随机投影嵌入对多 KB 文本近似噪声，RRF 把 50 个噪声候选灌进头部排名。生产配置 `vector.enabled` 默认 `true`——**对长文本语料这是负收益默认值**。建议：长文本场景关掉向量车道，等 sqlite-vec + 真嵌入模型再默认开启（短中文笔记场景 hash 车道可能仍有益，未在本集验证）。
2. **日期 token + 时间感知加成：本集零收益（诚实负结果）**。消融完全持平。原因：temporal-reasoning 题面极少携带可解析时间词（如 "What was the first issue I had with my new car..."），加成根本不触发——该题型考的是**日期推理**（阅读器职责），不是检索排序。时间加成的适用面是"显式带时间词的查询"，本集不含此类。
3. **session 粒度优于 turn 粒度（与论文直觉相反）**：论文的 "session decomposition" 指事实级语义切分（需 LLM），不是原始单轮笔记——裸 turn 丢失跨轮共现上下文，preference 题型差距最大（0.767 vs 0.567，偏好往往跨多轮陈述）。推论：粒度收益来自**语义切分质量**，不是切得越碎越好。
4. **评测暴露并修复一个产品级 bug**：动态条目（observe/capture 写入）`revision=null` 会让 `embedBackfill` 触发 NOT NULL 崩溃，而插件启动时的 `.catch` 把它静默吞掉——**一条动态笔记就能永久杀死整条向量车道**。已修：动态内容哈希自身真值为 revision（ingest + F6 replacement），backfill 加 `source_hash IS NOT NULL` 防御。

## 局限

- 检索侧单阶段评测：reading/judge 未测（需 reader LLM）；
- 索引的是原始会话文本；生产路径会经 capture 的 LLM 事实抽取，结果可能更好也可能更差；
- abstention 题型不在 oracle/S 集（其金标为空），未覆盖；
- M 集未跑（内存与时长约束，S 是论文主战场）。

## 复现

```bash
# 数据（一次性）：https://huggingface.co/datasets/xiaowu0162/LongMemEval
#   data/longmemeval_s.json（265MB）与 data/longmemeval_oracle.json（15MB），已在 .gitignore
node bench/eval-longmemeval.mjs --data s --limit 500 --mode session --out bench/results/s-session-bm25.json
node bench/eval-longmemeval.mjs --data s --limit 500 --mode session --vector on --out bench/results/s-session-hybrid.json
node bench/eval-longmemeval.mjs --data s --limit 500 --mode turn --date-tokens off --out bench/results/s-turn-nodate.json
```
