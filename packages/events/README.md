# dsh-memory-events — 时间线记忆

带时间戳的记忆：承诺、结果、里程碑、事故。适合"我们什么时候说好要做 X""上次出问题是什么时候"这类问题，也用于到期未完成承诺的追踪。

## 工具

| 工具 | 用途 |
|---|---|
| `event_mark` | 记录一个事件；同一事件（同 sourceKey）重复记录自动去重 |
| `event_search` | 按关键词和/或时间窗（since/until）查询，越新的事件排越前 |
| `event_forget` | 彻底删除一个事件——之后同一事件永远无法再被记录 |
| `event_stats` | 事件统计：各类型数量、已删除数、到期未完成的承诺 |

## 配置

```yaml
- id: dsh-memory-events
  name: "@local/dsh-memory-events"
  config:
    dbPath: E:/my-memory/events.sqlite   # 事件库（自动创建）
```

## 测试

```bash
node --test test/
```
