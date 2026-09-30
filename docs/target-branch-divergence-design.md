# 目标分支分叉：Review 与产品恢复方案

状态：首版已实现，验证与交付范围见文末。2026-09-30 对照重新 fetch 的 main `2c78b7e023fe2c5690a7ca6859dd2ca0fe846b4f`。

## 判断与范围

可以从产品上覆盖。将“本地目标分支与远端分叉”作为可恢复的仓库状态，提供检查、内容预览和同步入口。有冲突或不允许直接推送时，产品继续承接到修复会话或 PR。

截图中的错误来自 `reconcileTargetWithOrigin`，表明 `develop` 和 `origin/develop` 互不为祖先。它不证明有文件冲突，也不证明任何一侧可以丢弃。截图没有实际仓库路径、提交清单或保护策略；本文不判断截图对应仓库的真实冲突数量。原型中的提交、文件、检查结果和数量均为演示数据。

设计阶段提供了[可点击原型](mocks/target-branch-divergence/index.html)。首版已接通 runner、服务端、Web 和原生客户端共享代码；[实际 Web 组件桌面效果](mocks/target-branch-divergence/implemented-desktop.png)与[手机效果](mocks/target-branch-divergence/implemented-mobile.png)使用明确的测试 fixture，不代表截图中仓库的真实数据。此次实现没有操作截图中的外部仓库。

## 现有实现 Review

| 发现 | 证据 | 对产品的影响 |
| --- | --- | --- |
| 相同 / 本地领先直接继续，本地落后自动快进，真正分叉才返回 error | [worktree.go](../src/runner-go/worktree.go)，`reconcileTargetWithOrigin` | 保留分叉保护，增加恢复路径 |
| 分叉是目标分支的问题，尚未开始本次源码重放 | 同上，`mergeToMain` 的调用顺序 | 文案应说“develop 需要同步”，不能直接说“本次改动冲突” |
| Web 对 error 展示 runner 原文和 Retry merge；原生端也使用通用重试 | [SessionOutputs.tsx](../src/web/src/components/SessionOutputs.tsx)，`MergeButton`；[WorktreeBar.swift](../src/macos/OrbitApp/Sources/OrbitApp/Views/WorktreeBar.swift)，`WorktreeMergeControl` | 没有下一步操作，同样状态下重试会再次失败 |
| fetch 失败会使用缓存的远端 ref 继续判断 | `reconcileTargetWithOrigin` | 恢复预览必须要求成功读取远端；失败展示“无法检查远端”，不能称为最新比较 |
| 普通合入在临时 worktree 重放源分支，通常先推送远端，再推进本地目标 | `rebaseFastForward` | 可复用隔离预演；必须区分远端落地与本地同步结果 |
| 已有 repo-health / repo-cleanup 只检查工作区状态、保存内容后恢复 HEAD | [repohealth.go](../src/runner-go/repohealth.go)，`cleanupRepoRoot`；[repoCleanup.ts](../src/web/src/lib/repoCleanup.ts) | 即使 checkout 干净，历史也可能分叉；“清理 checkout”无法解决本 case |
| 项目集成路径已有远端权威、检查、推送、回读验证 | [integrate.go](../src/runner-go/integrate.go)，`integrateOnce` | 复用已存在的能力和约束；本截图来自普通 session 合入路径，两条路径不能混称 |

当前合入的 source checkpoint 约束、operationId / leaseOwner 和回执逻辑应继续生效。补恢复入口不能绕过这些门。

现有错误建议直接 `git checkout develop && git merge origin/develop`，既未展示将带入哪些本地提交，也未说明应该在哪个 checkout 操作。目标可能已被其他 worktree 占用，命令不一定能在当前会话目录执行。手工命令保留在详情中，但必须包含核实后的工作目录和副作用说明。

## 推荐交互

### 1. 在合入位置展示阻塞原因

使用需要处理的黄色提示，内容保持在分支条下方，当前 diff 仍可查看：

