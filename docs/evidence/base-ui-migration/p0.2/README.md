# P0.2 视觉、行为与性能基线

本目录服务于 [P0.2 固化视觉、行为与性能基线](orbit-task:34Za38vNhaO1g44eCoRzl)，承接 [P0.1 清单与依赖审计](../README.md)。项目 P0 验收原文：**P0：迁移清单和现有视觉、行为基线可复现，所有 AntD 使用点均有迁移归属。** 本次建立现有界面的浏览器证据与后续 P7 可运行入口；未实施组件迁移、部署或发布。

检查起点为 `f4d47e853877fdfddbb5cc7f15cace4d25e27b1e`。页面使用实际生产构建、路由、组件和 CSS，只有网络数据、登录状态与时间由测试固定。新的 `npm run test:ui-migration -w @orbit/web` 在本任务新增，不能视为 P0.1 时已存在的命令。后续迁移每一批公共组件与页面时，须同步维护该页面的场景、控件行为和直接证据。

## 环境与复跑

从仓库根目录运行。基线环境为 Linux x86_64、Debian GNU/Linux 13（记录的 `DEBIAN_VERSION_FULL=13.7`）、Node `v26.10.0`、npm `11.19.1`、Playwright **1.63.0**。该 Playwright 版本锁定 Chromium/Headless Shell revision **1243**（153.0.8010.12）及 WebKit revision **2359**（26.6）。不要改用系统 Chrome 或本机 Safari 去比较 Linux 基线。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm exec -w @orbit/web -- playwright install --with-deps chromium webkit
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
```

安装需要 npm registry、Playwright 浏览器下载和系统包源可达；`--with-deps` 在 Linux 安装浏览器系统依赖，可能需要系统包安装权限。运行需要启动本地预览服务器和浏览器的权限。网络受限沙箱中的 DNS/监听失败不能算作组件回归；本次真实失败及恢复记录保存在 [existing-checks](existing-checks/README.md)。`--ignore-scripts` 已用于本任务 Web/shared 的干净安装，不表示其他工作区不需要安装脚本。

普通入口的 `pretest:ui-migration` 自动执行共享包构建和 Web 的 `tsc -b && vite build`，然后使用本地生产预览 `127.0.0.1:4173`。无需 API 服务、数据库、生产账号或启动开发模式。端口必须空闲；配置禁止复用未知来源的服务器。源码见 [package.json](../../../../src/web/package.json) 与 [playwright.config.mjs](../../../../src/web/ui-migration/playwright.config.mjs)。

[environment.mjs](../../../../src/web/ui-migration/environment.mjs) 每次读取 OS、Playwright 浏览器清单、`fc-list` 返回的字体文件路径及 SHA-256，写入 `src/web/.ui-migration-results/environment.json`，并与本目录的固定环境记录逐字段比较。字体不只看 CSS 的 `font-family` 字符串；相同 family 在不同系统可能实际使用不同字体。系统字体/渲染库版本线索见 [system-packages.txt](system-packages.txt)，包括 DejaVu、Liberation、FreeFont、IPA Gothic、Loma、Unifont、Noto Color Emoji 和文泉驿正黑。该列表中空版本表示查询到的包名没有已安装版本，不应照单全部安装。应复现记录的字体文件集合与字节哈希，不能为了通过检查覆盖环境记录或截图。仅安装同名字体但版本不同，不保证像素一致。

单独调试和保存新一次结果：

```sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- pages.browser.mjs --project=chromium-light-phone
NO_COLOR=1 npm run test:ui-migration -w @orbit/web -- performance.browser.mjs --project=chromium-light-desktop
node src/web/ui-migration/collect-evidence.mjs /tmp/orbit-ui-migration-review
```

最后一条的目标目录必须尚不存在。它从最近一次运行收集 JSON 附件、报告和截图哈希；存在意外失败时拒绝收集为通过记录。每次 Playwright 运行会重建 `src/web/.ui-migration-results`，需要保留的输出必须先存入新目录。不能用一次筛选运行的输出声称全矩阵通过。

## 固定内容与场景矩阵

[fixtures.mjs](../../../../src/web/ui-migration/fixtures.mjs) 与 [session-fixtures.mjs](../../../../src/web/ui-migration/session-fixtures.mjs) 提供公开的合成 REST 数据、稳定 ID、头像缺省、固定列表顺序和账号偏好；不含生产个人数据。时间固定为 `2026-09-28T12:00:00.000Z`，locale 为 `en-US`、时区 `UTC`。`Date` 固定但 `performance.now` 与动画帧继续真实运行。会话的历史正文、增量分片、最终正文、turn end 和受控发送错误均固定。通过 `installFixedDate` 只代理原生 `Date` 的无参数构造、函数调用与 `now()`，不替换定时器、动画帧或 Performance Timeline。每页 context 隔离；未明确建模的 API 请求，包括写请求，会返回 501 并使 fixture 校验失败。

矩阵为 **Chromium/WebKit × light/dark × desktop/phone** 共 8 个项目。桌面视口 `1280×900`，手机视口 `390×844`，DPR 均为 **1**，`visualViewport.scale` 必须为 **1**。手机项目启用触摸与 mobile context；使用浏览器 context 的真实 CSS 视口，不依赖 headless 窗口最小宽度。截图前验证主题、宽度、DPR 和缩放。`reducedMotion: reduce`、locale、时区与 Service Worker 禁用均写入配置。

| 页面/状态 | 可见行为与直接证据 |
| --- | --- |
| 任务详情、公开分享 | 标题/描述/标签/评论、按钮 hover/focus、动作菜单、分享弹窗、公开链接、弹窗内 Tab 焦点与关闭 |
| 项目列表、项目图 | 列表搜索与无匹配结果、固定加载/错误及重试、概览、三个节点的依赖图、图全屏弹窗与 Escape |
| 会话输入、附件 | 固定历史和流式正文、输入焦点、多行文本、附件菜单顺序、真实 file chooser 暂存/移除固定文件 |
| 通知 | 真实发送动作收到受控服务错误后出现通知；错误内容、复制按钮、关闭行为与弹层绘制状态 |
| Wiki | 目录/卡片、新建条目弹窗、窄屏 Contents 入口及关闭 |
| 设置、账号 | 主题控件、开关/选择框、保存反馈、禁用/启用 Save、姓名保存、密码字段校验错误 |

本任务没有新增生产 AntD 使用点。新增测试的内部选择器仅用于测量现有外观，迁移归属如下：任务的 `.ant-btn`/`.ant-select` 和分享弹窗表面归 P3.2；设置/账号的 `.ant-card`/`.ant-select`/`.ant-segmented`/`.ant-form-item-*` 归 P4.1；项目图/Wiki 弹窗的 `.ant-modal-container` 分别归 P4.3/P4.4，公共弹窗替代能力由 P2 提供。会话测量定位随 P5 维护。P6 清理时须同时检查 `ui-migration` 测试目录，不能只扫生产 `src`。场景实现见 [pages.browser.mjs](../../../../src/web/ui-migration/pages.browser.mjs)、[page-scenarios.mjs](../../../../src/web/ui-migration/page-scenarios.mjs)、[session-scenarios.mjs](../../../../src/web/ui-migration/session-scenarios.mjs) 和 [states.browser.mjs](../../../../src/web/ui-migration/states.browser.mjs)。图标参与部分控件的 accessible name，例如菜单项实际为 `paper-clip File`；行为定位依据可见角色/名称，不删图标、不改业务以适应测试。

[breakpoints.browser.mjs](../../../../src/web/ui-migration/breakpoints.browser.mjs) 在两个浏览器、两个主题下探测既有 **600/640/960px** 断点两侧：`599/601` 拍摄分享页和分享弹窗，`639/641` 拍摄项目列表与图，`959/961` 拍摄 Wiki 与会话。边界探测用桌面指针、高度 900；390px 项目另测手机触摸环境。它覆盖这些规则的代表页面，不声称每个页面都在每个边界宽度组合上穷举。

## 截图、计算样式与字形

真实页面 PNG 存放在 [screenshots](screenshots/)，按浏览器、主题和尺寸分目录。[harness.mjs](../../../../src/web/ui-migration/harness.mjs) 等待字体就绪、目标内容可见及弹层祖先完成透明度入场，再执行截图断言。截图只统一关闭动画、隐藏文本光标并使用 CSS 像素；没有蒙版、替代组件或注入 CSS 去修改页面外观。

默认 `updateSnapshots: 'none'`、`maxDiffPixels: 0`，缺失或不匹配都失败。初次制作这份尚不存在的基线使用过显式 `--update-snapshots=all`；这是 P0.2 的取证步骤，**不是日常复跑命令**。基线正式交付后，迁移不能用该选项覆盖历史图来让回归通过，也不能通过放宽差异阈值、隐藏内容或删除行为断言掩盖差异。有经确认的设计变更时，保留旧证据并单独说明新期望与审核依据。

每个截图场景附带 `evidence.json`：记录可见控件的坐标和实际尺寸、font family/size/weight、line height/letter spacing、颜色/背景、边框、圆角、阴影、padding/gap、display/position/z-index、焦点/禁用状态、主题和响应式 media query 结果。字体证据还包含固定中英文字符串 `Orbit baseline 0123 — 中文输入` 的 Canvas 字宽探针；Chromium 对可定位的代表正文/标题记录 CDP 实际使用的字体，WebKit 保留计算样式、字宽与字体文件哈希。没有把所有继承 font-family 声明误称为每个字形都来自同一种字体。

计算样式记录是实际观测值；例外与裁切也保留，不把现有界面改成理想化样稿。代表性明亮桌面数据包括 14px/22px 常规控件文字、16px/600 的任务标题、32px 高的常规按钮、44×22px 开关、6px 控件圆角、8px 设置卡片圆角；完整值以对应场景附件为准，不能用这几个例子替代响应式与暗色记录。

以下是 Chromium 实测摘要，来源为 `baseline-run/*--task--computed-styles-and-timings.json`（RGB 值与完整多层阴影均保留在附件中）。CSS 中声明的主题变量与最终控件颜色不是同一个观测量，例如暗色 `--brand: #5b8cff` 对应的 AntD 主按钮实测背景为 `rgb(46, 98, 220)`。

| 观测对象 | 明亮桌面 1280px | 暗色手机 390px |
| --- | --- | --- |
| 任务面板 / 正文颜色 | 665.59px 宽；背景 `#fff`，字色 `#1f2329` | 390px 宽；背景 `#2b2b2e`，字色 `#c9ced5` |
| 主按钮 | 109.27×32px；背景 `#3370ff` | 358×40px；背景 `rgb(46, 98, 220)` |
| More actions | 32×32px；hover 背景黑色 4% | 40×40px；hover 背景白色 8% |
| 动作菜单 | 173.83×104px；白底，8px 圆角 | 同尺寸；背景 `#343437`，8px 圆角 |
| 分享弹窗实际表面 | 520×498.63px；白底，10px 圆角 | 374×579.48px；背景 `#343437`，10px 圆角 |
| 分享链接输入框 | 高 32px；12.5px 等宽字；1px `#dee0e3` 边框 | 高 32px；12.5px 等宽字；1px `#424246` 边框 |

菜单和弹窗为三层阴影：明亮主题的黑色 alpha 为 0.08/0.12/0.05，暗色主题的白色 alpha 为 0.016/0.024/0.01；偏移/模糊/扩展分别为 `0 6px 16px 0`、`0 3px 6px -4px`、`0 9px 28px 8px`。任务面板另用 `rgba(31,35,41,0.04) -4px 0 16px 0`。Chromium 可读取的代表字形实际使用 Liberation Sans；不能把桌面 CSS 中的 PingFang/Segoe 声明当成当前 Linux 实际字形。

断点实测还包括：分享页头在 599/601px 的高度为 46.14/50.14px；项目列表行在 639/641px 为 113.77/66.64px，图容器高度为 304/240px；959/961px 时 Wiki 标题可用宽度从 927px 变为 617px，会话输入从 929px 变为 318px。断点两侧的侧栏、布局和图几何见相应截图及附件，不用单一桌面尺寸推算。

## 现有失败与边界

[known-failures.browser.mjs](../../../../src/web/ui-migration/known-failures.browser.mjs) 保留两条期望行为断言和观测附件：

| 编号 | 基线实际行为 | 保留的期望 |
| --- | --- | --- |
| `P0.2-FOCUS-1` | 任务分享弹窗按 Escape，底层任务面板也被关闭，焦点落到 BODY | 关闭分享弹窗后恢复到 More actions 触发按钮 |
| `P0.2-FOCUS-2` | 点击分享弹窗 Done，任务面板保留，但焦点落到 BODY | 焦点恢复到 More actions 触发按钮 |

两项使用显式 expected failure，且在标记之前先验证弹窗关闭、API fixture 完整和无页面异常。期望焦点断言没有删除或放宽；将来修复后出现 unexpected pass，要求核对并移除相应已知失败标记。普通测试命令的成功不能解释为这两项功能已修复。

当前 `639px` 项目图最后一个节点超出图容器底部约 **31px**，形成纵向裁切；`641px` 左侧节点还与缩放工具栏重叠，`1280px` 底部约裁切 1px。全屏图能完整显示节点。本次保留对应截图和 `graphGeometry`，未观察到页面横向滚动溢出。它是迁移起点的响应式例外；不能把“与旧截图相等”解释为该布局问题已解决，也不能为本次基线制作顺手改生产 CSS。

固定 EventSource 驱动应用真实的 SSE 消费处理，但绕过服务端事件流、鉴权、网络重连和背压，不能代替 REST/SSE 端到端集成测试。Linux WebKit 的手机 context 也不是真机 iOS Safari；系统文件选择器、软键盘、IME、系统字体、浏览器地址栏与安全区域仍需对应真机验证。性能结果来自本地生产预览与固定数据，不能代表真实后端或公网耗时。

## 构建、单测、体积和性能

[existing-checks/README.md](existing-checks/README.md) 与 [summary.json](existing-checks/summary.json) 保留起点的干净依赖安装、共享包构建、原始 Web 构建/测试命令、退出码、计时和完整日志。现有构建通过；Vitest **287 个文件、3527 个用例全部通过**，没有观察到既存单测失败。原有大 chunk 构建提示仍保留；未改测试超时、worker 数量或断言来取得结果。Web `tsc -b` 本来排除测试源文件，不能把其通过说成所有测试文件已单独类型检查。

[bundle-size.json](existing-checks/bundle-size.json) 按生产 HTML 直接引用（含 modulepreload）的资源记录初始体积及逐文件哈希：JS 原始 **3,141,917** / gzip **955,947** 字节，CSS 原始 **357,333** / gzip **58,590** 字节。gzip 按每个资源使用 level 9 分别压缩求和，不混用 Vite 四舍五入的控制台显示值。所有 JS/CSS、初始资源集合及算法均在 JSON 中，压缩尺寸不是已验证服务器开启压缩的声明。

[performance.browser.mjs](../../../../src/web/ui-migration/performance.browser.mjs) 在 `chromium-light-desktop` 项目执行独立无截图采样。任务、项目图、会话路由各 **5 次新 context**；输入填充、附件菜单开启/关闭各 **10 次**。保存 Navigation/Paint Timing、浏览器/宿主计时、每个原始样本、median/p95/min/max 与宿主负载，最终基线取自 [baseline-run 的原生浏览器性能附件](baseline-run/chromium-light-desktop--record-browser-performance-baseline--browser-performance-samples.json)。路由拦截禁用 HTTP cache，但浏览器进程、OS 文件缓存和预览服务器仍共享；操作时间包含 Playwright 通信、控件可操作/绘制状态检查与两帧等待，不是单独 React render 时间。没有据少量本机样本设定无依据的性能通过阈值。

早期 [performance.json](performance.json) 与 [首轮完整复跑](diagnostics/clock-shim-run/summary.json) 使用 `page.clock.setFixedTime`。复核 Playwright 1.63.0 实现后确认它安装完整时钟替身，Performance Timeline 返回空数组，`performance.now` 使用取整后的代理 tick，定时器/动画帧也被替换。这些旧记录只保留为调试证据，不能作为原生浏览器性能基线；其旧 methodology 中“remain real”的说法由本说明纠正。修正依据见 [clock-method-correction.json](existing-checks/clock-method-correction.json)。宿主耗时仍是真实观测，但对应旧帧调度环境。最终实现只固定 `Date`，性能测试强制验证 Navigation 条目与 first-contentful-paint 均存在，再通过普通入口复跑。后续采样应保留新样本并解释负载/环境，不能覆盖历史数据来掩盖退化。

最终原生计时采样如下（单位 ms，median / p95）：

| 观测 | 样本数 | median | p95 |
| --- | ---: | ---: | ---: |
| 任务可见内容、字体就绪 + 两帧 | 5 | 422.8 | 438.6 |
| 项目图三个节点就绪 + 两帧 | 5 | 694.7 | 702.2 |
| 会话历史、输入就绪 + 两帧 | 5 | 374.6 | 376.3 |
| 输入填充、值/焦点确认 + 两帧 | 10 | 45.4 | 49.7 |
| 附件菜单完成入场 + 两帧 | 10 | 431.1 | 447.1 |
| 菜单关闭、输入恢复焦点 + 两帧 | 10 | 348.9 | 350.6 |

15 次加载都取得 1 条原生 Navigation 和 2 条 Paint 记录；FCP 分别为任务 36–64ms、项目 36–48ms、会话 36–40ms。FCP 只是首次内容绘制，不代替上表的业务内容就绪。p95 使用 nearest-rank，当前小样本的 p95 等于最大值。

## 最终取证结果

普通入口 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` **退出 0**，未传任何截图更新参数，252 张 PNG 在 Date-only 修正前后的 SHA-256 完全一致。浏览器测试用时 218.35 秒（不含 pretest 构建）。

- **77 个普通通过**：含原生性能采样、全部代表页面/状态和断点场景。
- **16 个预期失败**：两项既存焦点缺陷 × 八个浏览器/主题/尺寸项目；原断言和观测均保留。
- **11 个有意跳过**：7 个非参考项目不重复采样性能，4 个手机项目不重复运行桌面指针断点巡检；它们仍执行手机页面场景。
- **0 个意外失败、0 个 flaky**；不重试，不放宽截图阈值。
- **252 张截图、96 份计算样式/交互 JSON、16 份焦点观测 JSON、1 份原生性能 JSON**；已归档预期失败的 Markdown 错误上下文。

最终记录见 [命令及哈希核对](baseline-run/command.json)、[原始命令输出](baseline-run/command-output.txt)、[场景/附件/截图哈希清单](baseline-run/summary.json)、[原始 Playwright 报告](baseline-run/report.json) 与 [环境](baseline-run/environment.json)。各附件按项目与场景命名；报告保留本次实际路径，跨机器阅读时以 summary 中同目录附件名定位。

现有全量 Vitest 最终再次通过，仍为 **287 个文件、3527 个用例**，说明新 `.browser.mjs` 没有混入其发现范围；见 [最终单测记录](existing-checks/final-web-test.json) 与 [完整输出](existing-checks/final-web-test.txt)。13 个浏览器脚本的语法和文件哈希检查见 [browser-syntax-checks.json](existing-checks/browser-syntax-checks.json)。生产 `src/web/src` 和共享包源码没有变更，新增依赖只有锁定的 Playwright 测试工具链。

初次入口制作遇到的定位/绘制准备问题和旧时钟方法都保留在 [diagnostics](diagnostics/) 及 [existing-checks](existing-checks/README.md)；它们属于测试入口调试，不冒充产品既存失败。分享焦点和图裁切仍未修复，真机 iOS/IME、真实 REST/SSE 后端及公网性能不在本次证据所能确立的范围内。
