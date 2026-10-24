# P0：真 Cursor CLI 的 ACP 实测脚本（Linux + macOS）

固定 Cursor CLI `2026.10.14-941492e`（Linux x64 tarball SHA-256 `6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d`，
macOS arm64 tarball SHA-256 `c6d9e2eaa1b1e24221517e0b4206b1f1593792e6f0d8a52e9b507bbe7ab0cc77`，P0b 在 orbit-macos 上测得）。
结论和接口约定见[运行时契约](../../docs/cursor-runtime-contract.md)，录制和每个场景的断言见
[`docs/evidence/cursor-cli/2026.10.14-941492e/`](../../docs/evidence/cursor-cli/2026.10.14-941492e/)（P0a）和其下的 `p0c/`（P0c），以及
[`docs/evidence/cursor-cli/macos-2026.10.14-941492e/`](../../docs/evidence/cursor-cli/macos-2026.10.14-941492e/)（P0b，macOS），
回放用的单进程样本见 [`src/runner-go/testdata/cursor/`](../../src/runner-go/testdata/cursor/)（P0c 的在其下 `p0c/`）。

## 准备

1. 固定版本解包到 `/mnt/data/cursor-p0/cli/2026.10.14-941492e`（只读），tarball 放在 `/mnt/data/cursor-p0/dl/2026.10.14-941492e/`：

   ```sh
   V=2026.10.14-941492e; B=/mnt/data/cursor-p0
   mkdir -p $B/dl/$V $B/cli/$V.tmp && cd $B/dl/$V
   curl -fsSLO https://downloads.cursor.com/lab/$V/linux/x64/agent-cli-package.tar.gz
   echo "6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d  agent-cli-package.tar.gz" | sha256sum -c
   tar -xzf agent-cli-package.tar.gz -C $B/cli/$V.tmp && mv $B/cli/$V.tmp/dist-package $B/cli/$V && rmdir $B/cli/$V.tmp && chmod -R a-w $B/cli/$V
   ```

   位置可用 `CURSOR_P0_ROOT`、`CURSOR_P0_CLI` 改。脚本启动时核对 `--version`，不是要测的版本（默认是固定版本）就退出。

   macOS（darwin/arm64）同样步骤，URL 换成 `…/darwin/arm64/agent-cli-package.tar.gz`，哈希见上。

2. Cursor User API Key 放在 `<home>/.config/orbit-secrets/cursor-api-key`（0600；`CURSOR_P0_KEY_FILE` 可改）。
   没有 key 时用 `--no-key-ok` 只跑 `needsKey:false` 的场景，需要 key 的被跳过并计入非零退出码。
3. 系统需要 Node 22.5+（用 `node:sqlite` 读会话库）、`git`。Linux 另需 `strace`、`unshare`（root 或 user namespace）、`systemd-run`（可选）。
   macOS 没有 strace/unshare：相关断言以「skipped」记录，`startup-processes-and-network` 改读 worker 日志和 netlog。

## 运行

在仓库根目录执行（Linux 重负载放进 systemd scope；macOS 直接跑）：

```sh
systemd-run --scope --quiet -p MemoryMax=6G node scripts/cursor-p0/reproduce.mjs --zero        # 不发 prompt 的场景
systemd-run --scope --quiet -p MemoryMax=6G node scripts/cursor-p0/reproduce.mjs --only cancel-mid-tool
systemd-run --scope --quiet -p MemoryMax=6G node scripts/cursor-p0/reproduce.mjs              # 全部场景
node scripts/cursor-p0/reproduce.mjs --list                                                    # 场景名和各自花几次真实 prompt
node scripts/cursor-p0/reproduce.mjs --selftest                                                # 只用假 agent 检查脚本流程，不发真实 prompt
node scripts/cursor-p0/reproduce.mjs --no-key-ok --only <无 key 也能跑的场景>                  # key 还没到时（macOS）
```

退出码非零表示：选中的场景有断言失败、固定版本不对、缺 key（或跳过）、或者这次选择会超出真实 prompt 预算。

macOS 专属场景：`macos-keychain-store`（Keychain 条目名与不变性）、`macos-quarantine`（quarantine 属性）、
`macos-launchd-keychain`（launchd Aqua 会话里的 Keychain 行为）。`macos-keychain-store` 会短暂读写真实 HOME 的
`~/.cursor`（keychain 按 HOME 解析）并在场景内恢复原状。

## 真实 prompt 预算

真实 prompt 消耗所有者的 Cursor 额度。脚本只用 Auto 模型（`default[]`），只对固定版本发，每次发送前先记账，到上限就拒绝再发。
每个任务一本账，用 `CURSOR_P0_LEDGER` 选（默认是当前任务的）：

| 账本 | 文件（`/mnt/data/cursor-p0/ledger/`） | 上限 | 证据目录 | 回放样本目录 |
| --- | --- | --- | --- | --- |
| `p0a` | `prompts.jsonl` | 30 | `docs/evidence/cursor-cli/<版本>/` | `src/runner-go/testdata/cursor/` |
| `p0b` | `p0b-prompts.jsonl` | 30 | `docs/evidence/cursor-cli/macos-<版本>/`（`--out` 指定） | 无（P0b 未发 prompt） |
| `p0c`（默认） | `p0c-prompts.jsonl` | 10 | `docs/evidence/cursor-cli/<版本>/p0c/` | `src/runner-go/testdata/cursor/p0c/` |
| `p0bm`（P0b 跟进，macOS） | `p0bm-prompts.jsonl` | 10 | `docs/evidence/cursor-cli/macos-<版本>/`（`--out` 指定） | `/mnt/data/cursor-p0/macos-fixtures/`（`--fixtures` 指定） |

