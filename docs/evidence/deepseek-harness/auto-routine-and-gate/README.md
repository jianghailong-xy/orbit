# dsh：Auto 自动放行日常越界，对外动作先问

固定 `@deepseek-ai/dsh@0.2.0-rc.2`（Linux x64、Node 26，CLI sha256 `1a03dee1…f307f`，与 P0 记录一致）。验收入口仍是 P4 的脚本，本次在其中加了下面的具名场景：

```sh
bash scripts/test-dsh-mcp-approval.sh [--evidence <dir>]
bash scripts/test-dsh-mcp-timeout.sh
```

背景是 2026-10-08 对 DeepSeek Harness 的 Auto 模式做的评审：Auto 的划界依据是"文件写在哪里"，而不是"动作风险多大"。两个后果：
- Orbit 自己的隔离 worktree 里，日常操作每次都要人批准；
- 对外动作一次也不问。

本次改动把这两点按 Codex Auto 的做法补齐。P4 的结论（[../p4/README.md](../p4/README.md)）在本文没有提到的部分仍然成立。

## 1. 改动前（生产与实测）

- **生产数据**：这台 runner（workstation-gpu）上有 17 个 dsh 会话，全部是 Auto（workspace-write），其中 16 个在 Orbit worktree 里。
  - 8 个任务执行会话共出了 35 张审批卡。34 张是 git commit、merge、fetch、push 要写主仓库的 `.git`（linked worktree 的 index、objects、refs 都在那里），1 张是 `~/.cache/go-build`。
  - 35 张全部是 allowed-once。等待时间中位数 47.5 秒，最长 8600 秒，累计约 4.6 小时。
  - `git fetch … | tail` 被沙箱拒绝时，因为管道退出码是 0，不带拒绝标记，agent 拿着旧的 origin 引用继续工作。
- **实测**：把工作区外的一个文件用 `curl -X POST` 发到 HTTP 端点，Auto 和 Default 下都没有出卡，数据发出去了。文件沙箱只管写文件，不管网络。

## 2. 改动

**Auto 自动放行日常越界**（`dshAutoRoutineEscalation`，`src/runner-go/dsh_permissions.go`）。

Auto 下，模型对一条 bash 命令申请越界（`sandbox_permissions`）时，满足下面全部条件，runner 就自己回 `allow-once`，不出卡：
- 命令的目录在工作区内；
- Codex Auto 的请求级规则（`codexAutoApproval`）认为它是日常命令：不是 push、fetch、安装、远程 shell、内联解释器，不涉及密钥文件，不是递归删除；
- 不命中下面的工具闸门；
- 不是容器命令；
- 命令里出现的每个路径都在工作区或临时目录内。commit 说明（作为文本读取的 here-document、引号里的 `git -m`）不算路径；HOME 路径、未知变量路径、离开工作区的 `..` 都不放行。

批准一次越界，等于这一整条命令不受沙箱约束地运行（从 workspace-write 往上只有 `danger-full-access` 一级），这和 Codex Auto 接受的代价一样。所以其他工具（`write`、`edit`）的越界照旧出卡，读不懂的命令也照旧出卡。自动放行会在转录里记一条 `permission_auto_allowed`。Default 和 Don't Ask 不变。

**工具闸门**（`dshToolGatePlugin`，`src/runner-go/dsh_environment.go`；规则 `dshToolGateRules`）。

每个 dsh 会话的 overlay 都会挂上一个插件，在 dsh 的 `tools/pre-execute` 钩子里对两类调用返回 `ask`：
- 对外动作的 bash 命令：push、远程 shell 或复制、HTTP 写入、GitHub 变更、集群或云变更、服务启停、提权、关机、发布；
- 第三方 MCP 工具。

这个 ask 会作为 `session/request_permission` 到达 runner，由 runner 按模式回答：Default 和 Auto 出卡；Don't Ask 直接拒绝，不出卡。被拒的调用不会执行（实测）。

规则只认处在命令位置上的程序（所以 `grep shutdown log`、`echo "ssh mux"` 不算），commit 说明同样不参与匹配。正则只有 Go 里的一份，作为插件配置原样下发，Go 和 JS 读命令的方式一致。匹配命中的越界请求也从不算日常。容器命令不在闸门里，因为这台机器上 docker 用来跑测试栈；这一点待所有者决定。

**说明文字**（`src/shared/src/permissionSemantics.ts`）：DSH 三个模式的 note 写明了哪些不问、哪些先问（或在 Don't Ask 下拒绝），以及网络不受文件沙箱限制。界面上怎么显示这段说明，设计图在 `docs/mocks/dsh-permission-mode-notes/`，等所有者确认后再实现。

