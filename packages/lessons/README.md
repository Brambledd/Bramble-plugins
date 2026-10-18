# dsh-memory-lessons — DSH 记忆插件 M3a（教训蒸馏）

把"一个项目踩过的坑"经 **提名 → 用户批准 → 物化** 变成跨会话可检索的教训。AI 只能提名，
批准权在人；批准后物化为 markdown 文件（文件即真相）并**立即**进入证据索引。

## 工具

| 工具 | 权力 |
|---|---|
| `lesson_nominate` | AI：提名（自动脱敏：api-key/bearer/email/ip/hex-blob）→ pending 候选 |
| `lesson_approve` | 仅在用户明确批准后调用：物化 `lesson-<slug>.md` + 立即重扫索引 |
| `lesson_reject` | 拒绝（保留审计行） |
| `lesson_pending` | 列出待决候选 |

## 配置

```yaml
- id: dsh-memory-lessons
  name: "@local/dsh-memory-lessons"
  config:
    dbPath: E:/ClowderAI/dsh-memory-lessons/dev/lessons.sqlite   # 候选库（truth side）
    lessonsRoot: E:/ClowderAI/dsh-memory/dev/knowledge/lessons   # 物化目录（须在 core root 内）
    evidenceDbPath: E:/ClowderAI/dsh-memory/dev/evidence.sqlite  # core 索引
    evidenceRoot: E:/ClowderAI/dsh-memory/dev/knowledge
```

## 测试

```bash
node --test test/candidate-store.test.mjs test/plugin.test.mjs
```