- 每本账的运行写进自己的目录，后一个任务不会盖掉前一个任务的录制。证据目录的 `prompts-ledger.json` 记着它属于哪本账，
  拿别的账本往里写时脚本直接拒绝；只有零 prompt 运行的目录没有这个文件。
- `--list` 列出每个场景花几次真实 prompt（全部加起来 21 次，含只在需要时才跑的 `ask-question-plan-mode` 和两个单参数的 `repo-config-*`）。
  账本跨运行累计，所以一个任务里不能把全量跑两遍。已提交的证据是分批运行同一脚本的结果，每个场景的 `runId` 和 `finishedAt` 记在 `summary.json` 里。
- `--selftest` 换成 [`selftest-fake-agent.mjs`](selftest-fake-agent.mjs)，从不记账、从不写证据目录，只用来在改脚本后先检查控制流程。

## 对比另一个版本

`CURSOR_P0_VERSION=<版本> CURSOR_P0_TARBALL_SHA256=<哈希>` 让脚本改用 `/mnt/data/cursor-p0/cli/<版本>`（同样解包、只读）。
这时只能跑 `--zero`：脚本拒绝对非固定版本发真实 prompt。回放样本默认写到 `/mnt/data/cursor-p0/fixtures/<版本>/`，不进仓库。
[`compare-builds.mjs`](compare-builds.mjs) 比较两个证据目录（以及可选的两个解包目录），写出 `comparison.json`，见契约 §1.3。

## 事后分析

- [`analyze.mjs`](analyze.mjs)：P0a 运行期断言写错的场景，重新计算更正后的断言（契约 §17.2）。
- [`turn-endings.mjs`](turn-endings.mjs)：从录制里取出每一轮的结束形状和不属于任何一轮的更新；`--classified` 并入 P5b 的 `cursorTurnFailure`
  对这些轮的判定（做法见 `docs/evidence/cursor-cli/2026.10.14-941492e/p0c/README.md`）。

## 隔离与脱敏

- 每个 CLI 进程都用 `env -i` 式白名单环境，只带脚本列出的变量（`lib/env.mjs`）。HOME、CURSOR_CONFIG_DIR、CURSOR_DATA_DIR、
  XDG_* 都指向 `/mnt/data/cursor-p0/runs/<runId>/<场景>/slots/<槽>/` 下的目录。每个场景前后核对 runner 用户真实的 `~/.cursor`、
  `~/.config/cursor`、`~/.local/share/cursor-agent` 的指纹，有变化就判失败。
- 录制写出前统一脱敏（`lib/redact.mjs`）：API key、JWT、token 字段、登录链接的 challenge/uuid、邮箱一律替换；运行目录、
  CLI 目录、脚本目录换成 `<RUN>`、`<CLI>`、`<SCRIPTS>`；UUID 换成同一场景内一致的 `<UUID_n>`。
- `lib/netlog.cjs` 只在 `startup-processes-and-network` 场景用 `NODE_OPTIONS=--require` 预加载，记录每个出站请求的主机和路径（丢弃查询参数的值），
  不记请求头和正文。它看不到 CLI 自带 undici 发的请求（登录轮询、API key 换 token）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `reproduce.mjs` | 入口：选场景、跑、写 `scenarios/<名>.json`、`protocol/<名>.ndjson`、`summary.json`、`manifest.json`、`prompts-ledger.json` |
| `lib/acp.mjs` | stdio JSON-RPC 客户端：记录双向每一行、server→client 请求的应答策略 |
| `lib/harness.mjs` | 场景上下文：槽目录、进程、真实 prompt 记账、会话库读取、断言 |
| `lib/env.mjs` | 固定版本、白名单环境、prompt 账本 |
| `lib/proxy.mjs` | 记录 CONNECT 隧道（主机、字节数）的代理，可模拟断网 |
| `lib/fixture.mjs` | 夹具仓库：各配置文件带暗号，各执行点调用标记脚本 |
| `lib/record.mjs` | 写录制和回放样本 |
| `test-mcp.mjs` | stdio MCP 测试服务器：`record`（有副作用）、`echo` |
| `scenarios/zero-*.mjs` | 不发 prompt 的场景 |
| `scenarios/real.mjs` | 发真实 prompt 的场景 |
| `scenarios/macos.mjs` | darwin 专属场景：Keychain 条目与 launchd 行为、quarantine |
| `probe/` | P0b 的手工探针（dummy 凭据，非场景断言），支撑契约 §18.3/§18.4 |
| `selftest-fake-agent.mjs` | 只给 `--selftest` 用的假 agent，不是证据 |
| `compare-builds.mjs` | 两个版本同名场景的对比 |
| `turn-endings.mjs` | 每一轮怎么结束、轮外有哪些更新 |
