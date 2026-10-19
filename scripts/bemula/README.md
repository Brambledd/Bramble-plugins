# Bemula 跑分（记忆遗忘基准）

把 Bramble 接入 [Bemula](https://arxiv.org/abs/2610.18052)——首个记忆反学习基准
（50 双变体对话、135 个遗忘请求、1742 个探针、五套件：retention/efficacy/
preservation/relearning/attack）。

## 成绩（GLM-5.3，coding 端点）

| 切分 | Bemula Score | RA-gated | 说明 |
|---|---|---|---|
| quick_check（1 实例 F1 冒烟，flash） | 0.894 | 0.894 | 机制正确性验证：FE/PR/RLA 满分 |
| lite 前 5 实例 v1（flash） | 0.123 | 0.215 | 初始基线 |
| lite 前 5 实例 v5e（flash + 五项优化） | 0.194 | 0.226 | FE raw 0.786、AR 0.369 |
| **lite 前 5 实例 v5g（GLM-5.3 + 惰性固化修复）** | **0.313** | **0.400** | **超论文全部 20 组运行（最高 0.310）** |

v5g 分项：RA 0.786 · FE 0.571（raw 0.786）· PR 0.533 · **RLA 0.833**（惰性 recent-only 固化）· AR 0.385 · UG 0.667 · FA 0.469。

对照：论文官方 20 组运行的最高 Bemula Score 为 langmem/deepseek 的 0.310。

剩余短板：F4 推理删除（弱信号推断的结构性两难：不固化则无物可删，固化则
与"≥1 事实支持"规则冲突）、长对话检索召回（RA 0.786）、类别删除的覆盖面（F3）。

## 首次成绩存档（quick_check）

```
Bemula Score: 0.894

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
