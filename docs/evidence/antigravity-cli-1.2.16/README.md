# agy 1.2.16 实测脚本（阶段 3：人工审批）

[`docs/antigravity-runtime-contract.md`](../../antigravity-runtime-contract.md) §14.2 里每条【实测】结论用的实验。
和 1.2.15 那套一样是一次性的实验脚本，写死了 scratch 根目录 `/var/tmp/agy-p3`（改 `ROOT` 即可），不参与构建和测试；
行为由 `src/runner-go/antigravity_approval_contract_test.go` 的契约测试兜底。

| 文件 | 作用 |
| --- | --- |
| `drive.py` | 实验驱动：起 [`mockgemini`](../../../src/runner-go/testdata/mockgemini)（先 `go build -o /var/tmp/agy-p3/mockgemini ./testdata/mockgemini`），建临时 HOME、`--gemini_dir` 和 git 工作区，写场景里的 settings/hooks/MCP 配置，按顺序发消息并等每轮的 `result`；场景里的 `{"ctl": …}` 步骤在两轮之间改写 hook 的回答，`{"shell": …}` 执行一条命令（可用 `$WORK`、`$RUN`、`$GD`、`$CONV`）；`"print"` 场景只跑一次 `agy --print=…` |
| `hook.py` | 通用 hook：记录负载、进程关系和环境，按 `ctl.json` 里该事件（或 `PreToolUse:<工具名>`）的设置回答：`out` 原样打印、`exit` 退出码、`sleep` 先等、`stderr` |

场景（`python3 drive.py <场景>.json`）：

| 场景 | 看什么 | 结论 |
| --- | --- | --- |
| `s_hooks_list` | `--print=/hooks --output-format json` 的格式 | §14.2 `/hooks` |
| `s_basic` | PreInvocation 睡 2 秒 | 同步，回复晚 2 秒 |
| `s_sessionstart` | SessionStart、PreInvocation、PostInvocation、Stop 的触发时机和负载 | SessionStart 在第一条消息之后 |
| `s_coverage` | 每种工具各调一次，hook 放行并记录（`fakemcp.py` 取自 [`../antigravity-cli-1.2.15/`](../antigravity-cli-1.2.15/)，日志路径改到 `/var/tmp/agy-p3`） | 除 `ask_question` 外都经过 hook |
| `s_subagents` | 子代理执行命令；`schedule` 定时器 | 子代理的调用不经过 hook；定时器的调用经过 |
| `s_failmodes` | PreToolUse 的 16 种回答 | 空输出和 `ask` 会放行 |
| `s_invfail` | PreInvocation 失败；两轮之间改写 hooks.json | 不影响调用；hooks.json 被重读 |
| `s_longwait` | `timeout: 86400`，hook 660 秒后放行 | 没有 600 秒上限 |
| `s_quoting` | hook 命令里带引号的路径和参数 | 经 shell 执行 |
| `s_artifact_default`、`s_artifact_accept` | agy 自己的模式下写 artifact 目录 | 不用批准 |
| `s_nojson_enableJsonHooks` | settings 里 `enableJsonHooks: false` | 关不掉 hook |
| `s_wshooks` | 两轮之间在工作区新建 `.agents/hooks.json`，再换成 `.gemini/hooks.json` | `.agents/` 下一轮就加载，`.gemini/` 不加载 |

`/hooks` 对 hooks.json 缺失、为空、不是 JSON、是目录、多一个 hook、仓库 `.agents/hooks.json` 的输出是在同一套目录上直接跑
`agy --gemini_dir=<目录> --print=/hooks --output-format json` 看的（要带 `GEMINI_API_KEY`）。
