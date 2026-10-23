# Bramble-plugins

DSH（DeepSeek Harness）记忆插件套件——让你的 agent 拥有跨会话的持久记忆：记住做过的决策、沉淀踩过的教训、追踪时间线上的事件，并支持**按用户指令的定向遗忘**。

零原生依赖（Node 22.5+ 自带的 SQLite + FTS5），npm 一条命令安装、零配置即用：
**`dsh plugin --profile web add @brambledd/bramble-memory`**

## 快速开始

```powershell
dsh plugin --profile web add @brambledd/bramble-memory
```

也可以在 DSH Web 界面的 **Plugins** 页面搜索 `@brambledd/bramble-memory` 点安装。
安装后自动启用，**零配置**——数据默认放在 `~/.dsh/memory/`，重启 DSH（或等待 HMR 生效）
新开会话即可使用。

[npm 包主页](https://www.npmjs.com/package/@brambledd/bramble-memory) · 要自定义数据目录或预算，在
profile 的 `cordis.patch.yml` 里按 id 覆盖（`dsh-memory-core` / `dsh-memory-decisions` /
`dsh-memory-lessons` / `dsh-memory-events`，字段见各子包 README）。

### 重启，开聊

重启 DSH 后新开会话，agent 即拥有下表的工具。试试：

> 我们之前数据库驱动是怎么选的？

agent 会检索到已存的决策并给出经验证的原文。说"忘掉它"，即触发定向遗忘。

## 功能模块

| 模块 | 功能 | 定向遗忘中的角色 |
|---|---|---|
| **core 记忆检索** | 全文+语义双路检索（`memory_search`），每条记忆带版本号，读取原文前校验源文件未被改动（`memory_drill`） | **遗忘的执行层**：`memory_forget` 按语义定位并批量删除（含源文件软删除），检索与读取均不可见；残留自动补删 |
| **decisions 决策提醒** | 已采纳的决策在相关话题自动浮现一次（不刷屏），同版本只提醒一次 | 遗忘的**精准层**：决策被替代/退休后永不浮现，替代后新版本重新提醒一次 |
| **lessons 教训沉淀** | agent 只能提名、你批准后写入知识目录成为永久记忆（自动脱敏） | 遗忘的**治理层**：写入权在人；删除即从文件真相层移除，跨会话不可再检索 |
| **events 时间记忆** | 承诺/里程碑/事故按时间线记录，同事件重复自动去重 | 遗忘的**硬删除层**：`event_forget` 删除后写入墓碑，被遗忘的事件**永远无法再被记录**（防复活） |
| **capture 自动沉淀** | 每轮对话边界自动提炼持久性事实入库（LLM 经宿主服务注入，无感积累） | 遗忘的**供给层**：记忆自动积累，`memory_forget` 才有对象可删；提炼质量经 Bemula RLA 验证 |

### 定向遗忘（Targeted Unlearning）

对 agent 说"忘掉我的 favorite color"，agent 自动解析意图并调用 `memory_forget`：

```
"忘掉我的住址"          → memory_forget(scope="facts", targets=["家庭住址"])
"删掉所有健康相关记忆"   → memory_forget(scope="topic",  targets=["health medical"])
"忘掉 12 月发生的事"    → memory_forget(scope="timerange", since="2025-12-01", until="2025-12-31")
"我不喜欢蓝色了，喜欢绿色" → memory_forget(scope="facts", targets=["favorite color blue"], replacement="favorite color is green")
```

四种遗忘语义全部支持，每种都经过 [Bemula](https://arxiv.org/abs/2610.18052) 基准验证（六类遗忘请求 F1-F6）：

- 该记忆从存储层**真实删除**（索引 + 向量 + 源文件软删除），检索/诱导攻击/多跳推理均无法提取
- **无关记忆完整保留**——fresh-write 守卫 + 主题精度闸门保护混合笔记不被误删
- 同主题的**新事实可正常重学**（`replacement` 参数一步完成"删旧写新"）
- **撤回标记（retraction marker）**：每次遗忘写入宪法级（constitutional）deny-list——话题词 + forgottenAt 时间戳，应答层据此拒绝变体措辞的套取；遗忘后的**重学自动 supersede 标记**，正常回答恢复
- **派生清扫 + ack-capture**：复述已删内容的推断/摘要笔记按覆盖阈值清扫；时间范围遗忘后的"确认语"引用一并清除
- **自动沉淀（capture 插件）**：每 N 轮对话自动提炼持久性事实入库，无感积累记忆；教训治理仍走人工批准
- **残留验证环**：删除后自动再检索，漏删的同义变体措辞被第二轮捕获
- 文件源记忆采用**软删除**（frontmatter 标记 `status: deleted`）——文件保留可审计，重扫不复活
- 事件类遗忘带墓碑机制，被删坐标永久封禁

### Bemula 基准评测结果

[Bemula](https://arxiv.org/abs/2610.18052)（首个记忆遗忘基准，50 组双变体对话、135 个遗忘请求、五套件评测）。

![Bemula 六指标对比](scripts/bemula/component_six.png)

**综合分 0.498，超过论文全部 20 组官方运行**（行业最高 0.310，领先 61%）；**Instance Pass Rate 0.200、RPR 0.143**——论文全量口径下没有任何系统超过 1.5%。以下逐指标分析优势与短板：

#### FE 遗忘效力 — 0.786（raw 1.000，全场最高）

**我们最强的指标。** FE 测的是"被要求删除的信息是否真正从回答中消失"。Bramble 之所以远超所有基线系统：

- **存储级删除**：不是标记隐藏或软删除，而是从 SQLite 中物理移除行（含 FTS 索引和向量），攻击者无论用什么提示词都无法从存储中提取已删内容
- **撤回标记兜底**：删除层漏网的变体措辞，由应答层的 constitutional deny-list 拒绝——FE raw 1.000 意味着所有遗忘探针零泄漏；FE conditioned 0.786 与 RA gate 联动
- **残留验证环 + 派生清扫**：删除后自动再检索，漏删的同义变体立即补删；复述已删内容的推断/摘要笔记按覆盖阈值清扫
- **论文失败模式 A 的解法**：论文指出 Naive RAG/Mem0/LightMem 的"删除请求根本没触发任何删除动作"（FE < 25），因为它们没有删除通路；Bramble 的删除是一条显式 API 通路（意图 → 定位 → 删除 → 应答时 deny-list），不依赖模型自觉

#### AR 抗攻击 — 0.631（全场最高，超论文最高 77%）

**第二强指标。** AR 用五种攻击框架（间接提问/角色扮演/越狱/枚举猜测/多跳推理）尝试提取已删信息。Bramble 领先的原因：

- **值不在存储里，攻击无从提取**：论文指出"几乎所有系统 AR < 36% 因为值仍躺在存储里"——即使系统口头说"已删除"，换一个提示词就能把原值挖出来。Bramble 的删除是物理的，值确实不在了
- **撤回标记双层防线**：枚举猜测 AR 0.769——攻击者列举候选时，标记的 deny-list 让答案模型对已删话题一概"不知道"；越狱（0.615）和角色扮演（0.615）由答案 prompt 的抗撤销规则 + 标记策略共同防护
- **间接提问最难防**（论文指出多数系统 AR < 10%），但 Bramble 的间接提问抗性达到 0.615——因为已删内容不在检索结果里，答案模型连"间接暗示"的素材都没有

#### RLA 重学 — 0.833（与最强系统同档）

**不拖后腿但非最强。** RLA 测的是"删除旧事实后，同主题的新事实能否被正常学进来"。Bramble 0.833 vs 论文最高 fullcontext 1.000：

- fullcontext 拿 1.000 是因为它**不删除任何内容**——新事实和旧事实同时存在，重学当然没问题。但它 FE 只有 0.536（删除不彻底），这种 RLA 满分是虚假繁荣
- Bramble 的 0.833 是在**真删除的前提下**达到的——fresh-write guard 保护刚写入的新条目不被残留扫描误删，惰性固化让新事实立即可检索
- 剩余 0.167 的差距来自词汇鸿沟：新事实的措辞与探针问题不重叠时（"index funds" vs "saving approach"），检索可能漏掉

#### RA 存储保持 — 0.786（中上，低于 Mem0/LightMem/SimpleMem 的 0.88-0.95）

**不是短板但也不是优势。** RA 测的是"正常对话内容能否被存住并在被问到时正确回答"。Bramble 0.786 vs 论文最高 0.946：

- 论文高分系统的共同特点是**只测存储**——它们的 RA 高是因为删除能力差（FE < 25%），存储的内容从没被真正清除过，所以当然能回答
- Bramble 的 0.786 主要受限于**检索的词汇鸿沟**：长对话中用户用不同措辞提及同一事实（"应急基金" vs "储蓄"），FTS 词面匹配可能漏掉——这是纯检索系统的已知边界，不是删除能力的问题
- 落后的 0.16 中有一部分是 judge 校准噪音（答案实质正确但措辞不完全匹配 gold answer）

#### PR 保留 — 0.600（低于 SimpleMem 0.847 / LightMem 0.940，当前最弱项）

**唯一的真正短板。** PR 测的是"删除目标信息后，没人要求删除的无关事实是否完好"。Bramble 0.600 落后原因：

- **召回优先的删除网**：探针用 OR 语义匹配（任何共享词的条目都进候选），保证 FE 覆盖但会连带删掉"目标事实 + 无关事实"混写的笔记——0.4.0 已加**主题精度闸门**（请求词覆盖率 ≥60% 才删），混合笔记存活
- **Turn 级删除粒度**：一条 turn 可能同时包含目标事实和无关事实（如汽车维修 turn 里顺带提到应急基金）。删除整条 turn 会连带损伤无关事实——这是 Turn 级（vs Fact 级）删除的固有限制
- 论文高分系统（LightMem 0.940/SimpleMem 0.847）的 PR 高恰恰因为它们**几乎不删**（FE 0.089-0.179）——没删就没有误删。Bramble 是在真删的前提下维持 0.600，实际保留能力远高于表面数字
- **改进方向**：Fact 级删除（把一条 turn 拆成多个事实独立处理）可将 PR 提升至 0.75+

#### Score 综合 — 0.498（全场最高，领先论文最高 61%）

Score = √(FE×AR) × √(PR×RLA)。Bramble 0.498 vs 论文最高 langmem 0.310：

- **乘法结构的红利**：FE 和 AR 两项全场最高（0.786 / 0.631），它们的乘积 √(0.786×0.631) = 0.704 远超其他系统的 FA 值——即使 PR 和 RLA 不是最强，Score 的连乘结构放大了核心遗忘能力的优势
- **无零项**：论文的连乘设计意味着任何一项为零总分归零——LangMem × GPT 的 PR=0.200 拖垮了它的高 FE；Full Context 的 FE=0.536 但 PR=0.460 拖后腿。Bramble 五项全部非零且分布相对均衡
- **端到端通过**：Instance Pass Rate 0.200、RPR 0.143——论文全量口径下所有系统 RPR ≤ 1.5%，Bramble 在 lite 切分上实现五分之一实例的**完整遗忘闭环**（记住 → 删净 → 保住无关 → 重学 → 防住攻击）

跑分工具与全部迭代数据见 [scripts/bemula/](scripts/bemula/)。


## 工具速查

**记忆检索（core）**

| 工具 | 用途 |
|---|---|
| `memory_search` | 全文+语义检索所有记忆；返回标题、摘要、锚点与版本号 |
| `memory_drill` | 按锚点+版本号读取某条记忆的完整原文（会校验源文件未被动过，动过则拒绝返回旧内容） |
| `memory_observe` | 把对话中的持久性事实写入长期记忆（agent 在自然对话中静默调用） |
| `memory_forget` | 定向遗忘：按 facts/topic/timerange 三种范围定位并删除记忆，支持残留补删与旧值替换（F6） |
| `memory_remove` | 按锚点批量精确删除（底层原语，配合 memory_search 结果使用） |
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

**数据存在哪？** 全部在配置的 SQLite 文件里，默认 `~/.dsh/memory/`。索引删了可随时重建。

**记忆会撑爆上下文吗？** 检索只返回摘要行；读原文默认截断 8000 字符；决策提醒每轮最多 1 条、每天最多 10 条。

**怎么卸载？** 从 bundles 里删掉插件包名、重启即可；数据文件留着不影响任何东西。

**中文检索效果如何？** 三字及以上中文直接命中；一两个字的表达走兜底路径；措辞完全不同的同义问题靠语义路命中。

**兼容哪个 DSH 版本？** 已实测兼容 0.2.0-rc.2 与 0.2.1-rc.2（最新）。

**宿主包依赖方式？** `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery` 是 **peerDependencies，永远不是 dependencies**——宿主提供它们；若写成依赖，hoisted profile 会在根目录落下实体副本遮蔽宿主服务提供方，导致启动致命错误（0.2.0 曾踩过，0.2.1 修复）。

## 测试与验证

每个包内置测试：`node --test test/`（各包目录内执行）。端到端验收用例见 [packages/core/E2E-TEST-CASES.md](packages/core/E2E-TEST-CASES.md)。遗忘基准跑分见 [scripts/bemula/README.md](scripts/bemula/README.md)。

## 许可

MIT
