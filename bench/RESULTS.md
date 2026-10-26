# LongMemEval 检索评测报告（bramble-memory）

数据集：[LongMemEval-S](https://arxiv.org/abs/2410.10813)（ICLR 2025）全量 500 题、S 集完整干扰 haystack（~115k token/题）。
协议：检索阶段评测（论文三阶段框架的 indexing+retrieval）——每题独立建证据库 → 索引 haystack 会话 → 用问题原文检索 → 与 `answer_session_ids` 金标比对；另含 30 题子样本的 reader-QA 端到端准确率（见下）。

## 主结果（500 题，全题型，检索召回）

| 配置 | R@1 | R@3 | R@5 | MRR |
|---|---|---|---|---|
| **session + BM25（默认配置，最优）** | **0.786** | **0.900** | **0.924** | **0.849** |
| session + hash 向量（无门控，旧默认） | 0.378 | 0.490 | 0.614 | 0.485 |
| session + hash 向量（长度门 2000） | 0.088 | 0.866 | 0.918 | 0.476 |
| turn + BM25 | 0.782 | 0.886 | 0.918 | 0.839 |
| ±日期 token（消融） | 0 | 0 | 0 | 0 |

分题型 R@5（session-BM25 / turn-BM25）：

| 题型 | n | session | turn |
|---|---|---|---|
| temporal-reasoning | 133 | 0.872 | 0.887 |
| multi-session | 133 | 0.962 | 0.932 |
| knowledge-update | 78 | 0.962 | **0.987** |
| single-session-user | 70 | 0.914 | 0.957 |
| single-session-assistant | 56 | **1.000** | **1.000** |
| single-session-preference | 30 | **0.767** | 0.567 |

## Reader-QA 端到端准确率（30 题子样本，每题型 10 题；已判 28，2 题在途）

方法：top-3 检索会话作为上下文，无金标泄漏的 reader（隔离子代理）作答，parent 按与金标语义一致判分。

| 指标 | 值 |
|---|---|
| 总体准确率（n=28） | **53.6%** |
| top-3 命中时准确率（n=21） | 66.7% |
| top-3 未命中时准确率（n=7） | 14.3% |
| single-session-user（n=10） | 0.80 |
| multi-session（n=9） | 0.22 |
| single-session-preference（n=9） | 0.56 |

误差分解（13 个错误）：**10 个纯检索失败**（top-3 未包含证据会话 → NOT FOUND 或答非所问），**3 个多会话聚合失败**（证据会话部分命中，计数不全：gold 5 答 3、gold 8 答 3、gold 4 答 1），**0 个纯阅读错误**——证据检索完整时 reader 全对。准确率天花板由检索决定。

## CJK 短笔记对照（合成集，16 查询 × 3 regime）

BM25 与 hash-hybrid **零分歧**（exact 0.33/0.33，2char 0.25/0.25，synonym 0.67/0.67）：2 字词盲区已被 LIKE/probe 兜底，真同义词缝隙 hash 的 n-gram 投影也跨不过。**hash 车道在短中文笔记上同样无增益。**

## 四个发现与已落地的产品变更

1. **hash 向量车道默认关闭（`vector.enabled` 默认 true → opt-in）**：S 集 R@5 0.924→0.614（无门控）；CJK 对照零增益。叠加历史静默失败（动态条目 NULL revision 触发 backfill 崩溃被 `.catch` 吞掉、一条笔记即杀全车道），证据链完整。已修：动态内容哈希自身真值为 revision；backfill 加 `source_hash IS NOT NULL` 防御。
2. **长度门 `vector.maxIndexedChars`（默认 2000）**：长文本不入向量道。但发现 RRF 结构性缺陷——长度门造成不对称后，弱词法+强向量的短文档借双路加成（fts rank 21 + vec rank 0 → 0.029）可跳到金标（1/60）之前；即使对 vec-only 打 ×0.5 折扣，R@1 仍崩。结论：**加性 RRF 无法在异质长度语料上安全融合弱向量道**——默认关闭是唯一稳健选择，真嵌入后端重启此实验。
3. **日期 token + 时间感知加成：本集零收益（诚实负结果）**：temporal 题面几乎不含可解析时间词，加成不触发；该题型考阅读器日期推理。适用面为显式带时间词的查询。
4. **session 粒度优于裸 turn 粒度**：R@5 0.924 vs 0.918，preference 题 0.767 vs 0.567——粒度收益来自语义切分质量（需 LLM），不是机械碎片化。

## 局限

- 检索召回为主 + 30 题 QA 子样本（每题型 10，temporal/knowledge-update/assistant 三题型 QA 在跑第二批）；无官方 judge 脚本对接（评测判分为语义一致判据）；
- 使用 2024-10 原始 S 集，未用 2025-09 cleaned 版；
- 索引的是原始会话文本，生产经 LLM 事实抽取的结果可能不同；
- abstention（30 题，金标为空）未覆盖。

## 复现

```bash
# 数据（一次性）：https://huggingface.co/datasets/xiaowu0162/LongMemEval
#   data/longmemeval_s.json（265MB）与 data/longmemeval_oracle.json（15MB），已在 .gitignore
node bench/eval-longmemeval.mjs --data s --limit 500 --mode session --out bench/results/s-session-bm25.json
node bench/eval-longmemeval.mjs --data s --limit 500 --mode session --vector on --out bench/results/s-session-hybrid.json
node bench/eval-cjk-synthetic.mjs
node bench/build-qa-sample.mjs   # 生成 reader-QA 样本
```
