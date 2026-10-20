# agy 1.4.3 实测脚本（2026-10-20）

[`docs/antigravity-runtime-contract.md`](../../antigravity-runtime-contract.md) §17 里每条【实测】结论用的实验。和 1.2.15、1.2.16
那两套一样是一次性的实验脚本，写死了 scratch 根目录 `/var/tmp/agy143-doc`（改 `drive.py`、`summarize.py`、`fakemcp.py` 里的路径即可），
不参与构建和测试；行为由 `src/runner-go/antigravity_contract_test.go`、`antigravity_approval_contract_test.go` 的契约测试兜底。

跑在 runner `workstation` 上的 `/root/.local/bin/agy`（`agy --version` 为 `1.4.3`，sha512 前缀 `746656e7164cacb4`）。每次启动都带
`AGY_CLI_DISABLE_AUTO_UPDATE=true`，HOME、`--gemini_dir` 和工作区都是每次新建的临时目录，外连全部经 mock 的代理拒绝。
按 owner 2026-10-20 的决定，这个二进制不改动、不替换、不降级：实验前后 sha512 相同。

## 准备两个 mock

```sh
cd src/runner-go
mkdir -p /var/tmp/agy143-doc/bin
go build -o /var/tmp/agy143-doc/bin/mockgemini ./testdata/mockgemini

# 不过滤参数的那一个：只给「带未声明参数的调用」那个场景用。复制 main.go，让 parseScript 在 MOCK_RAW_ARGS 非空时
# 照写原样发出剧本里的参数，而不是只留请求声明了的那些（declaredParams）。
mkdir -p /tmp/rawmock && cp testdata/mockgemini/main.go /tmp/rawmock/
sed -i 's/if params := declared\[name\]; params != nil {/if params := declared[name]; params != nil \&\& os.Getenv("MOCK_RAW_ARGS") == "" {/' /tmp/rawmock/main.go
printf 'module rawmock\n\ngo 1.24\n' > /tmp/rawmock/go.mod
(cd /tmp/rawmock && go build -o /var/tmp/agy143-doc/bin/mockgemini-raw .)
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `drive.py` | 实验驱动：起 mock，建临时 HOME、`--gemini_dir`、工作区（放一个 `seed.txt`），按参数写 hooks.json / mcp_config.json，发一条剧本消息、关 stdin、等 agy 退出；每个场景一个新的 `runs/<名字>/` 目录 |
| `hook.py` | 记录负载的 hook：PreToolUse 回 `{"decision":"allow"}`，PreInvocation 什么都不输出 |
| `fakemcp.py` | 最小的 stdio MCP 服务器，取自 [`../antigravity-cli-1.2.15/`](../antigravity-cli-1.2.15/)，只把日志路径改到 `/var/tmp/agy143-doc/runs` |
| `summarize.py` | 把一次运行缩成 §17 引用的事实：第一个带工具的请求里的函数声明（名字、属性、必填、`additionalProperties`）、`init.tools`、每个工具步骤、`result`、hook 调用、`/hooks` 列表、运行后的工作区 |
| `s-*.txt` | 各场景的剧本（`@WS@` 换成工作区路径） |
| `results/*.json` | `summarize.py` 的输出 |

## 场景

```sh
cd docs/evidence/antigravity-cli-1.4.3
python3 -I drive.py decls s-decls.txt
python3 -I drive.py tools s-tools.txt --hooks --print-hooks
python3 -I drive.py undeclared s-undeclared.txt --hooks --raw
python3 -I drive.py default-write s-default.txt --default-mode
python3 -I drive.py mcp s-mcp.txt --hooks --mcp
for r in decls tools undeclared default-write mcp; do python3 -I summarize.py $r > results/$r.json; done
```

| 场景 | 看什么 | 结论（§17） |
| --- | --- | --- |
| `decls` | 纯文本一轮，API key 模式下声明给模型的工具 | 12 个，全部 `additionalProperties: false`；文件工具是 `read_file`、`write_file`、`edit_file`，没有 `read_url_content`；`run_command` 只有 `CommandLine`、`IsDaemon`、`WaitMsBeforeAsync`、`toolSummary`；没有 `toolAction`；`init.tools` 仍是 60 个旧名字 |
| `tools` | skip 模式加 hook：`run_command`（`exit 3` 与成功各一次）、`read_file`、`write_file`、`edit_file`；`--print=/hooks` | 流和 hook 负载用新名字，流里只给 `CommandLine` / `Path`；输出前面多了 `Command exited with code N.` 和 `Command output:`；hook 负载与 PreInvocation 的键、`/hooks` 的 JSON 不变 |
| `undeclared` | 不过滤参数的 mock：带 `Cwd` 的 `run_command`、带 `toolAction` 的 `read_file`，再一条只带声明参数的 `run_command` | 前两条工具 `ERROR`（`additional properties '…' not allowed`），hook 只收到第三条，前两条的命令没执行（工作区里没有 `cwd.txt`）；没有输出的命令写 `No output from the command.` |
| `default-write` | 不加 skip，`write_file` 写工作区 | 软拒绝不变：`response` 为空，`denied_actions` 为 `{"action":"write_file","display_name":"WriteFile"}`，stderr 仍提示 `write_file(<target>)` |
| `mcp` | 配一个 MCP 服务器，`call_mcp_tool` 调一次 | 声明 15 个；`call_mcp_tool`、`list_resources`、`read_resource` 的参数不变，同样 `additionalProperties: false`；调用经过 hook |

`ORBIT_REQUIRE_REAL_AGY=1 go test -count=1 -run TestAntigravityContract .`（`src/runner-go`）同日在这个 agy 上 11 条全部通过。
