# P0a：真 Cursor CLI 的 ACP 实测脚本（Linux）

固定 Cursor CLI `2026.10.14-941492e`（tarball SHA-256 `6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d`）。
结论和接口约定见[运行时契约](../../docs/cursor-runtime-contract.md)，录制和每个场景的断言见
[`docs/evidence/cursor-cli/2026.10.14-941492e/`](../../docs/evidence/cursor-cli/2026.10.14-941492e/)，
回放用的单进程样本见 [`src/runner-go/testdata/cursor/`](../../src/runner-go/testdata/cursor/)。

## 准备

1. 固定版本解包到 `/mnt/data/cursor-p0/cli/2026.10.14-941492e`（只读），tarball 放在 `/mnt/data/cursor-p0/dl/2026.10.14-941492e/`：

   ```sh
   V=2026.10.14-941492e; B=/mnt/data/cursor-p0
   mkdir -p $B/dl/$V $B/cli/$V.tmp && cd $B/dl/$V
   curl -fsSLO https://downloads.cursor.com/lab/$V/linux/x64/agent-cli-package.tar.gz
   echo "6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d  agent-cli-package.tar.gz" | sha256sum -c
   tar -xzf agent-cli-package.tar.gz -C $B/cli/$V.tmp && mv $B/cli/$V.tmp/dist-package $B/cli/$V && rmdir $B/cli/$V.tmp && chmod -R a-w $B/cli/$V
   ```

   位置可用 `CURSOR_P0_ROOT`、`CURSOR_P0_CLI` 改。脚本启动时核对 `--version`，不是固定版本就退出。
2. Cursor User API Key 放在 `/root/.config/orbit-secrets/cursor-api-key`（0600；`CURSOR_P0_KEY_FILE` 可改）。
3. 系统需要 Node 22.5+（用 `node:sqlite` 读会话库）、`git`、`strace`、`unshare`（root 或 user namespace）、`systemd-run`（可选）。

## 运行

在仓库根目录执行，重负载放进 systemd scope（runner 服务 OOMPolicy=stop，一个子进程 OOM 会停掉整个 runner）：

```sh
systemd-run --scope --quiet -p MemoryMax=6G node scripts/cursor-p0/reproduce.mjs --zero        # 不发 prompt 的场景
systemd-run --scope --quiet -p MemoryMax=6G node scripts/cursor-p0/reproduce.mjs --only cancel-mid-tool
systemd-run --scope --quiet -p MemoryMax=6G node scripts/cursor-p0/reproduce.mjs              # 全部场景
node scripts/cursor-p0/reproduce.mjs --list                                                    # 场景名和各自花几次真实 prompt
node scripts/cursor-p0/reproduce.mjs --selftest                                                # 只用假 agent 检查脚本流程，不发真实 prompt
```

退出码非零表示：选中的场景有断言失败、固定版本不对、缺 key、或者这次选择会超出真实 prompt 预算。

## 真实 prompt 预算

真实 prompt 消耗所有者的 Cursor 额度。脚本只用 Auto 模型（`default[]`），每次发送前先在
`/mnt/data/cursor-p0/ledger/prompts.jsonl` 记账，累计到 30 次就拒绝再发。
全量运行要发 `--list` 列出的次数（目前 19 次）。账本跨运行累计，所以一个任务里不能把全量跑两遍。
已提交的证据是分批运行同一脚本的结果。每个场景的 `runId` 和 `finishedAt` 记在 `summary.json` 里，账本副本在
`prompts-ledger.json`。`--selftest` 换成 [`selftest-fake-agent.mjs`](selftest-fake-agent.mjs)，从不记账、从不写证据目录，
只用来在改脚本后先检查控制流程。

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
| `selftest-fake-agent.mjs` | 只给 `--selftest` 用的假 agent，不是证据 |
