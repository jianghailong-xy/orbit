# Cursor CLI 2026.10.14-941492e 补测录制（P0c，Linux）

P0a 撞上 Free 套餐上限后没跑成的真实 prompt 场景，以及不花 prompt 的全套场景重跑。结论写进[运行时契约](../../../../cursor-runtime-contract.md)，
P0a 的录制在上一级目录，原样不动。脚本和复现方法见 [`scripts/cursor-p0/`](../../../../../scripts/cursor-p0/README.md)。

- 时间：2026-10-17 01:55–02:33 UTC。平台同 P0a：HPC，linux/x64，内核 6.12.107+deb13-amd64，root；脚本 Node v26.10.0。
- CLI：固定版本 `2026.10.14-941492e`（tarball SHA-256 `6f6bf39d…62bb2d`，`summary.json` 的 `cli`）。
- 凭据：同一把 Cursor User API Key。所有者 2026-10-17 已把账号升级为付费套餐：`GetPlanInfo` 返回 `planName: "Premium"`，
  包含用量按周计（`includedUsagePeriod: INCLUDED_USAGE_PERIOD_WEEKLY`）。个人账号，不属于团队，隐私模式 3。key 和 token 不在任何文件里。
- 真实 prompt：**7 次**，都用 Auto 模型，记在 P0c 自己的账本 `/mnt/data/cursor-p0/ledger/p0c-prompts.jsonl`（上限 10），
  副本是 [`prompts-ledger.json`](prompts-ledger.json)。P0a 的 20 次在 `prompts.jsonl`，两本账不混。
- 回放样本在 [`src/runner-go/testdata/cursor/p0c/`](../../../../../src/runner-go/testdata/cursor/p0c/)，只收发真实 prompt 的场景；
  不花 prompt 的场景和 P0a 的样本重复，样本留在运行目录，没有提交。
- 每个场景前后核对 runner 用户真实的 `~/.cursor`、`~/.config/cursor`、`~/.local/share/cursor-agent`：起步不存在，结束仍不存在。

## 场景结果

`summary.json` 是准确的清单。全部 21 个场景通过（7 个发真实 prompt，14 个不发），没有事后分析。

| 场景 | 真实 prompt | 结论（契约章节） |
| --- | --- | --- |
| `shell-wrapper-env` | 1 | D4 方案 A 成立：CLI 用 P3 的 orbit-bash 跑环境快照和每条命令，命令看到真 HOME、看不到 key 和 token（§8.4） |
| `repo-config-baseline` | 1 | 仓库 `.cursor/cli.json` 在运行期放宽白名单；运行的 hook、加载的规则和 MCP 来源（§7.2） |
| `repo-config-with-flags` | 1 | `--disable-project-configs` 让 cli.json 失效，其余不变；`--exclude-workspace-context` 没有可见效果（§2.1、§7.2） |
| `network-drop-mid-turn` | 1 | 轮中断网 6 ms 后以 `"\n\nError: RetriableError: [canceled] …"` 加 `end_turn` 结束，不重试（§12） |
| `background-shell-and-commit` | 1 | 提交没有 trailer；后台命令的工具卡立刻 `completed`，prompt 不等它，结束后不开新一轮（§3.2、§14.4） |
| `ask-question` | 1 | agent 模式不给 AskQuestion（§4.2） |
| `ask-question-plan-mode` | 1 | plan 模式也不给，尽管 plan 模式的提示要求用 AskQuestion 提问（§4.2） |
| 不花 prompt 的 14 个场景 | 0 | 固定版本在付费套餐下全部照旧；也是和新版 `2026.10.16-e3cb207` 对比的基线（§1.3） |

另有两份事后计算，只读已提交的录制：

- [`analysis/turn-endings.json`](analysis/turn-endings.json)：P0a 和 P0c 全部 27 轮的结束形状，以及 P5b 的 `cursorTurnFailure`
  （`src/runner-go/cursor_events.go`）对每轮最后一个正文块的判定：只有额度用尽、断网、模型拒答这 3 轮判为失败，其余 24 轮都不是。
  另列出不属于任何一轮的更新：只有 `available_commands_update`、`current_mode_update`、`session_info_update`（契约 §3.2、§12）。
- [`analysis/usage-before-prompts.json`](analysis/usage-before-prompts.json)：发出第一次 P0c prompt 前读的用量；发完 7 次后的读数在
  `scenarios/usage-api.json`（契约 §11）。

复现：

```sh
node scripts/cursor-p0/reproduce.mjs --only shell-wrapper-env,repo-config-baseline,repo-config-with-flags,network-drop-mid-turn,background-shell-and-commit,ask-question,ask-question-plan-mode
node scripts/cursor-p0/reproduce.mjs --zero --fixtures /mnt/data/cursor-p0/p0c/fixtures-zero-2026.10.14-941492e
node scripts/cursor-p0/turn-endings.mjs <out.json> docs/evidence/cursor-cli/2026.10.14-941492e/protocol/*.ndjson docs/evidence/cursor-cli/2026.10.14-941492e/p0c/protocol/*.ndjson \
  docs/evidence/cursor-cli/2026.10.14-941492e/incidents/provider-refusal-after-crash/protocol.ndjson docs/evidence/cursor-cli/2026.10.14-941492e/exploration/explore5-protocol.ndjson
```

`cursorTurnFailure` 的判定在 runner-go 的临时副本里跑（`git archive <commit> src/runner-go`，加一个只读 `turn-endings.json` 的测试，打印每轮的判定，
再用 `turn-endings.mjs … --classified <测试输出>` 并回文件），产品代码没有改动；测试源码和所用提交记在 `analysis/turn-endings.json` 的 `classifier` 字段。

## 文件

格式同 P0a（见[上一级 README](../README.md)）：`scenarios/<名>.json`、`protocol/<名>.ndjson`、`summary.json`（多了 `ledger`、
`realPromptsInTheseResults`）、`prompts-ledger.json`（多了 `ledger`、`task`）、`manifest.json`。
