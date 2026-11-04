# Wiki 读 memory：写入是线索，不是证据（2026-11-04 方案草案）

> owner 11-04 问：`wiki_note` 能不能和 Claude、Codex 的 memory 机制关联，记一条 memory 时，wiki 根据它从 session 和代码里 ingest，而不是只记录？历史 memory 会不会导入？
>
> owner 11-04 定：§10 全部按推荐，不确定的按数据测量（§6）。本文是方案，还没有任何实现。文中的数都是 2026-11-04 在 orbitd.io 上的只读聚合，只取计数，查询见 §11。

---

## 0. 一页结论

1. **关联，但 memory 只当线索。** 一次 memory 写入里有三样东西：agent 判断这条重要（信号）、一句话（声明）、写在哪个 session 的哪一刻（指针）。信号和指针直接用；声明只当待查的问题，永远不当证据。
2. **不建新流水线。** 写入本来就是 session 事件流里的工具调用，维护作业也已经读过 97% 写过 memory 的 session。只改三处：案卷留下声明，抽取改问法，核对按证据定信任。
3. **agent 的行为不变。** 不加钩子，不发 runner，不加指令。Claude 照常写 memory，服务端自己看得到。
4. **信任要看第一手证据。** 现在 67% 的生效条目只有 agent 自己的话或 memory 作出处，其中大多数是 `auto`（§1.3）。以后 `auto` 必须有工具结果或 owner 的原话，其余最多 Unreviewed。否则“从 session 找证据”只会找到 agent 把同一句话又说了一遍。
5. **只有 Claude 自动关联。** Codex 的 memory 是空闲后后台生成的摘要，默认关闭，里面没有“工作中的 agent 判断这条重要”这个信号。其余引擎用 `wiki_note`。
6. **`wiki_note` 变小。** Claude 平时不用调。它只用于没有 memory 的引擎、纠错和 owner 明说“记到 wiki”，走同一条路。
7. **历史 memory 会导入，但不再照抄。** 10 月以来从未导入的写入（1,006 个 session）和 9 月已导入的 note（958 个能找回 session）都回到原 session 核对，从新到旧分批跑。找不回 session 的最多 Unreviewed（§5）。
8. **代码先当锚点。** 声明里的路径和 session 改过的文件作为锚点候选。读代码判断真伪放在核对这一步，而且先在回放里量值不值（§3.5）。
9. **不确定的按数据定。** 先按证据类别抽查条目的对错，再回放对比，都不写 wiki 表（§6）。重点看证据规则站不站得住，以及模型会不会顺着声明说。

---

## 1. 现状

### 1.1 两条路各缺一半

| | memory | session | 代码 |
| --- | --- | --- | --- |
| 导入作业（`orbit wiki import`） | 把正文当出处 | 不读 | 只查路径和提交是否存在 |
| 维护作业 | 故意剔除（`src/apiserver/src/wiki/wiki-dossier.ts:527`） | 读，每个 session 压成 8k 案卷 | 只查路径和提交是否存在 |

- **导入只跑过一次。** 1,159 个 note 里 1,157 个来自 9-28 那周，2 个来自下一周，此后没有新增。
- **导入的条目是循环验证。** 核对器只看被引记录（`src/apiserver/src/wiki-worker/wiki-verify.ts:33`），条目又是从这份 note 抽出来的，所以 supported 只说明抄得对。证据可读时，导入来源只有 1.8% 被判 unsupported（208 / 11,478）。
- **维护作业丢掉了最强的线索。** 剔除 memory 有两个原因：演示任务 `34VS7P8eDpXiMzpLZ8PY4` 拿 memory 当评分标准；代码注释另说二手内容不能回流成出处。后一条本方案保留，前一条靠留出集保留（§6）。
- **代价可以量。** 只读 session 的召回率约 52%（留出集 61.4%，按人工复核折算）。调参时的 48 条漏检里，21 条被挤出案卷，27 条在案卷里但没抽到。现在 97% 的案卷（3,007 / 3,107）都被截断。

### 1.2 写入量

