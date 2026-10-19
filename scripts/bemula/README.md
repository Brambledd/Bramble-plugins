# Bemula 跑分（记忆遗忘基准）

把 Bramble 接入 [Bemula](https://arxiv.org/abs/2610.18052)——首个记忆反学习基准
（50 双变体对话、135 个遗忘请求、1742 个探针、五套件：retention/efficacy/
preservation/relearning/attack）。

## 架构

```
bemula-benchmark (Python)                 Bramble-plugins (Node)
┌──────────────────────┐    行协议 JSON-RPC   ┌─────────────────────────┐
│ bramble_adapter.py   │ ───────────────────▶ │ bridge.mjs              │
│  MemoryAdapter 子类   │   stdin/stdout      │  EvidenceStore + 向量路  │
│  forget 意图识别(LLM) │ ◀─────────────────── │  (临时库, 不碰真实记忆)   │
│  答案生成(LLM)       │    每行一个响应       │  EventStore             │
└──────────────────────┘                    └─────────────────────────┘
```

诚实路线：**不使用**基准的 `linked_fact_ids` 元数据定位删除目标（那是评测的
ground truth，用它等于作弊）——遗忘请求按普通对话轮进入，适配器用 LLM 抽取
目标短语 → 检索定位 → 公开删除 API 移除。

## 离线试跑（无 LLM，启发式遗忘路径）

```powershell
cd E:\ClowderAI\bemula-benchmark
$env:PYTHONPATH = "$PWD"
python E:\ClowderAI\Bramble-plugins\scripts\bemula\trial_offline.py
```

已验证（quick_check inst0，"forget my favorite color"）：意图检测 1/1；
删除后 efficacy/attack 探针全部拿不到 color（存储级删除，天然抗诱导）；
preservation 全部保留（职业/网球/咖啡）。

## 完整跑分（需要 LLM key）

1. `bemula-benchmark/.env`（OpenAI 兼容端点，judge 与 agent 模型）：

```
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-...
BEMULA_JUDGE_MODEL=deepseek-flash
BEMULA_AGENT_MODEL=deepseek-flash
BEMULA_THINKING=disabled
```

2. run_eval 已打 bramble 注册补丁（本机克隆已改）；新克隆需在
   `scripts/run_eval.py` 的 `_build_baseline` 加 `bramble` 分支。

```powershell
cd E:\ClowderAI\bemula-benchmark
$env:PYTHONPATH = "$PWD"
$env:BRAMBLE_PLUGINS_DIR = "E:\ClowderAI\Bramble-plugins"
python -m scripts.run_eval --baseline bramble `
  --dialogues data/quick_check/dialogues.jsonl `
  --questions data/quick_check/questions.jsonl `
  --out results/bramble_quick --limit 5 --workers 1
```

产出：`results/bramble_quick/`（items.jsonl / metrics.json / report.md）。

## 排查中修过的坑

- bridge 的 turn 无 revision → 向量回填 NOT NULL 静默失败（向量路实际未启用）
- forget 请求 turn 自身入库并污染 AND 检索（客套词使其成为唯一完美匹配）
  → 请求 turn 先删自身、目标短语剔停用词、双探针（全词 + 尾 bigram）
- embedBackfill 现在跳过无 revision 的行（防御）
