# dsh-memory-events — DSH 记忆插件 M3b（时间记忆）

带时间的记忆：承诺、结果、里程碑、事故。坐标哈希幂等写入；硬遗忘（墓碑，永不复活）；
时间窗 + 半衰期排序检索；开环（dueAt）清单。

## 工具

| 工具 | 行为 |
|---|---|
| `event_mark` | 幂等记录（sourceKey 坐标优先）；墓碑坐标返回 `suppressed` |
| `event_search` | 文本 + since/until 时间窗 + kind 过滤，半衰期排序（新鲜事件优先） |
| `event_forget` | 硬遗忘：按 eventKey **或 sourceKey** 删除 + 墓碑；未知坐标 not_found |
| `event_stats` | 计数、墓碑数、已到期开环 |

## 配置

```yaml
- id: dsh-memory-events
  name: "@local/dsh-memory-events"
  config:
    dbPath: E:/ClowderAI/dsh-memory-events/dev/events.sqlite
```

## 测试

```bash
node --test test/event-store.test.mjs test/plugin.test.mjs
```