| 指标 | 数 |
| --- | --- |
| 近 30 天的 Claude session | 1,674 |
| 写过 memory 文件的 session | 865（52%） |
| 写入次数（不含索引） | 1,824（整文件 1,026，编辑 798），约每天 60 次 |
| 正文长度中位数 | 1,334 字符 |
| 整文件写入的类型 | project 448、reference 414、feedback 92、user 2 |
| 之后有合并回执的写入 | 61%（不分成败，中位 0.5 小时） |
| 全程没有回执的写入 | 32% |
| 提到仓库路径的写入 | 39% |
| session 读过网页之后的写入 | 4.6% |

同期 agent 读 memory 文件 821 次（7 天），读 wiki 77 次（14 天，11-02 量）。

### 1.3 条目站在什么证据上

orbit space 全部生效条目，按最强的一个出处分类：

| 最强出处 | 生效条目 | 其中 `auto` | 占全部 `auto` |
| --- | --- | --- | --- |
| 观察到的：工具调用和结果、提交、合并回执 | 1,480 | 823 | 6% |
| 人说的：turn、审批 | 3,802 | 2,906 | 22% |
| 只有 agent 的话：回复、thinking | 7,131 | 4,473 | 34% |
| 只有任务文本 | 560 | 476 | 4% |
| 只有 memory | 4,590 | 4,409 | 34% |
| 合计 | 17,563 | 13,087 | 100% |

前两行是上限：“观察到的”含写文件的工具调用，“人说的”含别的 session 发来的消息，按 §2 的规则都会更少。“只有 memory”的 `auto` 里有 262 条 decision。带 memory 出处的 4,646 条里，同时有原始记录的只有 56 条（1.2%）。

### 1.4 引擎

| 引擎 | memory 怎么来 | Orbit 看得到吗 | 近 30 天写入 |
| --- | --- | --- | --- |
| Claude Code 2.1.318 | 工作中的 agent 用 Write、Edit 写，按账号和仓库分目录 | 看得到，是事件流里的工具调用 | 1,824 |
| Codex 0.166.0 | chat 空闲后后台生成，默认关闭；用户明确要求时才能记一条（`add_ad_hoc_note`） | 看不到 | 0（59 个 session） |
| Kimi、DSH、Antigravity、OpenCode | 机制没有逐个查 | 路径匹配没发现写入 | 0（101 个 session） |

Codex 不接，理由有三条：它是后台模型对同一批对话的摘要，这些对话 Orbit 已经有了；开启要占用户额度；HPC 和 wikova 上都没开。它的内置指令也写着 “Memory is not proof of current behavior”，和本方案的规则一致。

---

## 2. 三条规则

**R1：声明不是证据。** memory 和 `wiki_note` 的正文只能提出问题。它们不进 `sources`，核对器也看不到。这保留了现有的规则：二手内容不能回流成出处。

**R2：第一手证据决定信任。** Automatic 下，`supported` 要变成 `auto`，出处必须满足：

| 条目类型 | `auto` 需要 |
| --- | --- |
| decision、convention | owner 的话：`ownerWords` 为真的 turn、审批、blocker 答复 |
| pitfall、recipe、concept | 观察到的结果，或 owner 的话 |

- 观察到的：非写文件类工具的调用和结果、`background_task`、`error`、提交、合并回执。
- 不算的：agent 的回复和 thinking、写文件类工具（那还是 agent 自己写的字）、wiki 读取结果、任务文本（owner 写的除外）、别的 session 发来的消息、note。
- 不满足时最多 Unreviewed。条目照样可搜可读，只是不再显得验证过。

**R3：一条流水线。** memory 写入、`wiki_note`、历史 note 最后都是案卷里的声明。没有第二套抽取、队列和表。

---

## 3. 设计

### 3.1 什么算一次写入

在构建案卷时识别（`timeline()`），现在这里遇到 memory 路径就返回 null。

