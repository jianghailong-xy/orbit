# P2 集成修复：紧凑决策卡片的 Web 集成回归

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2-integration-cards/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2-integration-cards | tar -x -C <空目录>`。
>
> 本目录在瘦身中：2 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 7 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../evidence-slimming/README.md)。

服务于 [紧凑决策卡片引入后的 Web 集成回归修复](orbit-task:34a0sy3NmYy7MLbOcqhkW)。本目录原来没有 README，结论和检查记录在 [summary.json](summary.json)、[review.json](review.json) 与 [failure-map.json](failure-map.json)。
