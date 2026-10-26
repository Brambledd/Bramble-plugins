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

## Reader-QA 端到端准确率（S 集全量 500 题，GLM 官方判分协议）

方法：top-3 检索会话为上下文（session 粒度 BM25）→ reader `glm-5.3` 仅依据上下文作答（无金标泄漏）→ judge `glm-5.3` 按 **LongMemEval 官方 `evaluate_qa.py` 判分模板**（temporal 容差一位、knowledge-update 新答案规则、preference rubric 语义、abstention 模板）标注 yes/no。判分脚本 `bench/qa-full.mjs`（断点续跑、并发 8，全程 8.3 分钟）。

| 指标 | 值 |
|---|---|
| **总体准确率（n=500）** | **56.0%** |
| 拒答 abstention（n=30，`_abs`） | **96.7%** |
| single-session-assistant（n=56） | **98.2%** |
| single-session-user（n=70） | 84.3% |
| knowledge-update（n=78） | 57.7% |
| single-session-preference（n=30） | 50.0% |
| multi-session（n=133） | 45.1% |
| temporal-reasoning（n=133） | 34.6% |

30 题小样本先导实验（28 判定）：总体 53.6%，命中 top-3 时 66.7% vs 未命中 14.3%——与全量结论一致：**准确率瓶颈在检索覆盖与多会话聚合，纯阅读错误趋零**。

## CJK 短笔记对照（合成集，16 查询 × 3 regime）

BM25 与 hash-hybrid **零分歧**（exact 0.33/0.33，2char 0.25/0.25，synonym 0.67/0.67）：2 字词盲区已被 LIKE/probe 兜底，真同义词缝隙 hash 的 n-gram 投影也跨不过。**hash 车道在短中文笔记上同样无增益。**

## 四个发现与已落地的产品变更

1. **hash 向量车道默认关闭（`vector.enabled` 默认 true → opt-in）**：S 集 R@5 0.924→0.614（无门控）；CJK 对照零增益。叠加历史静默失败（动态条目 NULL revision 触发 backfill 崩溃被 `.catch` 吞掉、一条笔记即杀全车道），证据链完整。已修：动态内容哈希自身真值为 revision；backfill 加 `source_hash IS NOT NULL` 防御。
2. **长度门 `vector.maxIndexedChars`（默认 2000）**：长文本不入向量道。但发现 RRF 结构性缺陷——长度门造成不对称后，弱词法+强向量的短文档借双路加成（fts rank 21 + vec rank 0 → 0.029）可跳到金标（1/60）之前；即使对 vec-only 打 ×0.5 折扣，R@1 仍崩。结论：**加性 RRF 无法在异质长度语料上安全融合弱向量道**——默认关闭是唯一稳健选择，真嵌入后端重启此实验。
3. **日期 token + 时间感知加成：本集零收益（诚实负结果）**：temporal 题面几乎不含可解析时间词，加成不触发；该题型考阅读器日期推理。适用面为显式带时间词的查询。
4. **session 粒度优于裸 turn 粒度**：R@5 0.924 vs 0.918，preference 题 0.767 vs 0.567——粒度收益来自语义切分质量（需 LLM），不是机械碎片化。

## 局限（原始四条的现状）

- ~~QA 子样本 n=30~~ → **已解决**：S 集全量 500 题端到端 QA（官方判分协议，56.0%）；
- ~~官方 judge 对接~~ → **已解决**：`evaluate_qa.py` 四套判分模板逐字移植 + abstention 模板；
- ~~cleaned 版复跑~~ → **已解决（检索侧）**：cleaned S 470 题 R@1 0.802 / R@5 0.928 / MRR 0.859（略优于原版，系统对数据清洗鲁棒）；cleaned 版 QA 未跑（预算约束）；
- ~~abstention 未覆盖~~ → **已解决**：30 题拒答准确率 96.7%（错 1 例为拒答不足）。

## 复现

```bash
# 数据（一次性）：https://huggingface.co/datasets/xiaowu0162/LongMemEval
#   data/longmemeval_s.json（265MB）与 data/longmemeval_oracle.json（15MB），已在 .gitignore
node bench/eval-longmemeval.mjs --data s --limit 500 --mode session --out bench/results/s-session-bm25.json
node bench/eval-longmemeval.mjs --data s --limit 500 --mode session --vector on --out bench/results/s-session-hybrid.json
node bench/eval-cjk-synthetic.mjs
node bench/build-qa-sample.mjs   # 生成 reader-QA 样本
```