- **工具：** `Write`、`Edit`、`MultiEdit`，没有报错。
- **路径：** `/projects/<slug>/memory/<file>.md`，不含 `MEMORY.md`。比现在的 `MEMORY_PATH` 严，后者也会匹配仓库里的 `memory/x.md`。
- **正文：** `Write` 取 `content` 并去掉 frontmatter；`Edit` 取 `new_string` 里 `old_string` 没有的部分。`loadDossierRecords` 现在不取这两个字段，要加，上限 4,000 字符。
- **跳过：** frontmatter 写 `type: user`；正文大部分是链接（hub、索引）；新增不足 20 字符。都计入 `report.claims.skipped`。
- **上限：** 每个案卷 6 条，每条 600 字符。`feedback` 优先，其次新的。超出计入 `overCap`。
- **继续剔除：** 读 memory 的调用、提到 memory 的句子、Bash 和脚本对 memory 的改动。

### 3.2 案卷

- **声明行：** 新说话人 `claim`，编号 `C1`、`C2`，放在写入时刻的时间线位置。`wikiMaintainLines` 只认 `L<n>`，`sourcesOf` 也要跳过这种行，所以模型引了 `C1` 也成不了出处。
- **必留：** 声明和 owner 的话一样必留。
- **证据窗：** 声明里的代码词（路径、标识符、反引号片段）在时间线里命中的工具行和 owner 行加分。窗口向前看，因为证据在写入之前。结果中间命中的那一行也放进这一行，现在只放结果的首尾行。前测里 93% 的写入有八成以上代码词在此前的工具记录或用户消息中出现过（§11）。
- **预算：** 总量仍是 8k，演示里 16k 反而更差（69.5% 对 64.2%）。声明和证据窗最多占 25%，从普通窗口里让。
- **确定性：** 同样的记录产生同样的文本。没有声明的案卷字节不变，现有 golden fixture 不用动。
- **留出：** `sha256(sessionId)` 落在 10% 的 session 不放声明（§6）。
- **排除 wiki 读取：** `wiki_search`、`wiki_get` 的结果不进案卷。现在 `SKIPPED_TOOLS` 没有它们（`src/apiserver/src/wiki/wiki-dossier.ts:178`），wiki 内容可以绕一圈回来当证据。

### 3.3 抽取

案卷里有声明时才追加这一段，其余提示不变：

```text
THE AGENT'S NOTES: C lines are notes the agent wrote to its own memory during this work. A note is what the
agent believed, not evidence. Take each as a question: does the rest of the case show it?
- shown: the case shows it. Write the entry from what the lines show.
- narrowed: the case shows part of it. Write only that part.
- contradicted: the case shows otherwise. Write no entry from the note; if what the case shows is worth keeping, write that.
- absent: the case neither shows nor refutes it. Write no entry.
- not_durable: progress, status, or one task's detail. Write no entry.
Never cite a C line. Cite tool and owner lines first: an agent or think line only says what the agent believed.
Add "note": "C1" to an entry that came from a note. Because this case has notes, output
{"entries": [...], "notes": [{"note": "C1", "outcome": "shown"}]}.
```

- **解析：** `parseWikiImportAnswer` 已经接受 `{entries}`。`notes` 另读，读不出算 `unanswered`，不为它重试。
- **条目上限：** `entriesPerSessionMax` 仍是 6。门槛 G3 不过再放宽。
- **追溯：** op 记 `promptedBy`（事件 id 和文件名）。它是服务端字段，agent 传了仍被拒，不算出处，只用于度量和追溯。
- **报告：** `report.claims = { seen, skipped, overCap, heldOut, shown, narrowed, contradicted, absent, notDurable, unanswered, entries }`。

### 3.4 核对

- **读的东西不变：** 条目加被引记录。声明不在其中，核对器不知道条目来自 memory。
- **证据多一档：** `verification_evidence` 增加 `second_hand`，表示有文本但不满足 R2。`supported` 落到 Unreviewed，并且计入回退统计，因为模型确实读了文本。`unreadable` 的行为不变。改动在 `wikiVerdictEffect`（`src/shared/src/wiki.ts:383`）和它的调用处。
- **污染：** 从记录抽的 op 按记录所在 session 判定污染，这是现成的。note 现在写死未污染（`src/apiserver/src/wiki/wiki.service.ts:4302`），要改成按 `originSessionId` 找到的 session 判定。

### 3.5 代码

