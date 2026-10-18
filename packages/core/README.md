# dsh-memory-core — 记忆核心（检索与证据库）

为 agent 提供跨会话的持久记忆检索：把知识目录里的 markdown（决策、教训、笔记）建立全文+语义双路索引，任何会话都能查询并读取经过校验的原文。

## 提供

- `memory_search`：全文+语义混合检索，返回标题、摘要、锚点、版本号；中文查询自动加权语义路
- `memory_drill`：按锚点+版本号读取原文；每次读取都会校验源文件是否被修改过，改过则拒绝返回旧内容
- `memory_stats`：记忆库概况（条数、类型分布、语义索引覆盖）
- 一行系统提示，告知 agent 在判断点先查记忆再重新决策

## 配置

```yaml
- id: dsh-memory-core
  name: "@local/dsh-memory-core"
  config:
    dbPath: E:/my-memory/evidence.sqlite   # 索引文件（自动创建）
    roots: [E:/my-memory/knowledge]        # 知识目录，启动时自动扫描
    maxResults: 8                          # memory_search 默认条数
    reindexOnStart: true                   # 启动时增量重扫
    promptHint: true
    vector:
      enabled: true                        # 语义检索（默认内置离线算法）
      # backend: openai                   # 可选：接真实语义模型
      # baseUrl: https://api.example.com/v1
      # apiKeyEnv: MY_EMB_KEY
      # model: text-embedding-3-small
```

## 知识目录约定

- `decisions/` 下的文件识别为决策；frontmatter `status: accepted` 表示已采纳
- `lessons/` 下为教训；`notes/` 下为普通笔记
- 详见仓库根 README 的"放入你的知识文件"

## 运维

```bash
node scripts/reindex.mjs --db <dbPath> --root <dir>   # 手动扫描
node scripts/reindex.mjs --db <dbPath> --rebuild      # 从源文件全量重建索引
node scripts/reindex.mjs --db <dbPath> --search "查询词"
node scripts/reindex.mjs --db <dbPath> --stats
```

## 测试

```bash
node --test test/
```
