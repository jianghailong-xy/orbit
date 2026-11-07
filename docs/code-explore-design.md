# code_explore：给所有引擎的快速代码定位（2026-11-07 草案）

> 状态：草案，待 owner 审。架构图见 `docs/mocks/code-explore/board.html`，以及同目录下的 PNG。
>
> 已定（owner，2026-11-06 / 11-07）：
>
> - 模型调用走服务端那把 DeepSeek key（`DEEPSEEK_API_KEY`），费用由部署方承担；
> - 审计记录分三级。第 2 级（完整内容）保留 30 天，Settings 里加一个开关，默认关闭。

## 0. 一页结论

1. **做什么**：在 `orbit mcp` 里新增一个只读工具 `code_explore(question)`。
   - 调用它时，便宜模型在会话自己的检出目录里并行搜索，只把 `path:行区间` 加一句理由交回主会话；
   - Claude、Codex、Kimi、DSH、Cursor、Antigravity、OpenCode 七种引擎同名同用。
2. **为什么**：主会话在第一次编辑前花在探索上的成本很重（§1），而现有的子代理探索既慢又贵，并且只有部分引擎有。
3. **怎么做**：
   - 循环和只读工具都在 runner 上跑，因为仓库在 runner 上；
   - 每一轮的模型调用经 apiserver 转发给 DeepSeek，key 只在服务端；
   - 服务端按三级记录审计，并根据会话后续的行为自动给每次调用打"命中/漏召回"标签，用来持续优化。
4. **先量后建**：M0 先做离线评测，过了门槛再做产品化（§8）。
5. **不做**：
   - 不给每个会话起常驻的语言服务器；
   - 不默认把代码交给云端索引；
   - 不打包许可证不合适的第三方项目。

## 1. 为什么（实测，一台 runner 主机，2026-11-06，最近 30 天）

**第一次编辑前的探索成本**（885 个有编辑的主会话）：

| 指标 | p50 | p90 |
| --- | ---: | ---: |
| 从第一条消息到第一次编辑 | 742 秒 | 1,671 秒 |
| 这段时间的工具输出 | 37 万字符 | 78 万字符 |

- 这部分输出里，读"最终没改的文件"占 47.8%，搜索占 13.1%，合计约 61%，这是 `code_explore` 能接手的上限。
- 这些内容会留在上下文里：第一次编辑之后中位数还有 107 次模型调用，每次都要重读一遍（走缓存）。

**现有的子代理探索**：Claude 的 Explore 共 136 次，其中 110 次跑在主模型 Opus 5.5 上。

| 指标 | p50 |
| --- | ---: |
| 耗时 | 618 秒 |
| 工具调用 | 101 次 |
| 按 API 价格估的成本 | 约 $4.4 |

- 主会话随后只重读了它所引用路径的 5%，说明主会话会信任探索的结论。
- 其他引擎没有 Orbit 层面的同类能力。

**外部证据**：
- ContextBench 的结论是，复杂的检索脚手架只带来边际收益；
- Cursor 报告语义检索加 grep，在 1,000 个文件以上的仓库收益最大。

所以本设计不替代 grep，而是给它加一个便宜又快的"先定位"步骤，并且用 Orbit 自己的数据来验证收益。

## 2. 组件

| 位置 | 组件 | 新增或复用 |
| --- | --- | --- |
| 各引擎 | 调用 `mcp__orbit__code_explore` | 复用 `orbit mcp` 的注入（七种引擎都已注入） |
| runner：`orbit mcp` | 工具描述（`readOnlyHint`）、参数校验；经后台 socket 交给守护进程 | 新增工具，复用 `ORBIT_BG_SOCKET` |
| runner：守护进程 | 探索循环：每轮向 apiserver 要动作，在 worktree 里并发执行，校验结果，控制预算 | 新增 |
| runner：工具 | `grep`（Orbit 管理的 rg）、`files`、`read`；P1 落地后加 `outline` | 新增；依赖"Orbit 自带 rg" |
| apiserver | `POST /runner/sessions/:id/explore/turns`：会话凭证鉴权、开关和配额检查、调用 DeepSeek、写审计 | 新增；DeepSeek 调用沿用 `deepSeekCall` 的方式 |
| apiserver | `code_explore_call`（第 0、1 级）、`code_explore_turn`（第 2 级）表；30 天清理；打标签作业 | 新增 |
| web / iOS / Android | Settings 里的 "Code explore" 卡片，两个开关 | 新增；Web 先出设计稿 |
| 各引擎的提示 | 何时调用 `code_explore` 的一句指引 | 修改注入的 instructions |