| 层 | 做法 | 状态 |
| --- | --- | --- |
| 锚点候选 | 声明里的路径，加 session 在写入之前改过的文件 | 现有的快照校验和复验直接可用 |
| 判断真伪 | 核对时读锚点文件在 `origin/main` 的内容，只取命中条目代码词的行和上下文，最多 2k 字符 | 先在回放里量（G4） |

读代码不放进抽取：案卷变长会降低召回率。我试过量 memory 的路径过期率，没量成：1,024 个被引路径有 155 个不在 main 上，但抽查 60 个缺失路径，只有 11 个在 git 历史里出现过，其余多是缩写、临时脚本和构建产物。所以这一层的价值目前未知。

### 3.6 时机

写入时刻什么都不做。turn 结束产生 `session_settled` 事实（`src/apiserver/src/wiki/wiki-maintenance.ts:239`），到期规则不变：积压 20 个 session，或最老事实超过 24 小时。

- **证据更全：** agent 写完可能很快改掉这条。
- **代码才到位：** 61% 的写入之后还有合并回执，中位 0.5 小时。等一等，锚点才能对上 main。
- **没人在等：** 现在读 wiki 的 session 很少。以后读多了，可以让写过 memory 的 session 优先，这一期不做。

代价是新知识最多晚约一天。没开维护的 space 不处理。

### 3.7 一个例子

memory 里有一条：`release.sh next` 会直接打 tag。owner 当时只说了 “cut a beta version”。知识在 agent 的轨迹里：它读 skill 文档，以为 `next` 只解析版本号；跑完后工具结果第一行是 `tagging v0.1.2-beta.104 … pushed`；随后它在 thinking 里写下 “isn't a dry run”。

| | 导入作业 | 本方案 |
| --- | --- | --- |
| 读什么 | 这一句 | 这一句，加该 session 的案卷 |
| 出处 | note | 工具结果那一行 |
| 字段 | 只能从这句话里抽 | `trigger.commands`、`symptom`、`cause` 从工具结果和 thinking 填 |
| 锚点 | note 提到才有 | session 读过的 `.claude/skills/release/release.sh` |
| 信任 | 核对器读 note，判 supported，得 `auto` | 引了工具结果才是 `auto`；只引 agent 的话就是 Unreviewed |

---

## 4. `wiki_note`

| 项 | 内容 |
| --- | --- |
| 形态 | MCP 工具 `wiki_note`，CLI `orbit wiki note` |
| 参数 | `text`（必填，最多 2,000 字符）、`paths?`、`corrects?`（条目 id） |
| 路由 | `POST /api/runner/wiki/notes`，必须带 session；验证和判断 session 仍被拒 |
| 存储 | `wiki_note` 表加可空的 `session_id`，不挂外键。`paths` 追加到正文，脱敏和按内容去重沿用现有逻辑 |
| 进案卷 | `loadDossierRecords` 读本 session 的 note，和 memory 写入一样变成声明 |
| `corrects` | 立刻提交一个现有的 challenge，正文同时作为声明 |
| 限额 | 每个 session 15 条，探针文本拒收，不占 Review 名额 |
| 回答 | `{ noted, noteId, created, readBy: "the next maintenance run", challenged? }` |

存表而不是只靠工具调用记录，是因为 CLI 调用在事件流里只是一次 Bash。

工具说明（英文，会随工具进上下文）：

```text
Tell the wiki something this session learned that someone could not read from the code: a decision and why,
a trap and its fix, a rule the owner gave. One claim, in one or two sentences. Maintenance reads it later
against this session's records and writes an entry only if they bear it out, so it is not in the wiki yet and
may never be. Not for progress or status: use task_progress_report. If your engine keeps its own memory, what
you write there is read the same way: do not write both. To say an entry is wrong, pass corrects with its id:
the entry is flagged at once.
```

`wiki_propose` 这一期不删。上线后看 `wiki_note` 的使用数据再定。

---

## 5. 历史 memory

**会导入，但不再照抄。** 历史内容和新写入走同一条路：回到写它的 session 核对。

