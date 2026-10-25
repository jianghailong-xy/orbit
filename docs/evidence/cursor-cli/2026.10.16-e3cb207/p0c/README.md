# Cursor CLI 2026.10.16-e3cb207 的零 prompt 录制（P0c，只用于对比）

项目固定的仍是 `2026.10.14-941492e`。这里是官方安装脚本 2026-10-17 给出的新版，在 HPC 上用同一套脚本跑的不花 prompt 的 14 个场景，
用来和固定版本对比。结论写在[运行时契约](../../../../cursor-runtime-contract.md) §1.3。

- tarball：`https://downloads.cursor.com/lab/2026.10.16-e3cb207/linux/x64/agent-cli-package.tar.gz`，183,721,050 字节，
  SHA-256 `3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552`（下载时算的，官方不公布）。
- 运行：2026-10-17，`CURSOR_P0_VERSION=2026.10.16-e3cb207 CURSOR_P0_TARBALL_SHA256=<上面的哈希> node scripts/cursor-p0/reproduce.mjs --zero`。
  脚本对非固定版本拒绝发真实 prompt；回放样本留在运行目录，没有提交。
- 结果：14 个场景 13 个通过。`api-key-session-management` 有一条断言不成立：`session/new` 不带 `mcpServers` 时回的是
  `-32602`（zod 4 的错误格式），不是固定版本的 `-32603`。
- [`comparison.json`](comparison.json)：`scripts/cursor-p0/compare-builds.mjs` 生成，逐场景列出不同的断言和记录（已去掉每次运行都会变的时间、大小、
  pid、id 编号和版本字符串），以及两个包的逐文件对比和 `agent acp` 加载的分块。固定版本一侧是
  [`../../2026.10.14-941492e/p0c/`](../../2026.10.14-941492e/p0c/README.md) 的同名场景。

```sh
node scripts/cursor-p0/compare-builds.mjs docs/evidence/cursor-cli/2026.10.14-941492e/p0c docs/evidence/cursor-cli/2026.10.16-e3cb207/p0c \
  docs/evidence/cursor-cli/2026.10.16-e3cb207/p0c/comparison.json --cli-a /mnt/data/cursor-p0/cli/2026.10.14-941492e --cli-b /mnt/data/cursor-p0/cli/2026.10.16-e3cb207
```
