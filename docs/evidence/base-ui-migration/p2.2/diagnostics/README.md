# 开发诊断原件

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.2/diagnostics/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.2/diagnostics | tar -x -C <空目录>`。
>
> 本目录在瘦身中：2 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 1 个 trace 压缩包；删除被取代修订的 201 个原始运行文件（截图、逐用例 JSON、运行压缩包）。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 本目录是第 1 版（判定 SEND_BACK）的诊断。被采用的是[第 8 版](../revision-8/README.md)，这里的截图、逐用例 JSON 和 history.tar.gz 已删除。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

`history.tar.gz` 保留每次诊断的原始报告、环境、PNG 和测量 JSON，包括失败及主动中断的运行。压缩前后逐文件 SHA-256 校验通过；完整索引见 `index.json`。这些是开发记录，不作为最终全通过结论。

读取：`tar -xzf history.tar.gz -C /tmp/choice-diagnostics`（先创建目标目录）。最终矩阵与最终外观复核在相邻独立目录中直接保留，未用压缩包替代最终直接证据。
