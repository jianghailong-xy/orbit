# agy 1.2.15 实测脚本

[`docs/antigravity-runtime-contract.md`](../../antigravity-runtime-contract.md) 里每条【实测】结论用的工具。
都是一次性的实验脚本，写死了 scratch 根目录 `/var/tmp/agy-c0`（改 `ROOT` 即可），不参与构建和测试。

| 文件 | 作用 |
| --- | --- |
| `drive.py` | 实验驱动：起 [`mockgemini`](../../../src/runner-go/testdata/mockgemini)，建临时 HOME 和 `--gemini_dir`，按场景 JSON 的时间线写 stdin、发信号、等 `result`，带时间戳记下 stdout/stderr/进程树，结束时检查进程组残留和 HOME 下的新文件 |
| `gen_samples.py` | 录制并导出 [`src/runner-go/testdata/antigravity/`](../../../src/runner-go/testdata/antigravity) 的样本（路径做了规范化） |
| `fakemcp.py` | 最小 stdio MCP 服务器：记录启动环境和收到的每条消息，提供一个 `whoami` 工具 |
| `hook.py` | 通用 hook：记录 stdin 负载、进程组、环境变量，回固定的 `decision`，可选延迟（测超时） |
| `mitm.py` | 遥测取证用的 TLS 拦截代理：配合自签 CA 和 `SSL_CERT_FILE`，解开 agy 发往 `play.googleapis.com` 等主机的请求体，全部本地应答、不外发 |
| `permtab.py` | 把权限矩阵各次运行整理成"每个工具：步骤状态 / 拒绝 / 模型是否继续 / 副作用"的表 |

场景 JSON 的写法见 `drive.py` 文件头。
