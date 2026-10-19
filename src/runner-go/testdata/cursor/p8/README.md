# P8：线上录到的 Cursor CLI 协议

P8（`34h05gNODW63XwtyJ4Lno`）2026-10-19 03:21Z 在 HPC 的本地全栈上录制：**Orbit 自己的 runner**（项目分支尖端 `04f35078f`）、
固定版本 `2026.10.14-941492e` 的真 CLI、Orbit 中保存的 Cursor API key、Auto 模型、Accept Edits。审批卡由 P8 的脚本经控制面的审批接口应答
（`POST /api/sessions/<id>/approvals/<id>/decision`，web 用的同一个）。
录制用 strace 从 CLI 进程启动起截取它的 stdin 和 stdout，没有经过任何代理。格式同上一级 README（`<场景>/<进程>/stdin.jsonl`、`stdout.jsonl`），
可直接回放。

| 场景 | 说明 |
| --- | --- |
| `key-allow-reject` | 新建会话，两轮。第一轮两条命令各出一张卡：`git log --oneline -1` 允许，`date -u > notes-when.txt` 拒绝。第二轮不跑工具，只复述第一轮 |

这份录制是缺陷 D-P8-1 的线上证据：
- runner 对 `date -u > notes-when.txt` 回 `reject-once` 之后，Cursor 只发 `tool_call_update {status:"completed"}`，没有 rawOutput，也没有 content。
- 被允许的 `git log` 带 `rawOutput {exitCode, stdout, stderr}`。
- 只有被拒的 MCP 调用才带 `{rejected:true}`（契约 §5.2，P0 的 `multi-turn-tools-default`）。
- P5c 的 `accept-edits-allow-deny` 里，被拒的 shell 和被拒的工作区外编辑也是这样。

修复后 runner 记住自己没有放行的调用，卡片结算为 `isError:true`、"Not run: the tool call was rejected."
（`cursor_permissions.go` 标记，`cursor_events.go` 结算）。回放用例是 [`cursor_permissions_test.go`](../../../cursor_permissions_test.go) 的
`TestCursorRefusedToolCards`，验收脚本是 [`scripts/test-cursor-rejected-tools.mjs`](../../../../../scripts/test-cursor-rejected-tools.mjs)。
Cursor 的 `completed` 还没到、这一轮就结束（Stop、CLI 被杀或连接关闭）时，被拒的卡同样结算为 Not run（D-P8-1 收尾 `34iSsJHzTeI5uzhcGSmlI`）：
回放停在 runner 的拒绝到达 CLI 之后（`HoldAfter`），用例是 `TestCursorRefusedToolCards` 的 `p8-refused-then-*`，
验收脚本是 [`scripts/test-cursor-refusal-settle.mjs`](../../../../../scripts/test-cursor-refusal-settle.mjs)。

来源与脱敏：
- 来源是 P8 证据里的 `recordings/acp-key-recorded.ndjson`，每行一个 `{t, pid, dir, msg}`，SHA256 `81e6ba97314c309eaf09db827bbdfa256dae3df8a9191f282ca6d8adae7b90c2`。
  按 `dir` 拆成 `stdin.jsonl`（`client->agent`）和 `stdout.jsonl`（`agent->client`），消息原样保留。
- P8 抽取时已把名字像密钥的环境变量值换成 `<redacted>`（`ORBIT_BG_TOKEN`），并屏蔽 Cursor key、JWT 和 bearer。
- 这次转换把 P8 的全栈目录 `/mnt/data/p8-cursor-e2e` 换成 `<RUN>`，UUID 换成 `<UUID_n>`（两个方向统一编号）。
- 转换后核对过：
  - 没有像 key、JWT、bearer、邮箱或长 base64 的串。
  - HPC 上的真实密钥一个都不在里面：Cursor API key、P8 runner 的 runner token、P8 所有者密码、P8 apiserver 的 JWT、provider 和 PG 密钥。
    比对用 `grep -c -F -f`，不打印密钥。
  - `ORBIT_SESSION_ID`、`ORBIT_AGENT_ID` 是 P8 本地全栈的公开 id，保留原值，同 P5c。
- 模型输出（正文、思考）是 Auto 模型的真实输出，原样保留。

真实 prompt：这两轮是 P8 的两次，记在 P8 的账本里。本目录的回放不发 prompt。
