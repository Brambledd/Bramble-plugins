# @brambledd/bramble-memory

DeepSeek Harness（DSH）记忆插件套件——单个 npm 包包含五个插件，安装即用、零配置：

- **dsh-memory-core**：跨会话记忆检索（`memory_search` / `memory_drill` / `memory_stats`），全文+语义双路，读原文前校验源文件未被改动
- **dsh-memory-capture**：对话边界自动记忆抽取——LLM 提炼持久事实，去重/整合/脱敏后入库
- **dsh-memory-decisions**：已采纳决策在相关话题自动提醒一次（不刷屏）；用户偏好按日轮换提醒
- **dsh-memory-lessons**：教训沉淀——agent 提名、你批准、写入知识目录，立即可检索
- **dsh-memory-events**：时间线记忆（承诺/里程碑/事故），重复自动去重，遗忘永不复活

## 安装

```powershell
dsh plugin --profile web add @brambledd/bramble-memory
```

或在 DSH Web 界面的 **Plugins** 页面中搜索安装。安装后自动启用，重启（或 HMR 生效）即可。

零配置：数据默认放在 `~/.dsh/memory/`（索引、事件、教训队列）与 `~/.dsh/memory/knowledge/`（你的知识 markdown）。要换位置或调预算，在你的 profile `cordis.patch.yml` 里按 id 覆盖（`dsh-memory-core` / `dsh-memory-capture` / `dsh-memory-decisions` / `dsh-memory-lessons` / `dsh-memory-events`）。

### 0.5.0 行为变更提示

- **向量语义检索默认关闭**（`dsh-memory-core` 配置 `vector.enabled: true` 可重新开启）：基准评测显示默认的离线嵌入在长文本上会拖累检索精度；纯 BM25+探针降级为实测最优配置。真嵌入后端用户仍可开启。
- 记忆写入管线升级：重复陈述不再落库（NOOP），改写性陈述自动取代旧条目（UPDATE）——同一事实只保留最新版本。
- 决策提醒插件新增**偏好提醒**（每日轮换、配额控制，`prefPerTurnMax` / `prefDailyQuota` 可调）。

## 知识文件格式与更多文档

见主仓库：https://github.com/Brambledd/Bramble-plugins

MIT