**模型**：
- 服务端的 `DEEPSEEK_API_KEY`；
- 新增环境变量 `DEEPSEEK_EXPLORE_MODEL`，缺省时沿用 `DEEPSEEK_MODEL`；
- 具体用哪个 DeepSeek 模型由 M0 决定。

## 3. 一次调用

1. 主会话调用 `code_explore({question, paths?})`。
2. `orbit mcp` 把请求交给 runner 守护进程，同时带上本会话的工具超时：Claude 实际不限，Codex 300 秒，DSH 60 秒，OpenCode 30 秒（Orbit 自己设的，可调）。
3. 守护进程定下墙钟预算，默认 25 秒，不超过引擎超时的一半。然后进入第一轮：
   - 带着问题、仓库的顶层目录和已经看过的结果，`POST` 给 apiserver；
   - apiserver 检查开关和配额后调用 DeepSeek，使用 JSON mode；
   - DeepSeek 返回动作清单（最多 8 个），或者给出最终结果。
4. runner 在 worktree 里并发执行这些动作，输出有上限：grep 最多 200 行，read 每个动作最多 200 行，一轮合计最多 2.4 万字符。
5. 重复第 3–4 步，最多 4 轮，直到模型给出 `done` 或预算用完。
6. **结果校验**（确定性的，不依赖模型）：
   - 每条位置必须和探索过程中真实返回过的 grep 命中或 read 区间重叠；
   - 文件和行号在当前 worktree 里确实存在；
   - 不满足就丢弃，然后去重，最多保留 12 条。
7. 返回 `{locations: [{path, startLine, endLine, why}], coverage: "complete" | "partial", usage}`，总长不超过 1.5k token。
8. apiserver 已经写好第 0 级和第 1 级记录；第 2 级只在账户打开开关时才写。之后打标签作业会读这个会话后续的事件，补上标签。

**失败的情况**：DeepSeek 报错或超时、配额用完、开关关闭，都返回明确的说明（例如 "code explore unavailable; search with rg"），不让 agent 反复重试。

## 4. 数据与审计

| 级别 | 内容 | 默认 | 保留 |
| --- | --- | --- | --- |
| 0 元数据 | 账户、工作区、会话、任务、commit、worktree 是否有未提交改动、引擎、模型、轮数、每轮延迟、token、估算花费、状态、位置条数、标签 | 始终记录 | 跟随会话，会话删除时一起删除 |
| 1 问答 | 问题文本，以及返回的位置（路径、行区间、理由，不含代码） | 始终记录 | 跟随会话 |
| 2 完整内容 | 每一轮的动作和工具输出（即代码）、模型原始回复 | Settings 开关，默认关 | 30 天，由清理作业删除；会话删除时一起删除 |

- **第 1 级不新增暴露面**：问题和返回的位置本来就在会话转录里（`RunEvent` 里的 tool call 和 tool result）。
- **第 2 级**：入库前过 `common/secret-redaction.ts`；runner 侧的工具也拒绝读取 `.env*`、私钥一类文件，并默认遵守 `.gitignore`。
- **自动标签**：
  - 命中：返回的区间被主会话在后续 60 次工具调用内读过或改过；
  - 漏召回：会话最终改了、但不在返回结果里的文件；
  - 这两项算出命中率和召回率，用来做看板、离线回放，以及挑选评测样本。

## 5. 设置（界面文案用英文）

在 Settings 里新增一张卡片 **Code explore**，两个开关：

- **Let agents use code explore**：功能本身。默认值见 §9 的 Q1。
  - 说明文字："Agents in every engine can ask a fast model where the code they need lives. It searches the session's checkout on the runner and returns file and line pointers. The question and the code it reads go to DeepSeek through this Orbit server."
