# 开发诊断原件

`history.tar.gz` 保留每次诊断的原始报告、环境、PNG 和测量 JSON，包括失败及主动中断的运行。压缩前后逐文件 SHA-256 校验通过；完整索引见 `index.json`。这些是开发记录，不作为最终全通过结论。

读取：`tar -xzf history.tar.gz -C /tmp/choice-diagnostics`（先创建目标目录）。最终矩阵与最终外观复核在相邻独立目录中直接保留，未用压缩包替代最终直接证据。