| 来源 | 量 | 处理 |
| --- | --- | --- |
| 10 月以来的写入，从未导入 | 2,116 次写入，1,006 个 session | 第一批回填。事件流里都有，不用读各台机器的文件 |
| 9 月已导入、能找回 session 的 note | 958 个 note，734 个 session | 第二批回填。note 正文作为该 session 的声明 |
| 6 到 9 月的其它写入 | 约 2,760 次写入中未进 note 的部分 | 不回填：文件已被后来的版本覆盖，最终版本在 note 里 |
| 找不回 session 的 note | 201 个 | 不回填，来自它们的条目收尾时降为 Unreviewed |
| 磁盘上有、事件流和 note 里都没有的文件 | 未知 | 手动 `orbit wiki import`，最多 Unreviewed |

**回填怎么跑**

- **入口：** 维护作业加一种输入：给定 session 列表，而不是游标页。抽取、自检、断路器、提议、核对都复用。跳过移动游标、写文档和排 articles（`src/apiserver/src/wiki/wiki-articles-jobs.ts:70`），全部结束后统一排一次 articles。
- **不倒回游标：** 倒回会让整个 space 进入追赶，文档停更，新 session 排在后面。页位还会被没有 memory 的 session 占掉。
- **节奏：** 每批 20 个 session，一次一个作业，和日常维护交替，从新到旧。
- **触发：** admin 路由，要求写明原因，先例是 `POST /api/admin/wiki/spaces/:id/plan/build`（`src/apiserver/src/wiki/wiki-admin.controller.ts:30`）。没有 UI。
- **旧条目：** 把引用这条 note 的条目加进 op 的 `similar[]`。核对判 duplicate 时，现有逻辑把新出处追加到旧条目上，内容和信任不变。
- **收尾：** 全部跑完后，仍没有第一手证据的旧 note 条目从 `auto` 降为 Unreviewed，走 `applyOp` 的一条内部指令。
- **成本：** 1,740 个 session，按演示实测每个 26 秒，GPU 独占约 13 小时，核对另算约 2 小时。现在 articles 占近 14 天模型请求的 81%，实际会更久。
- **止损：** 前 100 个 session 是试点，门槛 G1、G2 不过就停。

其它 space 不需要回填：新开维护从 `lookbackDays`（默认 14 天）读起，声明随案卷自动带上。

---

## 6. 测量与门槛

owner 11-04 定：不确定的事按数据决定。下面门槛的数值是我定的，结果连同原始数写回本文。任何一项不过，先回来改方案，不硬上。

### 6.1 证据规则站不站得住（M1）

R2 的前提是“只有 agent 的话或 memory 的条目更容易错”。这一点还没人验证过，先量。

- **样本：** orbit space 的 `auto` 条目，按 §1.3 分类，“观察到的”“人说的”“只有 agent 的话”“只有 memory”各随机抽 30 条。差距看不清时再加到 60 条。
- **审计：** Claude 审计员不知道类别，对照被引记录和 `origin/main` 的代码，判断条目现在说得对不对：对、部分对、错、无法判断。
- **门槛：** “只有 agent 的话”和“只有 memory”的错误率（错 + 部分对）比“观察到的”高出至少 10 个百分点，R2 才按原样上。否则 R2 收窄或取消，§10 第 2、3 条重新定。
- **不用 System model，不写 wiki 表。** 30 条的置信区间约正负 18 个百分点，只能看出大差距，这正是这里要的。

### 6.2 回放（M2 到 M6）

用分支代码构建案卷和提示，生产库只读，模型用 System model，不写任何 wiki 表，约 2 小时 GPU。

- **样本：** 10-05 到 10-25 写过 memory、不在留出集的 100 个 session，随机抽。留出后面的时间，才能看“后来用得上”。
- **A 基线：** 现有案卷和提示。
- **B 声明：** 新案卷和提示。
- **C 负对照：** 20 个 session 塞进别的 session 的声明。
- **D 读代码：** B 的条目再核对一次，这次读代码。