- **Keep full explore records**：第 2 级记录。默认关。
  - 说明文字："Keep every step of each explore call, including the code it read, for 30 days so Orbit can improve the search. Off: only what the conversation already shows, plus counts and timings."

两个开关都是账户级偏好（`PATCH /users/me/preferences`），和现有的 Session recaps 等开关同一套机制；iOS 和 Android 的设置页同步加上。

## 6. 安全与信任边界

- 代码会经 Orbit 服务端发给 DeepSeek。要同步更新 `docs/architecture.md` 的 Trust boundaries 和 `SECURITY.md`。
- DeepSeek 的数据政策：第三方资料说数据在中国境内存储，API 输入是否会被用于训练说法不一，也没有零保留（ZDR）选项。给其他账户开放之前，要先读原始条款（§9 Q1）。
- 防代码里的提示注入：
  - 工具全部只读，范围限定在会话的 worktree 内；
  - 返回的位置都经过 Orbit 校验；
  - 理由文字限长，并清理控制字符。
- 一把 key 服务所有账户：
  - 全局并发上限 `ORBIT_EXPLORE_CONCURRENCY`；
  - 每个账户、每个会话都有调用上限；
  - DeepSeek 不可用时直接降级为"请用 rg"；
  - 限流不会影响会话本身用的 provider。

## 7. 评测与上线

**M0 离线评测**：
- 用历史任务会话构造评测集：任务描述作输入，最终编辑的文件作标准答案。一台主机 30 天有 706 个这样的会话，中位数改 9 个文件。
- 在任务的基线 commit 上建只读检出。
- 比较三类：
  - 只用关键词的 rg/BM25 基线（不调用模型）；
  - DeepSeek 的两个候选模型；
  - 主会话当时自己的轨迹。
- 门槛：recall@10 ≥ 0.7，p50 延迟 ≤ 20 秒，单次成本 ≤ $0.01，并且明显好于 rg 基线。

**M3 在线 A/B**：
- 按任务 id 的奇偶分组；
- 看第一次编辑前的读/搜次数和字符数、总成本、任务结果、证据通过率、返工率，以及采用率；
- 观察 2 周。

## 8. 落地（按代价排）

| 阶段 | 内容 | 粗估 |
| --- | --- | --- |
| 前置 | Orbit 自带 rg：给每个引擎的 PATH 末尾配上 rg，不覆盖系统已有的。待 owner 确认 | 2–3 天 |
| M0 | 离线评测，过门槛才往下做 | 3–4 天 |
| M1 | runner：工具、探索循环、结果校验、预算、单元测试，以及真实 CLI 加假模型的测试 | 1–1.5 周 |
| M2 | apiserver：转发接口、配额、两张审计表、清理作业、打标签作业；Settings（先出设计稿）；更新信任边界文档 | 约 1.5 周 |
| M3 | 各引擎提示里的使用指引，加上在线 A/B | 2–3 天，再观察 2 周 |

## 9. 待定 · 要 owner 拍板

- **Q1 功能本身的默认值**
  - A：所有账户默认开。
  - B：默认关，各账户在 Settings 里自己打开；部署方自己的账户在上线时打开。
  - **推荐 B**：代码会发给 DeepSeek，需要用户知情同意；对其他账户开放前还要先核实 DeepSeek 条款。
- **Q2 M0 评测从哪里拿 key**
  - A：在 HPC 上放一个评测专用的 key 文件，评测直接调用 DeepSeek，评测完就删除。
  - B：先把转发接口做出来，评测走服务端那把 key。
  - **推荐 A**：评测和产品代码解耦，门槛不过就不用做服务端；真实链路的延迟到 M1 再测。
- **Q3 每条结果要不要带一句理由**
  - A：`path:行区间` 加一句不超过 15 个词的理由。
  - B：只给 `path:行区间`。
  - **推荐 A**：每条大约多 20 token，主会话可以据此决定先读哪段。

## 10. 不在范围内

- 向量语义检索：仍是 P3，前提是 M0 的评测框架已经就绪。
- trigram 索引：rg 在 Orbit 规模的仓库上约 0.05 秒，不是瓶颈。
- 按会话常驻的语言服务器：内存放不下，见调研报告。
- 替代 Claude 的 Explore 子代理：两者是不同的档位，可以共存。