## 3. 验证

- **单元测试**：
  - `TestDshAutoRoutineEscalation`：30 条命令，覆盖放行和不放行两类；
  - `TestDshToolGate`：40 条命令；
  - `TestDshPermissionBridge` 的 3 个新子场景；
  - `TestDshAgentOverlay`：确认闸门插件和它的配置随每个会话下发。
- **真 dsh**：
  - `TestDshRealAutoRoutineEscalation`：linked worktree 里越界的 commit 不出卡，越界的 push 出卡，拒绝后确实没推出去；
  - `TestDshRealToolGateAsksInAuto`：HTTP 写入出卡，拒绝后接收端什么也没收到，普通命令照常不问；
  - `TestDshRealToolGateRefusesInDontAsk`：同一个 HTTP 写入被拒绝，不出卡；
  - `TestDshRealThirdPartyMCPAsksFirst`：取代原来的 `…RunsUnasked`。第三方 MCP 每次调用都出卡，拒绝的没有副作用，允许的只执行一次；
  - `TestDshRealMCPTimeoutCancelsTheCall`：替身自动应答闸门的卡，测的仍是 60 秒期限本身。
- **生产回放**：用这台 runner 上的 dsh 会话日志回放 Go 端同一套规则。
  - 35 次越界里 30 次会自动放行。剩下 5 次都应该问：3 次 push、1 次直接改项目分支 ref 再推送、1 次 fetch。
  - 1,518 条沙箱内命令，闸门一条都没命中。同一批命令按 Codex Auto 的清单约有 130 条会问，主要是 `python3 -c`、`rm -rf`、`git fetch` 和读 GitHub API。
  - 回放只读日志，本目录不保存命令原文。

- **验收脚本**：`bash scripts/test-dsh-mcp-approval.sh --evidence <dir>` 通过，结果是本目录的 `summary.json`、`acceptance-output.txt`、`race-output.txt` 和 `recordings/`。
  - 47 个 Go 具名场景通过，其中 11 个跑真 dsh；19 个服务端和 shared 场景通过；36 个进程内场景做了 race 检查，检测器干净。
  - 没有缺失或跳过的场景；真实 `~/.dsh`、`~/.agents` 前后指纹一致。
- **其他测试**：
  - `bash scripts/test-dsh-mcp-timeout.sh` 通过；
  - `npm test -w @orbit/shared` 通过（407 个测试）；
  - 网页 `dshRuntime.test.ts` 和 `workspaceDefaults.test.ts` 通过（68 个测试）；
  - `cd src/runner-go && go test ./...` 通过。
- **工具闸门路径的事先验证**：先用一个只认标记字符串的临时插件，在真 dsh 上确认了以下几点，然后才写正式插件：
  - `tools/pre-execute` 返回的 ask 会作为 `session/request_permission` 到达 runner；
  - Default 和 Auto 出卡，Don't Ask 拒绝；
  - 拒绝时 HTTP 请求和第三方 MCP 调用都没有发生，允许时才执行。

## 4. 已有的偶发失败（与本次改动无关）

`TestDshRealApprovalStop` 和 `TestDshRealApprovalDisconnect` 偶尔会因为 `LatePoll` 判定失败（"the stopped card was still being read after its turn settled" / `latePoll=true`）。失败时文件都没有写入，轮次结算也正确。

原因在控制面替身：它的审批轮询接口最长挂起 1 秒，每 20 毫秒检查一次。结算瞬间仍在途的那次请求，客户端已经取消，但服务端还没察觉，可能再循环一次，被计为"结算后又读卡"。

为确认不是本次改动引起的，在同一台机器上把这两个测试各跑了 5 轮：

| 代码 | 通过 / 失败 |
| --- | --- |
| 本次改动后（会话工作区） | 8 / 2（Stop 2 次） |
| 本次改动后（另一个临时 worktree，只跑 Stop） | 6 / 0 |
| 改动前，main `6a58a9515` | 9 / 1（Disconnect 1 次） |

改动前后都出现，判定方式相同。按"只改要改的"原则，本次没有修改这个判定。

## 5. 限制

- **规则清单不是沙箱**。它挡得住明写出来的对外动作，挡不住包在脚本里的同类动作，比如一个自己发 HTTP 请求的 Python 文件。读工作区外的文件仍然不问。
- **自动放行的越界会脱离沙箱运行**，范围和 Codex Auto 一样。
- **只验证了 Linux x64 和 Node 26**，与 P0 的平台范围相同。
- **runner 发版后才生效**。已有会话下次准备启动时会改写 overlay，ConfigHash 随之更新，恢复数据保留。
