# M2 验收报告 — @local/dsh-memory-decisions

日期：2026-10-18 · 状态：**已验收** · 单测 8/8 绿（M1 回归 14/14 绿）· 真实 headless 三轮 e2e 通过

## 交付物

| 路径 | 内容 |
|---|---|
| `index.js` | 插件入口：`agent/pre-step` 钩子（照 dsh-time-context 惯例）注入 source-attributed 用户消息 |
| `src/cue-service.js` | 纯逻辑 cue 服务：候选检索 → accepted 过滤 → 账本过滤 → 预算 → 渲染 |
| `test/*.test.mjs` | 8 项测试（cue-service 5 + plugin 3） |
| `cordis.patch.yml` + package.json `dsh.bundle` | bundle 层接入 |

对 M1 core 的唯一增量改动：`drill` 成功时记录 `family='drill'` 的消费行（效用归因地基，向后兼容）。

## 契约对照

| 计划契约 | 验证 |
|---|---|
| accepted 决策在判断点浮现一次 | 单测 ✔ + e2e Job 1（ADR-002 cue 注入，agent 受引导主动 search+drill 引用 ADR-001 完整理由）✔ |
| 同 revision 不重复 | 单测 ✔ + e2e Job 2 账本（ADR-002 未重复；新命中的 ADR-001 合法首次呈现）✔ |
| 全部消费后零注入，pull 兜底 | e2e Job 3：agent 明确回答"本轮无新 cue"，账本零新增，仍经 memory_search 正确作答 ✔ |
| supersede/草稿永不浮现 | 单测（captured 草稿 ADR-003、superseded ADR-002 均被过滤）✔ |
| 修订后再浮现一次 | 单测（编辑源文件 + 重扫 → 新 revision 恰好再呈现一次）✔ |
| 预算封顶 | 单测（perTurnMax=0 / dailyMax=0 / 日预算耗尽三种抑制）✔ |
| 只在 turn 开头判断 | 单测（step>1 不注入）✔ |

## 真实链路三轮 e2e 时间线（glm-5.3-flash headless）

| 轮 | 用户消息要点 | 注入的 cue | 账本新增 | agent 行为 |
|---|---|---|---|---|
| Job 1 | 选数据库驱动 | ADR-002（查询词命中） | decision:ADR-002 presented | 受 cue 引导 → 主动 search → **drill ADR-001**（drill 行）→ 引用完整决策理由 |
| Job 2 | 同话题追问 | ADR-001（此前仅 drill 过，首次 cue 呈现）；ADR-002 未重复 | decision:ADR-001 presented | 复述决策并确认"source matched the indexed revision" |
| Job 3 | 再次追问+质询是否有新 cue | **无** | 零新增 | 明确回答"Nothing introduces a new cue"，经 pull 正确作答 |

关键观察：**推（cue）拉（search/drill）协同**——cue 负责把注意力引向记忆库（每 revision 一次），
pull 负责持续可用；两者消费账本分 family 记账，互不干扰。

## 过程中发现并修复的问题

1. **测试期望绝对化错误**：初版断言"第二轮 candidates.length===0"，实际第二轮合法浮现了另一个
   未消费的 accepted 决策（ADR-002）——是测试写错，不是实现错。改为按 anchor+revision 断言。
2. **诊断脚本揭示的语义澄清**：drill（family='drill'）与 cue 呈现（family='decision'）是不同观察面，
   ADR-001 被 drill 过不代表它作为 cue 呈现过——Job 2 的呈现是正确行为，非重复。

## 配置示例（memory-dev-h profile 已验证）

```yaml
- id: dsh-memory-decisions
  name: "@local/dsh-memory-decisions"
  config:
    dbPath: E:/ClowderAI/dsh-memory/dev/evidence.sqlite
    owner: default
    perTurnMax: 1
    dailyMax: 10
```

## 已知边界

- 查询词命中精度依赖 FTS trigram（无向量语义），偶尔 cue 命中"次相关"决策（Job 1 的 ADR-002）
  ——但 agent 的 search+drill 会自行纠正，实测无负面影响；向量检索（Phase 4）可根治。
- 单用户简化：注入即记 terminal（presented），无独立 dismissed 通道；agent 忽略 cue 即视为
  该 revision 终结，pull 仍可用。
- supersede 的真实链路演示被"已 presented 双重保险"遮蔽，由单测覆盖。

## M3 就绪度

lessons（提名-审核-物化）与 events（幂等事件 + 半衰期）可复用：
- `cue_episodes` 双 family 模式（呈现/drill 分账）
- `agent/pre-step` 注入通道与 `createUserMessage` 形状
- core 的 `INACTIVE_STATUSES`/`supersede`/`search` 全部就位
