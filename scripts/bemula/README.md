# Bemula 跑分（记忆遗忘基准）

把 Bramble 接入 [Bemula](https://arxiv.org/abs/2610.18052)——首个记忆反学习基准
（50 双变体对话、135 个遗忘请求、1742 个探针、五套件：retention/efficacy/
preservation/relearning/attack）。

## 首个正式成绩（quick_check，glm-5.3-flash）

```
Bemula Score: 0.894   （论文中六个主流记忆系统端到端通过率 ≤1.5%）

RA 存储        1.000
FE 遗忘效力     1.000   ← 删除被要求删的：满分
PR 无关保留     1.000   ← 不误删：满分
RLA 重学       1.000
AR 抗攻击      0.800   ← forget 变体 5/5 攻击全部防住；唯一扣分的
                         jailbreak 是评测配对机制所致（control 侧答案
                         生成模型对 SYSTEM OVERRIDE 措辞带保留语气，配对
                         前提不成立），非删除能力缺陷
```

结果目录：`bemula-benchmark/results/bramble_quick/`（items.jsonl / metrics.json / report.md）。

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

## 运行

```powershell
cd E:\ClowderAI\bemula-benchmark
$env:PYTHONPATH = "$PWD"
$env:BRAMBLE_PLUGINS_DIR = "E:\ClowderAI\Bramble-plugins"
# .env 已配 GLM（glm-5.3-flash）
python -m scripts.run_eval --baseline bramble `
  --dialogues data/core/dialogues.jsonl --questions data/core/questions.jsonl `
  --out results/bramble_core5 --limit 5 --workers 2 --resume
```

依赖（pip 清华镜像）：pydantic python-dotenv openai tqdm rich tenacity numpy。
新克隆的 bemula-benchmark 需在 `scripts/run_eval.py` 的 `_build_baseline`
注册 `bramble` 分支。

## 离线试跑（无 LLM）

```powershell
python E:\ClowderAI\Bramble-plugins\scripts\bemula\trial_offline.py
python E:\ClowderAI\Bramble-plugins\scripts\bemula\trial_llm.py   # 带 LLM 追踪
```

## 排查中修过的坑

- bridge 的 turn 无 revision → 向量回填 NOT NULL 静默失败（向量路实际未启用）
- forget 请求 turn 自身入库并污染 AND 检索（客套词使其成为唯一完美匹配）
  → 请求 turn 先删自身、目标短语剔停用词、双探针（全词 + 尾 bigram）
- embedBackfill 现在跳过无 revision 的行（防御）