> develop 需要同步
>
> 本地 develop 与 origin/develop 都有独有提交。先检查这些提交，再继续合入本次改动。
>
> [检查并修复] [查看详情]

成功检查后才显示“本地 2 个 / 远端 5 个独有提交”和更新时间；未检查时不编造数字。主操作从“重试合并”改为“检查并修复”。切换合入目标继续可用，但明确是用户更换目的地，不自动替用户改目标。

首版在原会话保存恢复状态。同一会话在输入未变化时复用修复 worktree；所有目标 ref 写入沿用 runner 的 `mergeLock`。跨会话合并恢复卡片、在 runner 页面统一列出受影响的仓库/目标，留作后续能力。

### 2. 检查与预览

点击后展示检查中状态，在隔离 worktree 里完成：成功 fetch、关系判定、目标同步预演、本次改动重放预演。预览分开显示：

- 本地目标独有提交：标题、作者、时间、提交链接或 diff；历史上属于哪个 Orbit 合入回执，仅在可验证时标注，否则显示“来源未关联”。
- 远端目标独有提交：同样支持展开。
- 本次会话的改动，以及最终候选内容相对远端目标的完整 diff。

同步保留双方提交历史时，会新增一个 merge commit。该操作不同于当前普通 session 的 rebase + fast-forward 合入；应明确说明，尊重已有线性历史约束。Git 的 fast-forward 只能推进到后代提交，真正分叉不能直接快进。[Git merge 文档](https://git-scm.com/docs/git-merge)

对允许这种历史、预演无冲突且允许直接推送的目标，预览的主操作为：

> 同步 develop 并合入
>
> 保留双方提交历史，新增 1 个合并提交。本地额外的 2 个提交会与本次改动一起推送到 origin/develop。

这一次点击批准这个具体候选内容，不另加重复的确认弹窗。用户可以关闭预览；此时实际目标分支和源分支均未推进。

### 3. 按结果提供下一步

| 检查 / 执行结果 | 展示 | 主操作 |
| --- | --- | --- |
| 目标同步、本次改动重放均无冲突，检查通过 | 提交清单、完整 diff、合并提交和推送范围 | 同步 develop 并合入 |
| 本地与远端目标同步冲突 | “develop 同步时存在冲突”，展示实际冲突文件 | 在修复会话中处理 |
| 同步无冲突，但本次会话改动重放冲突 | “本次改动与同步后的 develop 冲突” | 在独立修复会话处理，保留原 source 分支 |
| 要求线性历史，或目标要求通过 PR 合入 | 解释对应策略，展示可交付的候选分支 / patch | 准备 PR；不能直接推送目标 |
| 网络 / 鉴权失败，或无法判断祖先关系 | “无法检查远端”，展示可恢复的具体原因 | 重新检查 / 处理连接 |
| 无共同祖先 | “两侧没有可验证的共同历史” | 查看详情 / 在修复会话中检查；不使用 allow-unrelated-histories |
| 检查失败 | 展示失败的既有合入检查及日志 | 在修复会话中处理 |
| 预览后 source / local / remote 改变 | “分支已更新，请重新检查”，旧执行按钮失效 | 重新检查 |
| 远端已接受，本地 checkout 快进失败 | “已合入 origin/develop；本机 develop 待同步” | 同步本机；不重复重放或推送 |
| 已由其他操作落地 | “已合入”，附远端验证结果 | 如有必要，仅同步本机 |

修复会话使用独立、可保留的 repair 分支/worktree，输入包括仓库位置、目标、冻结 SHA、冲突阶段和文件、候选 diff、源 checkpoint、用户批准的范围及保护策略。Agent 在该分支修复并运行既有检查，完成后回到同一预览；修改后的候选必须重新 review。不能让它在共享 develop 上直接 rebase/reset，不能把“启动修复会话”解释为批准推送未知提交。

准备 PR 也必须先产出可审查的分支和 diff；仓库支持且允许 merge commit 时，可以提出包含同步与本次改动的 PR。要求线性历史时，由修复会话在独立分支组织需保留的 patch，经审核后准备 PR。没有托管平台能力时提供候选分支和 PR 链接入口，不承诺已创建 PR。记录候选就绪不等于已合入，只有目标落地证据才能改变 merge 状态。

## 自动化边界

| 分支关系 | 处理规则 |
| --- | --- |
| 相同 | 继续现有合入 |
| 本地落后 | 延用已有 fast-forward；仅真实覆盖的本地未提交文件才阻塞，无关脏文件不阻塞 |
| 本地领先 | 现有实现允许继续；新预览应同样揭示将带入远端的本地额外提交。纳入本次恢复范围，避免只修分叉而保留同一类隐式带入问题 |
| 双方分叉 | 自动检查、预演，用户 review 具体范围后执行 |
| 已落地 | 回读目标确认；不重复应用内容 |

“无文本冲突”只说明 Git 可以组成内容，并不能判断本地额外提交是否应发布、测试是否通过或仓库是否允许 merge commit。因此不建议看到 divergence 就后台直接 `git pull`。不提供默认丢弃本地 / 覆盖远端操作，也不通过 patch-id 相同直接判定本地提交可以删除。

## 最小实现设计

### 结构化诊断，保持现有状态兼容

给普通合入结果增加可选诊断 `recovery: { code: 'TARGET_DIVERGED', ... }`，保存为 Session 的 `mergeRecovery`；预览继续使用现有 `error` 状态加结构化 `READY`，不扩充旧 wire 的 status 取值。客户端依据代码渲染恢复入口，不解析英文错误字符串。诊断经过 shared DTO、runner 结果上报、服务端持久化和 Session detail 投影，Web / iOS / macOS 使用同一语义。旧 runner / 旧客户端继续看到现有 message；恢复操作只对声明 `session-merge-recovery-v1` 的 runner 开放。

首版只实现本 case 和恢复操作实际需要的原因，不先建设通用 Git 错误框架。诊断包含 runner 提供的仓库标识、目标 ref、remote 名、当时两侧 SHA、检查时间；完整提交清单和候选结果在用户点击检查后生成。

### 两个操作，复用现有派发与回执

1. **检查**：请求 runner inspect/preview，返回可持久化的 previewId、source / local / remote SHA、同步方式、额外提交集、候选 SHA/tree、完整 diff、两阶段冲突和检查结果。获取失败和“远端没有该分支”须区分；不能拿 fetch 失败后的缓存作确认依据。
2. **执行**：请求引用 previewId；server 校验 owner、关联会话/仓库、用户授权范围和 runner 能力。runner 校验三侧 SHA、source checkpoint、checkout 状态与候选树，才执行这个已预览结果。请求和结果使用 operationId / leaseOwner；重复点击或心跳重投只关联同一个操作。

首版按会话保存候选，复用已有锁与串行化规则。执行不能与现有 merge、repo-cleanup、项目 integration 的 ref 写入相互穿插。长期持久化只需 preview/操作事实及候选 ref；不新增与现有回执平行的“已合入”真相来源。跨 workspace 的候选去重尚未实现。

### 执行顺序

1. 在隔离 worktree 从冻结的 local target 构建包含 remote target 的同步结果，再按既有 replayAnchor 只重放本次 source 范围。把 `TARGET_SYNC` 与 `SOURCE_REPLAY` 冲突分开记录。源分支不改写。
2. 生成相对冻结 remote target 的完整候选 diff，记录额外本地提交、同步 merge commit、candidate SHA/tree，运行已配置的合入检查。未配置检查时只能说“Git 预演无冲突”，不能显示“测试通过”。
3. 用户 review 后重新读取三侧 tip，复验批准范围、目标 checkout 是否正在被使用、未完成 Git 操作、将覆盖的未提交/未跟踪文件。目标已在其他 worktree 检出时显示实际位置，首版不强移它的 ref。任何未知或变化回到检查，旧 preview 失效。
4. 保存操作需要恢复的目标旧 SHA / candidate ref；推送已批准 candidate 到 remote target，使用普通 fast-forward push，不用 force。如果仓库保护拒绝，保留候选并进入 PR 路径。鉴权/网络失败不能泛化为分叉。
5. 回读远端确认候选已落地，再推进本地目标。未检出的分支使用 `update-ref <ref> <candidate> <expectedLocal>` 防止覆盖并发本地提交；已检出的目标仅在对应 checkout 进行 `merge --ff-only`。[Git update-ref 文档](https://git-scm.com/docs/git-update-ref)
6. 记录正确的合入回执，同时单独报告本机同步结果。远端已落地但本地同步失败时，仅恢复本地同步。推送响应丢失或 runner 崩溃后，先读实际远端和已持久化候选记录，不能盲目重新生成/重放；候选已被远端包含也属于落地成功。

远端普通 push 保护分支历史不被非快进覆盖，但不能与本地 checkout 构成一次原子事务。必须承认并恢复部分成功，而不是笼统宣称“失败时什么也没变”。[Git push 文档](https://git-scm.com/docs/git-push)

检测到 remote tip 前进后可以自动重新检查并生成候选，但新候选进入 review，旧批准不沿用。使用预览展示的固定 SHA 构建并检查内容，不能执行时把 branch name 解析成另一个版本。

### 代码接入点

- Runner：`worktree.go` 的目标关系诊断、隔离预演、候选执行与 `runloop.go` 的派发/结果链路；复用 `repohealth.go` 的 checkout 检查，借鉴 `integrate.go` 的检查和回读验证。
- Shared / API：`src/shared/src/dto.ts` 的可选诊断和恢复请求；`sessions.service.ts`、`runner-api.controller.ts` 的持久化/权限/lease fence；继续使用 `merge-receipt.service.ts` 的回执投影。
- Web：`SessionOutputs.tsx` 的 `error` 分支和 `MergeButton`，新增检查预览；相关 runner 页面按同一仓库/目标展示入口。
- Native：`WorktreeBar.swift` 和共享 Session 模型同步新诊断；首版 iOS / macOS 都在合入条下显示可展开的面板，完整 diff 按需展开，使用已有字体 token 支持手机 Dynamic Type。

## 建议分期与验收

先交付一条完整恢复路径：结构化 `TARGET_DIVERGED`、检查预览、允许直接推送且保留双方历史的无冲突同步、明确的本机同步结果；同时对本地领先展示额外提交。冲突和保护策略也必须有明确入口和候选材料，不能重新退回原始错误。自动 PR 创建、复杂线性历史修复、后台持续扫描作为后续能力。

| 验收场景 | 必须观察到的结果 |
| --- | --- |
| 分叉但内容无冲突 | 可在产品内检查、review、合入；双方旧 tip 在同步结果历史中，source 分支不变，remote 和 local 结果一致 |
| 检查后取消 | 除 fetch 的缓存、临时对象外，实际 local/source/remote 目标不推进，不推送 |
| 本地额外提交 | 提交清单和最终 diff 可见；用户批准的 candidate 才能推送 |
| 目标同步冲突 / source 重放冲突 | 阶段和冲突路径明确；正式 checkout 不留下未完成操作；分别进入修复入口 |
| merge check 失败 / 未配置 | 失败不推送；未配置不能宣称测试通过 |
| 三侧 SHA 变化、重复点击、重启和投递重试 | 旧 preview 失效；同一操作不重复应用；源证据 fence 不绕过 |
| 未检出目标的本地并发提交 | CAS 拒绝覆盖；展示本机待处理状态，不丢提交 |
| 脏文件、未跟踪文件、目标在另一个 worktree | 不覆盖已有内容，明确位置；无关脏文件不变成整个仓库停摆 |
| fetch / push 鉴权或网络失败 | 不使用旧缓存宣称最新比较；根据实际远端读回区分未推送、已落地与未知 |
| PR / 线性历史策略 | 不绕过保护，不自动改写共享目标，不把候选就绪记为已合入 |
| 远端成功、本地失败 | 仍记录远端落地，主操作只同步本机，不重复带入 source |
| 相同、单纯落后、无 remote、无共同祖先、旧 runner | 保留适用的原有路径；无共同祖先和不支持的新操作明确拒绝 |
| Web / iOS / macOS | 同一诊断对应同一恢复动作；分叉提示与普通 source conflict 不混淆 |

设计阶段在基线运行的 5 个既有 Go 回归均通过。落地阶段另在独立、重新 fetch 的 main checkout 上执行 `^TestMergeToMain` 回归，通过；新实现使用真实本地 Git 仓库与 bare origin 验证下列恢复路径。

## 首版实现与验证

- [merge_recovery.go](../src/runner-go/merge_recovery.go) 在独立 worktree 同步目标历史、重放本次 source，输出双方独有提交与相对远端的完整 diff。真正分叉新增合并提交；本地领先也先 review。本地已包含 source、远端还未接受时不会写虚假的远端成功结果。
- 每次检查生成新的 `previewId`。执行冻结 source / local / remote / candidate / tree，同时复验检查命令及其超时配置。修复后的内容需重新检查；旧审批编号不能批准新候选。回执中的 `rebaseBaseSha` 是实际同步结果的 SHA。
- `merge.ff=only` 的真正分叉明确进入 PR 候选入口。远端保护策略由正常 push 的服务端拒绝承接，不提供 force push。首版不自动查询托管平台的分支规则，也不自动创建 PR。
- 目标同步和 source 重放冲突均留在独立修复 worktree。Web / 原生端的入口创建独立修复会话，携带实际路径、冻结输入和阶段，完成后回原会话重新预览。原 source 分支保持不变。
- 远端已落地、本机 checkout 受阻时仍保存一条 `MERGED` 回执，并保留 `LOCAL_SYNC_PENDING`。本机同步重试不再次推送或写第二条回执，不改原合入时间和已记录 fork；连接失败仍保留本机重试入口。
- 修复 worktree 不进入会话 GC，避免磁盘压力下清掉正在修复或等待 review 的候选。首版保留这些材料，尚未提供自动过期清理入口。超过 200 个独有提交或 1 MiB diff 时不提供直接批准按钮。

本地验证：

| 检查 | 结果 |
| --- | --- |
| Go 恢复、既有合入、wire 与 worktree GC 回归 | 通过；覆盖两阶段冲突及修复、输入变化、检查失败及修复、推送拒绝、线性历史、其他 worktree 占用、本地未跟踪文件和仅本机重试 |
| API 审批、operation / lease fence、checkpoint 和回执回归 | 93 个测试通过 |
| PostgreSQL 16 临时实例 | 全量迁移含 `0341_session_merge_recovery` 通过；新的队列→心跳→结果→部分落地→本机重试链路通过，22 个既有回执与等待合入回归串行通过 |
| Shared / Web 恢复与合入条组件 | 19 个测试通过；真实组件在 Chromium 的桌面/手机布局、固定候选批准、本机单独重试通过，无横向溢出或脚本异常 |
| TypeScript 与 Web 生产构建 | 通过 |
| Swift 共享模型与合入条逻辑 | 42 个测试通过；SwiftUI 改动通过语法检查，字体与导航门禁通过。完整 macOS / iOS 构建由 PR 的 Client CI 验证 |

`go test ./...` 的全量尝试不能报告全绿：真实引擎测试受本机 CLI 版本/鉴权影响，任务与项目 CLI 测试还会继承当前 Orbit 会话环境。`TestRealClaudeAcceptsASetModel`、`TestProjectCreateSendsOnlyTheFieldsGiven` 的失败和 `TestCLITaskCreateExposesAndForwardsTheThreePeerCompletionCriteria` 的超时已在独立 main checkout 复现；后二者去掉继承的 `ORBIT_*` 环境后通过。未修改这些与合入恢复无关的基线代码。

上线需要先更新服务端/Web 并应用迁移，再更新 runner 与原生客户端。只有 runner 心跳声明新能力后才可使用恢复操作；旧 runner 不会被派发新语义。当前交付是分支上的实现与验证，未部署或发布客户端。
