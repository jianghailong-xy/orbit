# P0.2 现有 Web 检查与包体积基线

源码起点：`f4d47e853877fdfddbb5cc7f15cace4d25e27b1e`。实际环境及原始 package/lock SHA-256 见 [environment.json](environment.json)。这是新增浏览器测试依赖前的现有 Web 检查；没有修改业务源码、Vitest 断言、超时或 worker 设置。现有脚本自带 `--maxWorkers=2`，现有 Vite 配置自带 30 秒测试超时。

## 可重复执行

从仓库根目录运行。需要 Node 26、npm 11 和可访问 npm registry 的网络；首次安装必须使用仓库锁文件。`--ignore-scripts` 足以准备本任务 Web/shared 构建和测试，不表示其他工作区不需要安装脚本。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build -w @orbit/shared
NO_COLOR=1 npm run build -w @orbit/web
NO_COLOR=1 npm run test -w @orbit/web
```

测试不要接管道；若要保存输出，将 stdout/stderr 重定向文件，并记录命令自身的退出码。Web build 包含 `tsc -b`；`src/web/tsconfig.json` 排除 `*.test.ts(x)`，因此构建通过不等于测试源文件单独类型检查通过。

## 安装证据

- [npm-ci.json](npm-ci.json)、[npm-ci.log](npm-ci.log)、[npm-ci.debug.log](npm-ci.debug.log)：第一次在网络受限沙箱执行，registry DNS 持续 `EAI_AGAIN`，人为中断，退出 130。这是环境准备失败，不是应用测试回归。
- [npm-ci-network.json](npm-ci-network.json)、[npm-ci-network.log](npm-ci-network.log)：允许外网访问后以同一锁文件重跑安装成功，退出 0，安装 770 个包。仅额外限制 fetch retry/timeout，没有替换依赖版本。
- [shared-build.json](shared-build.json)、[shared-build.log](shared-build.log)：在本工作树构建共享包，避免引用其他工作树旧产物。

## 构建与压缩体积

[web-build.json](web-build.json)、[web-build.log](web-build.log) 记录现有构建成功；Vite 原有大于 500 kB 的 chunk 提示保留，没有调高阈值或改拆包策略。计时是本机单次 wall-clock 观测，不作为跨机器性能阈值。

[bundle-size.json](bundle-size.json) 保存实际构建 JS/CSS 的逐文件原始字节数、gzip 字节数、SHA-256，以及生产 `dist/index.html` 直接引用的初始资源集合。初始集合包括 `script`、`stylesheet` 和 `modulepreload`；不能只数入口 `index-*.js` 而遗漏预加载 chunks。

| 口径 | JS 原始字节 | JS gzip 字节 | CSS 原始字节 | CSS gzip 字节 |
| --- | ---: | ---: | ---: | ---: |
| 初始 HTML 引用 | 3,141,917 | 955,947 | 357,333 | 58,590 |
| 全部构建产物 | 4,135,696 | 1,211,828 | 372,746 | 61,126 |

gzip 使用 Python `gzip.compress(bytes, compresslevel=9, mtime=0)` 分别压缩每个资源，统计的是单资源 gzip 大小之和。Vite 控制台的 gzip 算法默认值不同，不将其四舍五入显示值混入本表。网络传输和实际页面加载测量由浏览器证据另行记录，这里的 gzip 大小不是已配置服务器压缩的声明。

## 现有全量测试

实际结果：**287 个测试文件、3527 个测试全部通过，失败 0；Vitest 报告 174.47 秒**。没有观察到既存应用失败。结果、计时与退出码见 [web-test.json](web-test.json)，完整原始输出见 [web-test.log](web-test.log)。最终统计汇总在 [summary.json](summary.json)。本记录不把浏览器场景通过冒充单元测试通过，也不修复或隐藏原有失败。

## 浏览器性能测量（旧时钟方法，已由最终复跑取代）

本节保存早期试跑历史。后续复核发现 `page.clock.setFixedTime` 会替换原生 Performance Timeline 和帧调度；下面的 browser 毫秒统计已不作为最终有效基准，旧记录中“保持 performance.now、动画帧及浏览器计时真实”的声明不成立。修正依据见 [clock-method-correction.json](clock-method-correction.json)，最终数据及方法见 [P0.2 说明](../README.md#构建单测体积和性能)。

新增 [performance.browser.mjs](../../../../../src/web/ui-migration/performance.browser.mjs) 在 `chromium-light-desktop` 项目执行，其余项目跳过性能采样；不跳过对应的界面场景回归。它是正常 `test:ui-migration` 入口的一部分，也可单独复现：

```sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- performance.browser.mjs --project=chromium-light-desktop
```

环境准备和浏览器安装沿用 P0.2 顶层说明，入口的 `pretest:ui-migration` 现自动准备共享包和生产 Web 构建。当时的独立采样命令 **1 passed，18.5 秒，退出 0**。保存的 [performance.json](../performance.json) 包含每个样本、统计量、Navigation/Paint Timing 原始条目、视口与宿主负载。页面每次新建浏览器 context，每路由 5 次；输入和菜单操作各 10 次。当时使用 Playwright 时钟固定 `Date`；该方法同时替换了计时 API，因此本节的 browser 计时按旧方法证据保留，不作为原生基准。菜单开启除布局可见之外还等待所有祖先 `opacity: 1`，避免把弹层准备阶段当作已绘制。

| 测量（浏览器毫秒） | 样本数 | 中位数 | p95 |
| --- | ---: | ---: | ---: |
| 任务详情可见内容与字体 ready + 2 帧 | 5 | 475 | 494 |
| 项目图三个节点 ready + 2 帧 | 5 | 707 | 708 |
| 会话历史与输入 ready + 2 帧 | 5 | 420 | 430 |
| 输入填充、值/焦点确认 + 2 帧 | 10 | 43 | 63 |
| 附件菜单完成入场 + 2 帧 | 10 | 417 | 477 |
| 附件菜单关闭、输入恢复焦点 + 2 帧 | 10 | 347 | 353 |

p95 使用 nearest-rank，这里的 5/10 样本 p95 就是最大值。操作间隔包括 Playwright 通信、actionability、可见/入场状态轮询及两帧等待，不是孤立的 React 渲染耗时。路由拦截禁用 HTTP cache；浏览器进程、OS 文件缓存与本地服务器仍然共享。固定 REST/SSE fixtures 不代表真实后端或网络速度。宿主 24 CPU，采样前后 1 分钟 load average 为 7.9/9.14；没有据此设置不受数据支持的性能阈值。

[performance-checks.json](performance-checks.json) 和引用日志保留每次试跑：沙箱内预览服务器未启动；首次外部运行把带 `paper-clip` 图标的 menuitem accessible name 错认成精确 `File`；修正为 `/File$/` 后通过；最后补上祖先绘制状态等待再次通过。前面的部分/早期样本保留为 `performance-first-attempt.json`、`performance-before-painted-ready.json`，**当时作为候选基线的 `../performance.json` 已撤回性能解释，最终有效基线改为顶层 README 链接的原生计时附件**。这些是本次测试入口调试记录，不是应用既存失败，也没有通过放宽可见行为断言掩盖回归。