| 门槛 | 通过条件 | 依据 |
| --- | --- | --- |
| G1 找得到证据 | B 里除 `not_durable` 外的声明，至少 60% 产出带第一手出处的条目 | 现状 1.2%；前测 93% 只是上限 |
| G2 不附和 | C 里别的 session 的声明，产出条目不超过 5% | System model 看到提示后可能顺着说，这是最大风险 |
| G3 不挤占 | B 中不来自声明的条目数，不低于 A 的 90% | 演示里 60% 的条目是 memory 没记的 |
| G4 读代码 | D 相对 B 至少 5% 的结论改变，才做代码核对 | 价值未知 |
| G5 有用 | 见下面两个数，B 都不低于 A | 不再靠人工盲评 |

G5 的两个数：

- **盲评：** 审计员不知道 A、B，给每条打分：看代码一分钟看不出、能改变下次做法、现在仍然对。A、B 各抽 40 条。
- **后来用得上：** 条目的路径、命令或报错，在产生它的 session 之后的 session 里出现过的比例。

### 6.3 读（M7）

回放历史上的多词查询。0 结果率从 66% 降到 20% 以下，并且抽 30 条查询看前 3 条，至少 60% 切题。放宽匹配可能换来一堆不相关的结果，所以两个数都要看。

**结果（2026-11-05）：没过门槛。第三轮不在这次落地里，放宽与否等 owner 决定。** 代码留在分支 `wiki-read-third-round`。读取记录、工具说明和指令那句话照常落地。

| | 调用当时 | 不加第三轮 | 第一轮：任一词 | 第二轮 V1 | 第二轮 V2 | 门槛 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 结果率（182 条） | 118（64.8%） | 102（56.0%） | 4（2.2%） | 24（13.2%） | 3（1.6%） | < 20% |
| 主口径：前 3 条命中里切题的比例 | | 24/36 = 66.7% | 47/80 = 58.8% | 40/75 = 53.3% | 45/78 = 57.7% | ≥ 60% |
| 主口径 95% 区间（按查询 bootstrap） | | | 45.1% 到 72.8% | 38.6% 到 68.2% | 43.4% 到 72.0% | |
| 次口径：前 3 条至少一条切题的查询 | | 12/30 | 24/30 | 22/30 | 24/30 | 只报告 |
| 第三轮答的查询的主口径 | | | 32/60 = 53.3% | 16/39 = 41.0% | 21/42 = 50.0% | |
| 第三轮延迟 p50 / p95（ms） | | | 551 / 1,865 | 638 / 1,873 | 1,075 / 3,260 | p95 ≤ 3,000（只卡 V2） |

“不加第三轮”的主口径和次口径用第二轮的样本；它只回答了其中 16 条查询。

- **总体：** owner 的 session，创建于 09-25 之后，11-04 之前的 `wiki_search` 调用，query 不含 `/` 且有多个词，排除协调者的测试 session。共 182 次调用、181 条不同查询、88 个 session，都能回放。截到 11-02 那次统计的时间是 180 条，和当时的 188 减 8 条测试一致。
- **回放：** 分支的匹配代码在生产 `orbit-wiki-worker` 里跑，连接只读，写探测被拒。回放前后 `wiki_entry`、`wiki_exposure` 行数不变；变化的只有 `wiki_doc_footnote`、`wiki_doc_sentence`、`wiki_model_request`，只读连接写不了，应是同时运行的作业。
- **切题：** 两个子 agent 盲评，不知道门槛、轮次和版本，两个都说切题才算。方法、种子和读法都在看结果之前写进任务评论。
- **第一轮：** 第三轮按任一词命中，下限 3 个字符。主口径差 1 条。只有 1 个可用词的查询噪声最大（6/21 = 28.6%），2 个及以上是 26/39 = 66.7%。全部 108 条第三轮查询里有 20 条只剩 1 个可用词，这 20 条都有词被下限去掉，其中 18 条含中文。
- **第二轮为什么改：** 针对上面的噪声，比较两个版本，都要求至少 2 个可用词。V1 沿用下限；V2 让 CJK 两字词也算可用词。用新种子重抽不重叠的 30 条。开跑前定好规则：V2 三项都过就上 V2，否则 V1 前两项都过就上 V1，都不过就停下，不再调第三次。结果是都不过。
- **局限：** 样本只有 30 条，区间很宽。两个评审是同一个模型的两次运行，两轮分别 80/80、82/84 一致，不能算真正独立。回放用的是今天的条目，不是调用当时的。CLI 的 `orbit wiki search` 不在这个总体里。延迟是生产负载 3 到 10、有其它回放同时运行时量的。
- **明细：** 查询级结果和盲评在任务 `34rozWKS7aNWiVxSb4SxI` 的 FILE 证据里，生产 session 是 `34rqi3mMi333ffmyJjxQ1`。

