# dsh-memory-decisions — DSH 记忆插件 M2（决策 cue）

在 M1 证据库之上，把 **accepted 决策**变成"判断点一次性浮现"的主动提示：每个对话轮开始时，
用用户消息检索决策索引，未消费的 accepted 决策注入一行 cue；同 revision 永不重复；
supersede/草稿永不浮现；预算封顶。

## 行为契约（移植自 Clowder DecisionMemoryCueSource）

| 契约 | 实现 |
|---|---|
| 只有 accepted 且无 superseder 的决策可浮现 | `cue-service.js` 双过滤；`captured` 草稿 fail-closed |
| 同 (owner, anchor, revision) 恰好浮现一次 | 注入即记 `cue_episodes`（terminal=presented，幂等） |
| 源文件修订 → 新 revision 合法地再浮现一次 | 账本按 revision 作用域（M1 契约） |
| drill（回源验证读取）≠ cue 呈现 | 两种 family 行并存：`decision`/`drill` |
| 每轮/每日预算 | `perTurnMax`（默认 1）/ `dailyMax`（默认 10，UTC 日） |
| 只在 turn 第一步判断 | `agent/pre-step` + `step === 1`，不打断轮中 |

## 注入机制（照 dsh-time-context 惯例）

`ctx.on("agent/pre-step")` → `await next()` → 向 `decision.messages` 追加一条
`createUserMessage`，`source.kind = 'dsh-memory-decisions'`（可追溯、可被会话投影识别）。

## 配置

```yaml
- id: dsh-memory-decisions
  name: "@local/dsh-memory-decisions"
  config:
    dbPath: E:/ClowderAI/dsh-memory/dev/evidence.sqlite  # 与 core 共享
    owner: default
    perTurnMax: 1
    dailyMax: 10
    enabled: true
```

## 测试

```bash
node --test test/cue-service.test.mjs test/plugin.test.mjs   # 8/8
```

覆盖：一次性浮现、草稿/superseded 永不浮现、修订后再浮现一次、双预算抑制、
pre-step 注入形状、禁用开关、step>1 不注入。
