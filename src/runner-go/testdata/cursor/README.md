# Cursor CLI 2026.10.14-941492e ACP 样本

P0a 在 HPC（linux/x64）上用**真 Cursor CLI** 和所有者的 API key 录制，供 P5a/P5b/P5c 的假 Cursor ACP agent
（参照 `fake_kimi_acp_test.go`）回放。结论见 [`docs/cursor-runtime-contract.md`](../../../../docs/cursor-runtime-contract.md)，
录制脚本是 [`scripts/cursor-p0/reproduce.mjs`](../../../../scripts/cursor-p0/reproduce.mjs)，每个场景的断言结果在
[`docs/evidence/cursor-cli/2026.10.14-941492e/scenarios/`](../../../../docs/evidence/cursor-cli/2026.10.14-941492e/scenarios/)。

每个样本是一个 CLI 进程，目录为 `<场景>/<进程>/`：

| 文件 | 内容 |
| --- | --- |
| `stdin.jsonl` | runner 写进 `agent acp` stdin 的每一行（JSON-RPC 请求、通知、对 server 请求的应答），按顺序 |
| `stdout.jsonl` | CLI 的 stdout，一行一个 JSON-RPC 消息，按顺序（录制时核对过：没有非协议行） |
| `stderr.txt` | CLI 的 stderr |
| `meta.json` | 场景名、版本、退出码/信号，以及驱动动作序列 `actions`：每条带相对毫秒 `t`，是写出的请求（`id`、`method`）、关闭 stdin、发信号或进程退出 |

回放要点：

- 按 `stdin.jsonl` 的请求 `method` 匹配，再按顺序吐出 `stdout.jsonl` 里对应的通知和应答。server 发起的请求（`session/request_permission`、
  `cursor/ask_question`、`cursor/create_plan`、`cursor/update_todos`、`cursor/task`）带自己的 `id`，`id` 从 0 开始，
  runner 的应答用同一个 `id`。
- 取消、轮中再发 prompt、关闭 stdin、发信号这类时序动作看 `meta.json` 的 `actions`。
- 工具调用 id 形如 `call-<uuid>-N\nfc_<uuid>_0`（**中间有换行**）。重放历史时 id 是 `replay-<轮>-<步>`。
  web fetch 的权限请求用 `web_fetch_<n>`，和工具卡 id 不同。

已替换的值：API key、JWT、token 字段、登录链接参数、邮箱一律替换为占位符。运行目录换成 `<RUN>`（其下 `slots/<槽>/home`、`cursor-config`、`cursor-data`、
`xdg-config` 是那个进程的 HOME、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR、XDG_CONFIG_HOME），CLI 目录换成 `<CLI>`，脚本目录换成 `<SCRIPTS>`。
UUID 换成同一场景内一致的 `<UUID_n>`。模型输出（正文、思考）是 Auto 模型的真实输出，原样保留。

样本一览见 [`INDEX.md`](INDEX.md)（由录制结果生成）。

P0c（2026-10-17，同一个账号升级后的付费套餐）补录的样本在 [`p0c/`](p0c/INDEX.md) 下，同样是 `<场景>/<进程>/`，只收发真实 prompt 的场景：
SHELL 包装（`shell-wrapper-env/wrapper`）、仓库配置（`repo-config-baseline/repo`、`repo-config-with-flags/repo`）、轮中断网（`network-drop-mid-turn/netdrop`）、
后台命令和提交（`background-shell-and-commit/background`）、agent 和 plan 模式下的提问（`ask-question/ask`、`ask-question-plan-mode/ask`）。
上一级的同名样本是 P0a 的录制，没有改动；例如 `background-shell-and-commit/background` 仍是额度用尽的那一轮。场景断言在
[`docs/evidence/cursor-cli/2026.10.14-941492e/p0c/scenarios/`](../../../../docs/evidence/cursor-cli/2026.10.14-941492e/p0c/scenarios/)。

P5c（2026-10-17）在 [`p5c/`](p5c/README.md) 下补了一组不同性质的样本：录的是 **Orbit 自己的 runner**（启动参数、ACP 驱动、权限桥、
Orbit MCP）跑在真 CLI 上，审批卡由控制面桩按场景应答；每个场景带一份 `summary.json`（检查项、事实、审批卡、进程）。恶意仓库夹具在
`p5c/fixtures/malicious-repo/`，手工构造的 `cursor/ask_question` 样本在 `p5c/synthetic/`。

P8（2026-10-19）在 [`p8/`](p8/README.md) 下放了一份线上录制：本地全栈里 Orbit 的 runner 跑在真 CLI 上，用 strace 从 CLI 进程启动起截取。
样本是 `key-allow-reject/session`：一条命令被允许，一条被拒。被拒的那条只以 `completed` 结束，没有 rawOutput（D-P8-1）。