### 6.4 上线后（M8）

memory 进了抽取，就不能再拿它评召回率。所以留 10% 的 session 不给声明，继续用它们的 memory 算召回率，和声明组比。

- **何时比：** 留出组满 30 个写过 memory 的 session 时，按现在的量约 10 天。不按日历等。
- **盯的数：** `report.claims`、新 op 的信任分布、读取记录。
- **告警：** Claude session 的 memory 写入量连续归零（§8）。

---

## 7. 分期

| 阶段 | 做什么 | 主要改动 | 完成标准 |
| --- | --- | --- | --- |
| P0 修读 | 搜索第三轮放宽；记录 search、get exposure；改正工具说明；指令加一句 | `wiki-retrieval.ts`、`wiki_tools.go`、`agent_instructions.go` | §6.3 的两个数达标 |
| P1 证据规则 | R2；note 污染；案卷排除 wiki 读取 | `wiki.ts`、`wiki.service.ts`、`wiki-dossier.ts`、CHECK 迁移 | pg spec 通过；新 op 的信任分布可查 |
| M1 抽查 | 按证据类别抽查条目对错（§6.1） | 不改产品代码 | 每类错误率写回本文，决定 R2 是否照上 |
| P2 声明和回放 | 案卷、提示、解析，默认不进生产路径；跑 §6.2 | `wiki-dossier.ts`、`wiki-maintain.ts`，回放脚本不进仓库 | G1 到 G5 的结果写回本文，不过就回来改方案 |
| P3 上线 | 维护作业打开声明；留出 10%；`report.claims`；写入量告警 | `wiki-maintain-job.ts` | 留出组满 30 个 session 后对比（§6.4） |
| P4 `wiki_note` | 工具、CLI、路由、`session_id` 迁移 | `wiki_tools.go`、`wiki_cli.go`、`runner-wiki.controller.ts`，runner 发版 | 非 Claude session 记的 note 进入案卷 |
| P5 历史回填 | §5 | `wiki-maintain-job.ts`、`wiki-admin.controller.ts` | 试点过门槛后全量，收尾降级 |

- **依赖：** P0、M1、P2 可以同时开始，回放脚本自己按 R2 分类，不等 P1。P1 依赖 M1。P3 依赖 P1、P2。P4、P5 依赖 P3。
- **P0 的搜索：** `broaden` 之后仍要求所有词命中（`src/apiserver/src/sessions/search-query.ts:113`）。wiki 这里再加第三轮：任一词命中，按命中词数排序，过短的词不参与。session 搜索不动。
- **P0 的 exposure：** `wiki_exposure.channel` 早就允许 `search`、`get`（迁移 `0307_wiki`），只是没有写入方。
- **合同要同步改：** `maintenance.dossier.memory`（`contracts/wiki.contract.json:965`）、`maintenance.job.report`、`reviewModes.verification.evidence`、`agentSurface.tools`、`import.source`，以及 `docs/wiki-contract.md`。
- **回滚：** 不加开关。测量先挡住，出问题 revert 后重新部署；已写入的条目用现有的整次撤回。

---

## 8. 风险

