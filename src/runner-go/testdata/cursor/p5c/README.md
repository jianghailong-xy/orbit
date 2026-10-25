# P5c：Orbit 的 runner 在真 Cursor CLI 上的录制

P5c（`34h05fsaJBXkS3SDQ2smK`）用固定版本 `2026.10.14-941492e` 的真 CLI 和所有者的 API key 录制。和上一级 P0 样本不同，
这里每个样本都是 **Orbit 自己的 runner**（`runCursorSession`：启动参数、ACP 驱动、权限桥、Orbit MCP）在跑，审批卡由测试里的
控制面桩按场景应答。录制脚本是 [`src/runner-go/cursor_permissions_real_test.go`](../../../cursor_permissions_real_test.go)
（build tag `cursor_real`），确定性回放在 [`cursor_permissions_test.go`](../../../cursor_permissions_test.go)。

每个场景一个目录：`<场景>/summary.json` 是这次运行的检查项（`checks`）、事实（`facts`）、审批卡、轮次结算和运行期间 CLI 下面出现过的
全部进程；`<场景>/<进程>/` 是 runner 与 CLI 之间的双向协议（`stdin.jsonl`、`stdout.jsonl`），格式同上一级 README，可直接回放。
脱敏同 P0：key、JWT、邮箱替换为占位符，路径换成 `<RUN>`（`work` 是 checkout，`session` 是会话自己的 Cursor 目录，`home` 是
runner 用户的 HOME）、`<CLI>`、`<ORBIT>`、`<TMP>`、`<OUTSIDE>`，UUID 换成 `<UUID_n>`。

真实 prompt 全部用 Auto 模型，共 16 次，账本 [`prompts-ledger.jsonl`](prompts-ledger.jsonl)（上限 30）。第 1 次是 `mcp-orbit` 的第一版
（会话没带任务 id，`task_get` 无任务可读），第 3、10 次是 `accept-edits-allow-deny`、`allow-always` 的第一版（工作区外的目录在 `/tmp`
下、检查写得太宽），都被第 2、11、12 次的重跑替换，录制不保留。

| 场景 | 模式 | 说明 |
| --- | --- | --- |
| `mcp-orbit` | Accept Edits | `orbit mcp` 经 `session/new` 的 mcpServers 注入（带会话身份变量），`task_get` 的权限请求由 runner 直接允许（`mcp__orbit__*` 预先允许，不出卡），调用到达控制面，模型拿到结果 |
| `accept-edits-allow-deny` | Accept Edits | 两条命令、两次写工作区外（非临时目录）的文件，各出一张卡；允许的执行、拒绝的没有执行，都只应答一次，从不选 allow-always |
| `accept-edits-stop` | Accept Edits | 卡片未答时停止：请求应答 `cancelled` 一次，卡片撤回，`session/cancel` 一次，命令没有执行，轮次 interrupted |
| `accept-edits-disconnect` | Accept Edits | 卡片未答时 CLI 被 SIGKILL：卡片撤回，命令没有执行，轮次以「CLI 在这一轮中退出」失败 |
| `auto` | Auto | `touch` 由 Orbit 的规则直接允许；`git push` 出卡并被拒绝 |
| `dont-ask` | Don't Ask | 不出任何卡；命令被直接拒绝；工作区内写文件仍发生（语义里如实说明）；Orbit 自己的工具允许 |
| `plan` | Plan | 先 `set_mode plan`；写文件被 Cursor 的 plan 模式挡住；`cursor/create_plan` 出计划卡并被接受 |
| `plan-switch-mode-raw` | Plan（不经 runner，所有请求一律拒绝） | **模型自己调 SwitchMode 切到 agent，CLI 不问客户端、不发 current_mode_update，随后的写文件成功** |
| `plan-switch-mode` | Plan | 同样的请求经 runner：看到 `switch_mode` 工具卡就停止这一轮并说明原因，什么都没写；下一轮先重新 `set_mode plan` |
| `bypass` | Bypass | `--force`：没有任何权限请求 |
| `malicious-repo` | Accept Edits | [`fixtures/malicious-repo`](fixtures/malicious-repo) 里每个能执行东西的配置都调用标记脚本：带 `--disable-project-configs` 后，仓库 cli.json 放行的 `touch` 仍出卡（被拒绝），仓库规则要求的命令也出卡；hooks、MCP、`.envrc`、environment/worktrees、植入的 `tsserver` 一个都没运行，CLI 下面也没有仓库或 npm 的进程 |
| `allow-always` | Accept Edits | 「总是允许」应答为 allow-once；第二条 `echo` 仍出卡（Cursor 没记住）；会话 cli-config 的白名单仍是 `["Shell(ls)"]`；checkout 和 runner 用户的 HOME 里没有 `.cursor` |

[`synthetic/`](synthetic/README.md) 是手工构造的样本，覆盖真 CLI 从没发过的请求（`cursor/ask_question`）。

运行期间观察到的其他事实：
- Cursor 自己的 `worker-server` 和 `rg --files` 在轮次中启动，15 个会话里都没有出现 `npx`、`typescript-language-server` 或任何来自仓库的进程。
- 工作区外的写：`/tmp/`、`/var/tmp/` 下不问（源码 `index.js@4599905`），其他位置以 `Write <路径>` 发权限请求，内容带 diff。
