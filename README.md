# Bramble-plugins

DSH（DeepSeek Harness）记忆插件套件——让你的 agent 拥有跨会话的持久记忆：记住做过的决策、沉淀踩过的教训、追踪时间线上的事件，并在合适的时机主动提醒。

零原生依赖（Node 22.5+ 自带的 SQLite + FTS5），装进 profile 即用。

## 装上之后 agent 能做什么

| 能力 | 对话中的表现 |
|---|---|
| **跨会话记忆** | 上周会话里记的决策、教训，今天新会话直接问"我们之前怎么定的"，agent 能检索到并给出原文出处 |
| **决策提醒** | 你问"数据库驱动选哪个"，agent 会收到提示："已有一条相关决策（ADR-001），要验证可读取原文"——同一决策只提醒一次，不打扰 |
| **教训沉淀** | 协作中发现可复用的经验，agent 提名一条教训，你回复批准，它就成为永久记忆，之后所有会话都能检索到 |
| **时间线记忆** | 承诺、里程碑、事故按时间记录；重复记录自动去重；说"忘掉这件事"会彻底删除且永不复活 |
| **中文友好检索** | 全文 + 语义双路检索，中文查询（含同义不同词的表达）都能命中 |

## 快速开始

### 一条命令安装（推荐）

```powershell
git clone https://github.com/Brambledd/Bramble-plugins.git
cd Bramble-plugins
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本自动完成：探测 profile → 备份现有配置 → 链接插件包 → 写入 bundles 与配置 →
生成示例决策文件 → 静态验证。重复运行安全（幂等，已装部分自动跳过）。

```powershell
powershell -File .\install.ps1 -Profile web              # 指定 profile
powershell -File .\install.ps1 -DataDir D:\my-memory     # 指定数据目录（默认 ~/.dsh/memory）
powershell -File .\uninstall.ps1                         # 一键卸载（数据保留）
```

装完重启 DSH，新开会话即可使用（见下方"试试"）。知识文件目录默认在
`~/.dsh/memory/knowledge`，格式见"放入你的知识文件"。

<details>
<summary>手动安装（不使用脚本时的完整步骤）</summary>

**1. 链接插件包**到你的 profile：

```powershell
# 假设仓库克隆到 E:\Bramble-plugins，profile 名为 my
$dshHome = "$env:USERPROFILE\.dsh"
New-Item -ItemType Directory -Force "$dshHome\profiles\my\node_modules\@local" | Out-Null
cmd /c mklink /J "$dshHome\profiles\my\node_modules\@local\dsh-memory-core" "E:\Bramble-plugins\packages\core"
cmd /c mklink /J "$dshHome\profiles\my\node_modules\@local\dsh-memory-decisions" "E:\Bramble-plugins\packages\decisions"
cmd /c mklink /J "$dshHome\profiles\my\node_modules\@local\dsh-memory-lessons" "E:\Bramble-plugins\packages\lessons"
cmd /c mklink /J "$dshHome\profiles\my\node_modules\@local\dsh-memory-events" "E:\Bramble-plugins\packages\events"
```

**2. 编辑 profile 的 `package.json`**，在 `dsh.profile.bundles` 数组里追加（保留原有条目）：

```json
"@local/dsh-memory-core", "@local/dsh-memory-decisions",
"@local/dsh-memory-lessons", "@local/dsh-memory-events"
```

**3. 在 profile 的 `cordis.patch.yml` 末尾追加**（文件非空时先加一行 `---` 分隔）：

```yaml
- id: dsh-memory-core
  name: "@local/dsh-memory-core"
  config:
    dbPath: E:/my-memory/evidence.sqlite      # 记忆索引（自动创建）
    roots: [E:/my-memory/knowledge]           # 你的知识目录
    vector: { enabled: true }