- **模型附和。** 最大风险，由 G2 把关。核对器看不到声明，这是第二道防线。
- **Claude 改机制。** 2.1.318 里已有后台提取代码（`extractMemories`、`autoDream`），近 7 天没有 `memory_saved` 事件。一旦启用，写入会离开主事件流，工具调用这条路静默归零。对写入量告警；退路是读 `memory_saved` 里的路径，再让 runner 读文件。
- **漏网。** 一个账号 7 天变更的 100 个文件里，27 个没有 Write、Edit 记录（6 个经 Bash，21 个没找到，其中 13 个没有 `modified` 戳），多半是脚本整理，没有逐个确认。
- **网页内容混入。** 污染只认 WebFetch、WebSearch 这几个工具名（`src/apiserver/src/wiki/wiki.service.ts:4352`），Bash 里的 `curl` 不算。本方案不改，但任何自动推送上线前都要先修。
- **隐私。** memory 正文原本就在事件流里。新变化是它进入 System model 的提示。案卷不落库，先过脱敏器，`user` 类跳过。
- **`auto` 明显变少。** 这是预期结果。标签会更诚实，但界面上的 Unreviewed 会变多。
- **算力。** articles 占近 14 天 orbit space 模型请求的 81%（31,345 次），抽取只有 1,368 次。这个比例是否正常还没查。

---

## 9. 不做

- **文件监听、engine 钩子。** 写入已经在事件流里。光 HPC 和 wikova 就有 6 个 memory 目录，监听要逐个处理，还多一条新的数据路径。
- **开启 Codex memories。** 为 wiki 开它不划算（§1.4）。
- **服务端循环式调查。** 不让模型在服务端循环读 session 和代码。演示里两段式更慢，召回率也更低；Wikova 的教训也是把内容直接拼进提示。
- **写回或修改 memory。** 被判矛盾的声明先只计数，看两周的量再定要不要告诉人。
- **新表、新作业类型、新界面。** `report.claims` 这一期不画，所以没有效果图。
- **按文件自动提示。** 上一轮提到的这一步，要等 P0 的读取数据。
- **统一 memory 目录。** 这是独立问题，见下。

**独立问题：memory 跟账号走。** HPC 上同一仓库分散在 3 个目录，共 943 个文件名，只有 2 个三处都有。换账号只带走 transcript（`src/runner-go/claude_account_move.go:34`），session 换账号后就看不到之前写的笔记。Claude 文档说 `autoMemoryDirectory` 可以经 `--settings` 设置，runner 已经在传这个参数（`src/runner-go/claude_spawn.go:114`），可以让同一 workspace 的账号共用目录。建议单独修，还没实测。修了之后 §3.1 的路径规则要跟着改。

---

## 10. 已定（owner 2026-11-04：全部按推荐，不确定的按数据测量）

1. **改合同的 memory 规则。** 案卷规定不含 memory，可追溯到 9 月演示时“不受 memory 干扰”的要求。当时防的是 memory 混进证据和评分，这两点都保留了。
2. **R2 管所有新 op。** M1 不支持时重新定（§6.1）。
3. **旧的“只有 agent 的话”条目（4,473 条 `auto`）先不动。** 等 M1 和 P0 的读取数据。
4. **历史回填两批都做。** 从新到旧，试点不过就停。
5. **矛盾的声明先只计数。**
6. **“有没有用”不靠 owner 盲评，改成数据（G5）。**

---

## 11. 数据来源

- **生产只读聚合（只取计数）：** session `34qbDqmMsq466A294A50y`、`34qfVfPEeFEa3ozniFBMy`、`34rn8pj3hB8YSF2klcp0a`、`34rndGClG186Pojvi1VAJ`。
- **演示任务：** `34VS7P8eDpXiMzpLZ8PY4`，召回率、漏检归因、8k 和 16k 对比、新颖度、每例耗时都来自它的报告。
- **前测（粗略上限）：** 一个账号 7 天内随机 40 个写过 memory 的 session，198 次带代码词的写入，184 次有八成以上代码词在此前的工具记录或用户消息中出现过。它只说明材料大概率在，不说明声明正确。
- **按月写入（session 创建月，不含索引）：** 6 月 361、7 月 332、8 月 277、9 月 1,790、10 月 1,798、11 月前 4 天 318，共 4,876 次，2,261 个 session。
- **引擎：** `codex features list` 在 HPC 和 wikova 上都显示 `memories` 为 false；Codex 和 Claude 的说法来自本机二进制和下面的官方文档。
  - [Claude Code: How Claude remembers your project](https://code.claude.com/docs/en/memory)
  - [Codex memories](https://learn.chatgpt.com/docs/customization/memories?surface=app)
  - [openai/codex #19758](https://github.com/openai/codex/issues/19758)
