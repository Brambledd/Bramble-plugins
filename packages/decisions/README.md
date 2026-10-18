# dsh-memory-decisions — 决策提醒

已采纳的决策在对话恰当时机自动浮现一次：当你的消息与某条已采纳决策相关时，agent 会收到一行提醒（标题+摘要+如何读取原文），从而主动查证而不是重新争论已定的事。

## 行为

- 只提醒 `status: accepted` 且未被替代的决策；草稿和已废弃的不提醒
- 同一版本只提醒一次（内容修订后会就新版本再提醒一次）
- 每轮对话最多提醒 1 条、每天最多 10 条（可配置），不会刷屏
- 提醒发生在对话轮开始时，不打断进行中的回答

## 配置

```yaml
- id: dsh-memory-decisions
  name: "@local/dsh-memory-decisions"
  config:
    dbPath: E:/my-memory/evidence.sqlite   # 与 core 共用同一索引
    perTurnMax: 1                          # 每轮最多提醒条数（0-5）
    dailyMax: 10                           # 每日上限（UTC 日）
    enabled: true
```

## 测试

```bash
node --test test/
```