- id: dsh-memory-decisions
  name: "@local/dsh-memory-decisions"
  config:
    dbPath: E:/my-memory/evidence.sqlite      # 与 core 共用
    perTurnMax: 1
    dailyMax: 10
- id: dsh-memory-lessons
  name: "@local/dsh-memory-lessons"
  config:
    dbPath: E:/my-memory/lessons.sqlite
    lessonsRoot: E:/my-memory/knowledge/lessons   # 必须在 core 的 roots 内
    evidenceDbPath: E:/my-memory/evidence.sqlite
    evidenceRoot: E:/my-memory/knowledge
- id: dsh-memory-events
  name: "@local/dsh-memory-events"
  config:
    dbPath: E:/my-memory/events.sqlite
```

</details>

### 放入你的知识文件

知识目录（默认 `~/.dsh/memory/knowledge`）里放 markdown 文件，目录名决定类型：

```
knowledge/
├─ decisions/ADR-001-数据库驱动选型.md   # 决策记录
├─ lessons/lesson-发布前要跑真实e2e.md   # 教训（也可以让 agent 提名生成）
└─ notes/任意笔记.md
```

决策文件的写法（frontmatter 里的 `status: accepted` 表示已采纳，才会被主动提醒）：

```markdown
---
title: 数据库驱动选型
status: accepted
kind: decision
summary: 使用 node:sqlite，无需原生依赖
keywords: sqlite, 驱动
---

# ADR-001: 数据库驱动选型
（决策正文与理由）
```

### 重启，开聊

重启 DSH 后新开会话，agent 即拥有下表的工具。试试：

> 我们之前数据库驱动是怎么选的？

agent 会检索到 ADR-001 并给出经验证的原文。

## 工具速查

**记忆检索（core）**

| 工具 | 用途 |
|---|---|
| `memory_search` | 全文+语义检索所有记忆；返回标题、摘要、锚点与版本号 |
| `memory_drill` | 按锚点+版本号读取某条记忆的完整原文（会校验源文件未被动过，动过则拒绝返回旧内容） |
| `memory_stats` | 记忆库概况：条数、类型分布、向量覆盖 |

**决策提醒（decisions）**——无直接工具；已采纳的决策在对话开始时自动浮现一次，预算可控。

**教训沉淀（lessons）**

| 工具 | 用途 |
|---|---|
| `lesson_nominate` | agent 提名一条教训（自动脱敏 API key/邮箱/IP 等） |
| `lesson_approve` | 你明确批准后由 agent 调用，教训写入知识目录并立即可检索 |
| `lesson_reject` | 拒绝提名 |
| `lesson_pending` | 查看待决提名 |

**时间线（events）**

| 工具 | 用途 |
|---|---|
| `event_mark` | 记录承诺/里程碑/事故等事件；同一事件重复记录自动去重 |
| `event_search` | 按关键词和时间窗查询历史事件，越新越靠前 |
| `event_forget` | 彻底删除某事件，该事件永远无法再被记录 |
| `event_stats` | 事件统计与到期未完成的承诺 |

## 常见问题

**数据存在哪？** 全部在配置的三个 SQLite 文件与你的知识目录 markdown 里。知识文件是唯一依据，索引删了可随时重建（`node packages/core/scripts/reindex.mjs --db <路径> --rebuild`）。

**记忆会撑爆上下文吗？** 检索只返回摘要行；读原文默认截断 8000 字符；决策提醒每轮最多 1 条、每天最多 10 条。

**怎么卸载？** 从 bundles 里删掉四个插件名、删除对应 junction、重启即可；数据文件留着不影响任何东西。

**中文检索效果如何？** 三字及以上中文直接命中；一两个字的表达走兜底路径；措辞完全不同的同义问题靠语义路命中。

## 测试与验证

每个包内置测试：`node --test test/`（各包目录内执行）。端到端验收用例见 [packages/core/E2E-TEST-CASES.md](packages/core/E2E-TEST-CASES.md)。

## 许可

MIT
