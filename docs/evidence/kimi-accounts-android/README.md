# Kimi Code 多账号 · Android：模拟器截图对照设计图

任务「Android：Kimi 多账号」（34cM1TWs2GauSxhcFWnCS）。设计图：`docs/mocks/kimi-accounts/02-ios.png` 及其中的 Android 说明；
owner 2026-10-08 的三处决定：月度只画一条（总额）、引擎页四个引擎都标 NEXT、Android 补 Kimi 站点选择。

## 对照图

| 文件 | 内容 |
| --- | --- |
| `compare-1-site.png` | Kimi 先选站点：单账号的 Sign In Again（Current 是该账号自己的站点）、Add Account 先起名（Account 2）再选站点、设备码一步写站点、Use … instead、Work 的 Sign In Again（Current kimi.com）、旧 runner（区名 Sign-In、没有 Add Account，kimi.ai 被服务端拒绝并提示升级） |
| `compare-2-accounts.png` | 两个账号的站点和额度：每行「站点 · 目录」，每个账号三条额度（5h limit / Weekly limit / Monthly limit，月度只画总额），Work 的 5 小时 91% 变橙；运行器页 Kimi 行单账号写站点，两个账号写「2 accounts signed in」+「Next: Default」+ 一条额度 |
| `compare-3-next.png` | 引擎页 NEXT 标记：Kimi Code、Claude Code、Codex、Antigravity 四个引擎同一规则（与账号池行同一个 `Chip("NEXT")`），只有一个账号时没有 |

左边是设计图的帧（02-ios 原图裁切；NEXT 一组用 01-web 的那一帧，因为 02-ios 画于 owner 定下引擎页标 NEXT 之前），
右边是 Android 模拟器上的真实界面。其余 PNG 是对照图用到的模拟器截图，缩到 540 px 宽。

## 截图怎么来的

- 测试：`src/android/app/src/androidTest/kotlin/io/orbitd/android/management/ManagementDeviceTest.kt`
  `kimiAccountsSiteFirstTwoAccountsAndNext`——真实 App 外壳，接口是 instrumentation 里的 MockWebServer（受控 HTTP），
  runner 数据照设计图里的 HPC：Default 在 kimi.ai，Work 在 kimi.com、5 小时用到 91%。
- 设备：共享模拟器 emulator-5554，Android 16（API 36），1080×2400，420 dpi，字体 1.0，浅色。
- 这一轮：源码提交 2cd62d5a7（本功能的提交），2026-10-08 16:33–16:34Z，`OK (1 test)`；
  app-debug.apk sha256 `b05880689de04c70b524ff99634a95f10f80a17faeeb4d49790afbe69cf5f967`，
  app-debug-androidTest.apk sha256 `4d77df187aab5a22369eee9849ff85c4f6d64d4579a8579164b9f3809d3402d8`。
- 对照图由同目录的 `compare.py` 生成（`python3 -I compare.py <仓库> <截图目录> <输出目录>`，需要文泉驿正黑字体）。
- 时间相关的字（Resets …）随截图时刻不同；加账号那一帧用预填的名字 Account 2（在模拟器上聚焦输入框会弹出输入法的手写引导，
  盖住页面；起名后再选站点由单元测试 `RunnerEnginePageTest.kimiAddAccountTakesANameThenAsksTheSite` 覆盖）。
- 不是部署环境或真实 runner 的结果；会话里「Model and account」对话框的 Kimi 账号由单元测试 `ComposerAccountsTest` 覆盖，没有截图。
