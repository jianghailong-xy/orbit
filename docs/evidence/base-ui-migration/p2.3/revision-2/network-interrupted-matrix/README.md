# 提交上首次矩阵的环境故障与归档缺口

源码为 `ef1d367341a1ac080b74c323c0bf104bfc140cb6`。完整命令结果为207通过、1失败；失败发生在 Chromium 明色手机场景的第一个 Complete session 点击前，尚未开始悬停或计时交互。

- [完整原始命令输出](../checks/committed-notification-matrix.txt)
- [命令、退出码和源码提交](../checks/committed-notification-matrix.json)
- [从trace提取的6条ERR_NETWORK_CHANGED及原trace SHA-256](../network-load-diagnostic.json)

归档缺口：第1版 collect.py 明确拒收非全绿报告，本次调用被该保护阻止。执行者随后启动原样复跑，Playwright清理临时结果目录，因此这一轮 report.json 和 trace.zip 未能留存。没有伪造替代报告，也不声称该轮通过。上面的完整命令日志、原生错误文本和已提取的console事件仍然存在；其它修复前失败的归档保持原样。

后续在同一提交、同一命令、原超时和断言上重跑。最终验证以 `../toasts-run/` 中单独归档的完整结果为准，不合并或修改原报告。
