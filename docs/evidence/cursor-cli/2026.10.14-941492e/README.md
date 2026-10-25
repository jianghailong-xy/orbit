# Cursor CLI 2026.10.14-941492e 实测录制（P0a，Linux）

结论见[运行时契约](../../../cursor-runtime-contract.md)，脚本和复现方法见 [`scripts/cursor-p0/`](../../../../scripts/cursor-p0/README.md)。

- 平台：HPC，linux/x64，内核 6.12.107+deb13-amd64，root。脚本用 Node v26.10.0，CLI 自带 Node v24.5.0。
- CLI：`2026.10.14-941492e`，tarball SHA-256 `6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d`。`index.js` 等哈希见 [`summary.json`](summary.json)。
- 凭据：所有者的 Cursor User API Key（Free 套餐个人账号，不属于团队，隐私模式 3）。key 和 token 不在任何文件里。
- 真实 prompt：20 次，都用 Auto 模型（[`prompts-ledger.json`](prompts-ledger.json)）。第 20 次碰到 Free 套餐的免费请求上限，之后的真实场景无法运行，见
  [`incidents/quota-exhausted/`](incidents/quota-exhausted/README.md)。
- 每个场景前后核对 runner 用户的真实 `~/.cursor`、`~/.config/cursor`、`~/.local/share/cursor-agent`：起步不存在，结束仍不存在（`summary.json` 的 `realCursorDirsBefore/After`）。

## 文件

| 路径 | 内容 |
| --- | --- |
| `scenarios/<名>.json` | 一个场景最近一次运行的结果：`runId`、时间、断言（`checks`）、数据（`detail`）、本场景花的真实 prompt、回放样本目录 |
| `protocol/<名>.ndjson` | 同一次运行的全部录制，按 `seq` 排序：`client->agent` / `agent->client`（JSON-RPC 原文）、`stderr`、`spawn`（argv、cwd、环境变量名）、`exit`、`signal`、`close-stdin`、`cli`（子命令的输出） |
| `analysis/<名>.json` | 运行期断言写错的场景的事后分析（契约 §17.2）：只读录制和运行目录，重新计算更正后的断言 |
| `incidents/` | 两份真实错误样本：额度用尽、模型提供方拒答（附崩溃后会话库的节选） |
| `exploration/` | 写脚本前的第一次真实 prompt，以及账本第 2、3 条的说明 |
| `prompts-ledger.json` | 真实 prompt 账本（时间、场景、一句话说明，不含 prompt 正文） |
| `summary.json` | 汇总：版本、哈希、平台、Orbit 提交、每个场景的结论（含 `current`、`postHocAnalysis`）、`allPassed` 和 `allPassedOrExplained` |
| `manifest.json` | 本目录每个文件的 SHA-256 |

脱敏规则（`scripts/cursor-p0/lib/redact.mjs`）：
- API key、JWT、token 字段、登录链接的 challenge/uuid、邮箱、账号身份字段（姓名、用户 id、auth id）一律替换。
- 运行目录、CLI 目录、脚本目录换成 `<RUN>`、`<CLI>`、`<SCRIPTS>`、`<P0_ROOT>`。
- UUID 换成同一场景内一致的 `<UUID_n>`。
- 模型的正文和思考是 Auto 模型的真实输出，原样保留。

## 场景结果（最近一次运行）

`summary.json` 是准确的清单。这里按类别说明：

- **不发 prompt 的场景**全部通过：`install-and-version`、`signed-out-handshake`、`api-key-session-management`、`parameterized-model-picker`、`credential-stores`、
  `directory-variables`、`failure-shapes-without-prompt`、`team-pin`、`mcp-and-hook-sources-at-startup`、`startup-processes-and-network`、
  `login-link-and-logout`、`usage-api`、`process-signals`、`debug-log-location`。
- **发 prompt、运行期断言就全部成立**：`cancel-mid-tool`、`prompt-while-busy`、`subagent-and-todos`。
- **发 prompt、运行期有断言写错**，更正后的断言见 `analysis/`：`multi-turn-tools-default`、`permission-force`、`permission-auto-review`、`plan-and-ask-modes-concurrent`、
  `ask-question`、`background-shell-and-commit`、`crash-recover-and-move`、`crash-continue-and-shell-wrapper`（旧场景定义）。
- **写好但没跑成**（额度用尽，契约 §17.1）：`crash-continue`、`shell-wrapper-env`、`repo-config-baseline`、`repo-config-with-flags`、`network-drop-mid-turn`、`login-account`。
