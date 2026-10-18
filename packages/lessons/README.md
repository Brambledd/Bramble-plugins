# dsh-memory-lessons — 教训沉淀

把协作中发现的可复用经验变成永久记忆：agent 提名、你批准、写入知识目录，之后所有会话都能检索到。写入权掌握在你手里——agent 只能提名，不能自行写入。

## 工具

| 工具 | 用途 |
|---|---|
| `lesson_nominate` | agent 提名一条教训（自动脱敏 API key、邮箱、IP 等敏感内容），等待你的批准 |
| `lesson_approve` | 你明确同意后由 agent 调用：教训写入知识目录，立即可被检索（无需重启） |
| `lesson_reject` | 拒绝提名（保留记录供审计） |
| `lesson_pending` | 列出所有待你决定的提名 |

## 配置

```yaml
- id: dsh-memory-lessons
  name: "@local/dsh-memory-lessons"
  config:
    dbPath: E:/my-memory/lessons.sqlite           # 提名队列（自动创建）
    lessonsRoot: E:/my-memory/knowledge/lessons   # 批准后的教训写到这里
    evidenceDbPath: E:/my-memory/evidence.sqlite  # 与 core 共用
    evidenceRoot: E:/my-memory/knowledge          # core 的知识目录
```

`lessonsRoot` 必须位于 core 的 `roots` 之内，批准的教训才能立即被检索到。

## 测试

```bash
node --test test/
```
