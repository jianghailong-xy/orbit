# P7.2 复核视觉保真、实测收益与回退交付

服务任务 [P7.2 复核视觉保真、实测收益与回退交付](orbit-task:34Za39UxopXFSlSSCGBZG)，项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。** 本任务负责的子范围（任务验收原文）：**项目各阶段要求均有与最终提交一致的直接证据，迁移引入的视觉/交互差异已解决；同条件性能与体积对照可复核，逐批提交和回退说明完整。**

本任务主要产出复核报告，不改生产源码。全部复核在候选提交 `09d94a12f` 的独立检出（`/mnt/data/tmp/34Za39UxopXFSlSSCGBZG/cand`，按 `scripts/worktree-overlay.sh` 准备依赖）上进行。下面所有「本轮」数字都是本次独立运行或独立测量的结果，不是转抄 P7.1 的记录。

## 结论

| 复核项 | 结论 | 依据 |
| --- | --- | --- |
| P7.1 交付与证据一致 | **成立** | 交付提交 `09d94a12f` 的 `src/web` tree 与项目 tip `c04e79238`、证据提交 `f43d6e1a3` 逐字节相同（`git rev-parse <commit>:src/web` = `31aaca562…`）；本轮在同一 tree 上独立复跑浏览器回归，与 P7.1 记录一致（101/11/0/0/0，见下） |
| 迁移引入的视觉差异已解决 | **成立（有明确接收方）** | 252 张期望截图三层齐备（44 原图 + 165 main 漂移 + 43 已接受），本轮 252/252 全部被断言、0 缺失 0 多余；43 条已接受差异逐条独立测量，其中两条的 CONFIRM 判定与 Orbit 记录逐字段核对（摘要一致）；其余各批「超出抗锯齿级」的差异都在各批证据里逐张分类，或已在 P0 漂移/已接受层登记 |
| Chromium/WebKit、主题、焦点、会话关键行为 | **成立** | 8 项目矩阵本轮全过；主题、焦点、会话场景都在 P0 回归中；Android 模拟器有 23/23 的软键盘与触摸记录（P5.3）；触发真机项列为缺口 |
| 真机验证 | **未执行，列为缺口** | 账号所有者 2026-10-10 决定放在部署之后由本人执行；P5.3 的一页清单 `p5.3/real-phone-checklist.md` 保持「待账号所有者执行」。本环境没有 iPhone/Android 真机，也不以模拟器冒充 |
| 同条件体积/性能对照 | **可复核，收益与代价都如实记录** | 同一测量口径下：初始 JS gzip −109,485 B（−11.5%），初始 CSS gzip **+**22,756 B（+38.8%）（antd 样式原是运行时注入，不计入构建 CSS）；P6 在同一产品状态上的前后对照（gzip 总量 −87,196 B）给出净收益；性能同场景对照见正文 |
| 清单闭合 | **成立** | `audit-antd.mjs --check-owners` 0 未归属、0 待定；`--check-retired` 0 个阻塞文件、退出 0；声明依赖只剩 `@ant-design/icons` |
| 公共组件维护约定 | **成立** | `src/web/src/components/ui/README.md`（211 行）按组件给出导入边界、公共 API、约定与验证入口；`boundary.test.ts` 用测试强制「Base UI 只在本目录内」 |
| 分批提交 | **成立** | 各批独立提交，清单见「分批提交」一节；同提交参照树（撤回本批业务切换）证明单批可回退 |
| 回退说明 | **本轮补写** | 交付前没有一份成文的整体回退说明（各批只有「独立提交」或参照树描述），本文件「回退说明」一节是这项交付 |

本报告给出的是复核结论与证据索引：**它不代替项目的 DONE 判定，也不构成部署或发布授权**——项目状态由账号所有者决定，部署与发布走各自授权通道。

## 复核对象：P7.1 的最终提交与证据

| | |
| --- | --- |
| 交付提交 | `09d94a12f4bb969d69edf75c208d8ab0f9777423`（tree `74bc29723…`），父 1 `c04e79238`（项目 tip），父 2 `0f07cf72e`（当时的 main） |
| 证据提交 | `e065ef2f1`、`f43d6e1a3`，在分支 `orbit/task-p7-1-41e8e5`（只加 `docs/evidence/base-ui-migration/p7.1/`） |
| `src/web` tree | `31aaca562bae53cc29b959399c9468b25fdf81e9`——交付提交、项目 tip、证据提交三处相同（本轮 `git rev-parse` 核对） |
| 证据目录 | `p7.1/`（README + checks/ 14 个文本文件，约 268 KB） |

**一处交付记录缺口**：P7.1 的证据提交只在 `orbit/task-p7-1-41e8e5` 分支上，**没有进入 main 或项目分支**（`git merge-base --is-ancestor f43d6e1a3 <main / 项目分支>` 均不成立）。本轮的核对据此在该分支的 tree 上做，并在此如实记录。

## 本轮独立复跑（与 P7.1 相同提交、相同环境）

每步单独取退出码，各自放进 `MemoryMax=6G` 的 cgroup；原始输出在 `/mnt/data/tmp/34Za39UxopXFSlSSCGBZG/`。

| 步骤 | 命令 | 退出码 | 用时 | 结果 |
| --- | --- | ---: | ---: | --- |
| 1 | `npm run build -w @orbit/web` | **0** | 6.0 s | `tsc -b && vite build`；保留原有大 chunk 提示 |
| 2 | `npm run test:ui-migration -w @orbit/web` | **0** | 170.2 s | **101 通过、11 跳过、0 意外失败、0 flaky、0 重试**（`stats`：expected 101 / skipped 11 / unexpected 0 / flaky 0） |
| 3 | `npm run test:ui-choices -w @orbit/web -- choices.browser.mjs --project=webkit-light-phone --project=webkit-dark-phone` | 1 | 62.3 s | 46 通过、**2 失败**——正是 P7.1 记录的既存红（见下），无其它失败、0 flaky |
| 4 | `npm run test:ui-foundation -w @orbit/web` | **0** | 66 s | **48 通过、0 失败**（基础控件/主题矩阵；含生产 boot 与缓存的 system/light/dark 首屏） |
| 5 | `npm run test -w @orbit/web` | **0** | 213.4 s | **402 个文件、5,247 个用例全部通过**（与 P7.1 完全一致；无跳过、无重试） |

步骤 3 是**有界复核**，不是全矩阵重跑：`choices` 全套 760 项在 P7.1 的记录里跑了 23 分钟（`p7.1/checks/fixture-suites.txt`），本任务改为只重跑「出现已知红的那一个文件 × 两个 WebKit 手机项目」，验证 P7.1 的分类是否仍然成立（同名用例、同两项目、同错误）。全矩阵数字仍以 P7.1 的 757/760 为准。

- 环境：本轮运行写出的 `environment.json` 与 P0.2 记录**逐字节相同**（sha256 `fe69e824…`），即 Debian 13.7、Playwright 1.63.0（Chromium 1243 / WebKit 2359）、56 个字体文件一致。
- 期望截图三层：**44 张 P0.2 原件 + 165 张 main 漂移参考 + 43 张已接受的迁移差异**，由 `expected-screenshots.mjs` 在本次运行开始时组装并逐张校验哈希（本轮独立重算与该输出一致）。
- **252 张截图全部被断言**：从本次运行的原始 `report.json` 直接统计——`expected 252 / captured 252 / unique 252 / missing 0 / extra 0`，按层为 44 / 165 / 43。分析脚本与结果见 `checks/p0-run-analysis.json`。
- 未传任何截图更新参数（`updateSnapshots: 'none'`、`maxDiffPixels: 0`、`retries: 0`），未改阈值、断言或期望层。

步骤 1、2、5 就是项目 P7 的三项命令本体：本轮与 P7.1 的两次运行（101/11/0 与 252/252；402 文件 / 5,247 用例）逐项一致，且是在 P7.1 之外独立跑出来的第三次（构建/静态检查命令见 `checks/commands.json`）。步骤 3、4 是补充入口的有界复核。

## 视觉保真复核

### 1. P0.2 原图不可变

`git log -- docs/evidence/base-ui-migration/p0.2/screenshots` 只有**一个**提交（P0.2 交付 `6bbf3ecc3`，2026-10-04），此后没有任何提交改动过原图；每次 P0 运行的 globalSetup 还会逐张核对哈希（本轮通过）。「不覆盖历史图」由提交历史与哈希两道证据共同支持。

### 2. 差异分流（抗锯齿噪声 vs 真实差异）

- **P0 回归比较器及其分辨力**（读记录时必须分清）：比较器是 Playwright `toHaveScreenshot` 的默认阈值（每像素 YIQ 差 ≤0.2 视为相同）加 `maxDiffPixels: 0`（超过阈值的像素一个也不许有），不是逐字节比较器——**低于阈值的像素变化会被吞掉**。P3.3 的负对照就有实例：深色主题焦点环整体位移 1px（364 个像素、36 级）仍被判为相符。因此「本轮 101 项全过」= 与三层期望在比较器分辨力内相符，不等于逐字节相同；逐像素级别的判断由各批**同提交对照**承担（每通道 >2 级判为「超出抗锯齿级」，噪声另有重复运行的对照），这也是 P3.3 判定「P0 只作底线，不能代替同提交对照」的原因。
- 已登记的 43 条「已接受的迁移差异」是唯一允许改动 P0 期望图的地方，每条都要求：引用协调者对该批证据的 CONFIRM 判定（任务 id、证据版本、digest、文档）、附同提交 before/after 两张原件与哈希、写明差异内容。本轮对这 43 条**逐对独立测量**（脚本 `tools/pngdiff.py`，判据：每通道差 >2 为超出抗锯齿级）：
  - 43 对全部存在真实差异（与「接受的迁移差异」的定位一致），差异像素合计 864,944，逐对数字见 `checks/accepted-before-after.json`；
  - 最大的几项与登记说明的差异区域一致，例如 `task-action-menu`（Chromium/WebKit、明/暗桌面，边界框 x 615–1279 / y 199–842 = 任务面板 Details 区，main 新增 Engine 行）、`settings-saved`（保存胶囊）、`session-attachment-staged`（附件缩略图与输入框轮廓）、`notification-error`；
  - 手机 `session-attachment-menu` 的差异集中在菜单标签区（x 39–158 / y 565–755，即 P2.2 指定的 17px 标签与图标取整），与登记说明一致。
- 抽三条做了并排图与放大差异图目视核对（`compare/`）：before「撤回业务切换的交付」→ after「交付」，差异确实落在登记描述的区域，不是全图重排。
- **计算样式**由各批的同提交对照承担（各批记录：几何逐项严格相等，差异只有 Lightning CSS 的行高数值精度，例如 22px 对 22.000019px）。P0 运行自身在每次 capture 时记录控件与页面的计算样式、字体探针与主题 token（本轮 252 条 capture 全部带记录），但只断言 dpr/scale/宽度/主题，不与历史样式逐字段比较——这也是「P0 只作底线」的一部分。
- **CONFIRM 抽查**：登记表引用的判定与 Orbit 记录逐字段核对通过——
  - P5.3 证据第 1 版，digest `6f0931cc…c01c2`，CONFIRM（2026-10-10T11:44:02Z，含 8 条截图的逐条接受说明）；
  - P3.2 证据第 2 版，digest `302ca1f5…9809bc`，CONFIRM（2026-10-07T01:16:01Z）。
  两者的 task id、证据版本、digest 与登记表的 `decision` 完全一致。

### 3. 两项专项交接的复核

- **P2.1 交接的 8 张桌面截图**（session-idle / breakpoint-961-session）：见下节，均在 main 漂移层，未被继承为预期失败。
- **P2.2 r2 交接的 submenu-left 观察器**（原记录：一次 webkit-light-phone 入场采集等待超时）：本轮打开 `p7.1/checks/submenu-motion-records.json` 逐字段核对，webkit-light-phone 的 `submenu left edge zoom stays in view` 采到了完整记录——入场 `orbit-zoom-in` 200 ms / 15 采样 / `endState: finished`，退场 `orbit-zoom-out` 200 ms / 14 采样 / `endState: idle`；右侧同（另有两个手机项目对照）。不是「实际无动效」，也不是「漏采集」。

### 4. main 漂移层

165 张漂移参考各自登记来源 main 提交、生成环境（P0.2 环境哈希）与哈希；P2.1 交接的 8 张桌面截图（`session-idle`、`breakpoint-961-session` × Chromium/WebKit × 明/暗）都在漂移层（group「session list row」，最近来源 main `d2e295917`），不在已接受层。这与 P7.1 的交接说明一致，本轮用登记表独立核对了这 8 个名字所属的层。

### 5. 各阶段保真复核（证据索引）

各阶段的对照方法与「同提交对照」结果（截图逐字节 / 抗锯齿级 / 超出，计算样式、逐步 trace）见「逐项验收索引」。要点：

- 每一批都做了同提交对照（参照树 = 交付撤回本批业务切换），并另跑标准 P0 作底线；P3.3 已判定「P0 只作底线，不能代替逐像素对照」。
- P2.1/P2.2/P2.3 的同名 README 是各批第 1 版记录（SEND_BACK），**最终采用的版本在各自的 `revision-2` / `revision-8` / `revision-3` 子目录**，本索引按最终版引用。
- 各批遗留的「超出抗锯齿级」差异都在本批证据里逐张分类；其中按设计改变 P0 截图的，经协调者 CONFIRM 后进入已接受层（43 条 = P3.2 判定 23 + WebKit 滚动锁判定 11 + P4.1 判定 1 + P5.3 判定 8）。

## 行为记录复核（Chromium/WebKit、软键盘、触摸、主题、焦点、会话）

| 记录 | 结果 | 本轮做法 |
| --- | --- | --- |
| 浏览器矩阵 | Chromium 1243 / WebKit 2359 × 明/暗 × 桌面/手机，共 8 项目 | 本轮 P0 回归在 8 项目上全过；`report.json` 逐项目状态见 `checks/p0-run-analysis.json` |
| 主题 | `data-theme` 由账号偏好与 `system/light/dark` 驱动；P0 场景在明暗两套下截图；首屏无闪烁由 `test:ui-foundation` 的 boot 检查覆盖 | 本轮 `test:ui-foundation` **48/48 通过**（步骤 4） |
| 焦点 | P0.2 的两项既存焦点缺陷（分享弹窗 Escape/Done 后焦点不归还）在 P3.2 修复后**已撤销 expected-failure 标记，本轮 16 个用例全部普通通过**（`known-failures.browser.mjs` 保留断言）；菜单/弹层的焦点约定（打开即在菜单内、Tab 离开并关闭等）是协调者判定接受的约定 | 本轮运行状态核对 |
| 会话关键行为 | 发送/排队/中断/重试、流式顺序、滚动跟随、附件、图片预览、手机返回：P5.1–P5.3 的同提交痕迹（请求与请求体逐步一致） | 转引各批证据（见索引），本轮未重跑 P5 对照 |
| 手机软键盘/触摸 | **Android 模拟器**（emulator-5554，API 36，Chrome for Android 133 + Gboard）：软键盘顶起输入框、Gboard 打字与回车发送、系统返回与边缘滑动返回、长按选词与行菜单、照片选择器、预览点按与双指缩放，两树 23/23（P5.3） | 明确标注为**模拟器**，不作为真机证据 |
| 真机 | **未执行**（缺口） | 与账号所有者的决定一致，见下 |

### 真机缺口（如实列出，不以模拟冒充）

- 真机 iPhone（Safari）/ Android（Chrome）的软键盘、系统输入法组词、手势返回、安全区域与系统字体**均未验证**；P5.3 的一页清单 `p5.3/real-phone-checklist.md` 保持「待账号所有者于部署后执行」，属于 P7.2 之后的账号所有者动作。
- 中文输入法组词在模拟器上也未覆盖（Gboard 默认英文，不产生 `compositionstart`）；浏览器侧 Chromium 用 DevTools 组合输入、WebKit 用事件重放，都不等于真机输入法。
- 真机之外已覆盖的边界：Linux WebKit 的手机 context 不是 iOS Safari；触摸在 Playwright 手机模拟里是合成事件（P5.2 记录 WebKit 不能构造 Touch）。

## 同条件实测收益对照

对照的两个测量都是 P0.2 已固化的口径，本轮在候选提交上原样重跑。

### 1. 初始压缩体积（`dist/index.html` 直接引用的 JS/CSS，逐文件 gzip -9）

测量脚本 `tools/bundle-size.py` 与 P0.2 的 `existing-checks/bundle-size.json` 同口径（初始资源 = script / stylesheet / modulepreload 直引）。

| 口径 | P0.2 基线（`f4d47e853`） | 本轮（`09d94a12f`） | 变化 | 百分比 |
| --- | ---: | ---: | ---: | ---: |
| 初始 JS 原始 | 3,141,917 | 2,805,773 | −336,144 | −10.7% |
| 初始 JS gzip | 955,947 | 846,462 | **−109,485** | −11.5% |
| 初始 CSS 原始 | 357,333 | 496,850 | +139,517 | +39.0% |
| 初始 CSS gzip | 58,590 | 81,346 | **+22,756** | +38.8% |
| 全部产物 JS gzip | 1,211,828 | 1,126,700 | −85,128 | −7.0% |
| 全部产物 CSS gzip | 61,126 | 83,882 | +22,756 | +37.2% |

**怎么读这两行相反方向的数字**（不预设收益比例，只记录实际变化与原因）：

- **JS 变小**与 P6 在同一产品状态上的前后对照一致：P6 交付（`6879542dc`）相对它的起点（`f78e93f61`，仍带 antd）总 gzip 1,302,288 → 1,215,092（−87,196 B），`index.js` 592,912 → 506,310（−86,602 B）。P6 记录里干净安装后依赖树、构建产物里 antd/cssinjs 均为 0。
- **CSS 变大**是记账位移，不是新增外观代码：antd 的组件样式由 cssinjs 在**运行时**注入 `<style>`，从来不在构建的 CSS 文件里；迁移后这些样式（`root.css`、`reset.css`、各组件 CSS、`foundation.css`）成为静态文件，进入 `app-*.css`（本轮 496,850 B 单文件）。因此「构建 CSS 变大」与「运行时不再注入样式」是同一件事的两面；P6 也记录 `app.css` 只比起点多 752 B（因为 P6 本身不引入新样式，只把 reset 换成逐字节相同的副本并加 `root.css`）。
- 两端之间的差还叠着 main 的产品改动（见「与 main 的关系」）：P0.2 基线是 10-03 的 main，本轮候选含 10-11 的 main。数字只能读作「P0 基线 → 最终交付」的实际变化，不能全部归因于迁移。
- 两端用的是同一套构建链（`vite ^8.3.1`、`@vitejs/plugin-react ^6.1.1` 在两个提交上相同；本轮已核对），所以对比不受打包器版本变化影响。`src/web/package.json` 本身的差异（+17/−2）就是依赖表的迁移：去 antd、进 Base UI 与 Floating UI 及 Playwright 测试链。
- P3.3 曾估算「P6 后初始 JS 净减约 21–24%（raw）」；实际测得 raw −10.7%、gzip −11.5%。估算偏高，原因是同期 main 新增了自己的界面代码，且 Base UI/Floating UI 核心（P3.3 实测约 239 KB raw）是新进包，抵消了一部分 antd 的移出。按估算当时的口径，这不构成承诺未兑现，但如实记录差距。

### 2. 关键页面加载与会话输入/菜单操作（原生计时）

`performance.browser.mjs`（含在标准入口里）在候选提交上本轮重跑，口径与 P0.2 相同（任务/项目/会话各 5 次新 context；输入、附件菜单开/关各 10 次；只固定 `Date`，保留原生 Navigation/Paint；`reducedMotion: 'reduce'`；median / p95，单位 ms）。

| 观测 | P0.2 基线 med / p95 | 本轮 med / p95 | 变化（med） |
| --- | ---: | ---: | ---: |
| 任务可见内容、字体就绪 + 两帧 | 422.8 / 438.6 | 318.8 / 356.3 | **−104.0** |
| 项目图三节点就绪 + 两帧 | 694.7 / 702.2 | 580.9 / 619.7 | **−113.8** |
| 会话历史、输入就绪 + 两帧 | 374.6 / 376.3 | 337.0 / 339.5 | **−37.6** |
| 输入填充、值/焦点确认 + 两帧 | 45.4 / 49.7 | 47.8 / 55.1 | +2.4 |
| 附件菜单完成入场 + 两帧 | 431.1 / 447.1 | 98.5 / 123.6 | **−332.6** |
| 菜单关闭、输入恢复焦点 + 两帧 | 348.9 / 350.6 | 80.6 / 96.9 | **−268.3** |

- 本轮宿主负载 21.8/12.8/10.3（P0.2 为 8.6/9.5/9.8），15 次加载均取得 1 条 Navigation 与 2 条 Paint 记录（口径自检通过）。
- **菜单开/关的大幅变化有明确机制**：P0 环境固定 `reducedMotion: 'reduce'`，被替换的 antd 弹层不读这个设置、照常播放约 0.2–0.3 s 入场动画，Orbit 弹层按设置立即完成——P3.3 的同场景 A/B 独立测得同样量级（减少动态效果下弹层操作快 265–405 ms）。**这不代表默认动效下更快**：P3.3 在默认动效下的同场景对照是 −12 到 +8 ms（一帧以内）。
- 三个页面加载项的 −104/−114/−38 ms 与「初始 JS 更小、无 cssinjs 运行时注入」方向一致，但也叠着 main 的产品改动与宿主负载差异，**不把差值全部归因于迁移**；输入填充 +2.4 ms 在噪声范围。
- 本机绝对时间不代表真实后端/公网；固定 REST/SSE 数据、本地预览、共享主机。

## 公共组件维护约定、清单闭合、分批提交与回退

### 维护约定

`src/web/src/components/ui/README.md` 是公共组件的事实说明：导入边界（业务只按 `components/ui/<Component>` 导入，Base UI 不外泄）、每个组件的公共 API 与最小约定（Button/Input/Textarea/…/Menu/Select/ImagePreview/…）、主题与样式加载顺序（`main.tsx` 的导入顺序由 `firstPageStylesheet.test.ts` 钉住）、`--orbit-*` 变量的来源与例外。`boundary.test.ts` 检查实际源码：Base UI 引用只允许在本目录内、业务不得引用私有 fixture；被替换的库在 P6 后已经不在依赖里，再 import 在类型检查与构建时就失败。

### 清单闭合（本轮在候选提交上原样重跑）

| 检查 | 结果 |
| --- | --- |
| `node src/web/scripts/audit-antd.mjs --check-owners` | `unowned: []`、`pending: []`、`owners: {}`，退出 0 |
| `node src/web/scripts/audit-antd.mjs --check-retired` | `retirementBlockingFiles: 0`，antd 生产/测试文件 0，`.ant-*` 测试文件 0，退出 0 |
| 声明依赖 | 只剩 `@ant-design/icons`（图标按项目约定保留） |

P6 的清单闭合记录（生产/测试的 antd 导入 9/3 → 0/0，`--check-retired` 阻塞 37 → 0，干净安装与产物扫描 0）与本轮一致。

### 分批提交

各批在自己的分支上独立提交，经项目分支进入 main。下列提交取自各批证据（`docs/evidence/base-ui-migration/*/README.md`，最终版本）：

| 批次 | 提交（节选，最后一个是交付/合并） |
| --- | --- |
| P1.1 / P1.2 | 交付 SHA 未写进 README（缺口，见「缺口与遗留」）；从历史看分别落为独立的公共组件提交 |
| P2.1 | `9429c189f` + `e3f53d402`（revision-2） |
| P2.2 | `1a70fbb90` … `8a29e3493`（revision-8 最终合并） |
| P2.3 | `5814921ce` + `1b17eaf7d`（revision-3） |
| P2 补强/窗口跟进 | `77583b327`、`8447b59a5`、`89dc743e5`、`d6a764624`、`cc915a0ac`；`4fb7ee43f1a`、`25d4e9b1d`；`e78ecf527`、`616f1e378`、`069601b67`、`aed0a7bab` |
| P3.1 | `8adad9550`、`604812243`、`192922e16`、`d401915ff`、`9b20343a5`、`cb3980392` |
| P3.2 | `abb4c29e7`（v1）→ `6bd41335a`（v2 代码） |
| P4.1 | `0bb647a81`、`7d81822b1`、`b0b59fa39` |
| P4.2 | `9f4c4c4d1`、`865a0a6e3`、`d3aadf781`、`822c00ff0`、`a794459b1` |
| P4.3a | 8 个提交（`9809e6b20` … `dac57bade`） |
| P4.3b | `e21fad172`、`2fefd4747` |
| P4.4 | `b9136d57a`、`824974aee`、`90ce00944`、`29ef702b3`、`f4ec61864` |
| P5.1 | `64e45915e`、`62a0820f9`、`eb9438625`、`b51a143e3`、`1886feef3` |
| P5.2 | `a5be9e4f8`、`2699c6149`、`08a8964da`、`f77a538a9`、`211949ed8` |
| P5.3 | `799c8d3cc`、`10e9c2bbf`、`c868a02c2`、`128646c01`、`b72da6eda` |
| P6 | `b1010a5ad`、`8572d1a2f`、`c4396e776`、`3339873a7`、`a244dfc06`、`6879542dc` |

每个实现批次的代码改动与业务切换分开提交，且各批都用「同提交参照树」（交付撤回本批业务切换）证明过单批可撤回——P4.x/P5.x 的参照树做法见各批 README 的「复现」，P3.2 的 `reference-tree.patch` 在 `p3.2/`。

### 回退说明（本轮补写）

**单批回退**：每批的提交是独立、可 revert 的（上表）。公共组件与业务切换在同一批内也分开提交，撤回业务切换后公共组件仍在，页面回到旧组件渲染——这正是各批同提交参照树的构造方式，因此「撤回单批后能构建、能通过 P0」有直接证据。

**整体回退**：迁移经 main 吸收/晋升合并多次进入 main，**没有一个可以一次 revert 的合并提交**；实际可行的整体回退是内容回退：

1. 取迁移前的 `src/web`：`git checkout f4d47e853 -- src/web`（P0.2 基线起点，其 `bundle-size.json`/`environment.json`/252 张原图都在 `p0.2/`，回退后可直接用同一命令重建基线证据）；`src/shared` 与根 `package-lock.json` 如被迁移碰到，同样从该提交取回。
2. 恢复依赖：`npm install antd@6.6.5 -w @orbit/web`（P6 记录的锁文件删除项是 57 个 antd 独占条目，逐字节等于 `npm uninstall antd -w @orbit/web` 的逆操作）。
3. 重跑三项命令与 P0 回归：`npm run build -w @orbit/web`、`npm run test -w @orbit/web`、`npm run test:ui-migration -w @orbit/web`。
   注意：回退到 `f4d47e853` 会同时退回 main 在 10-03 之后对 `src/web` 的产品改动；要只退迁移、保留产品改动，需按批次 revert（上表），或按页面把业务切换的单个提交反向应用（各批 README 的参照树补丁给出了逐文件的撤回方式）。
4. 已接受的迁移差异与 main 漂移登记**不用清理**：期望层按截图名组装，旧产品代码上漂移层会失配——所以整体回退后应先用 P0.2 原图（`p0.2/screenshots/`）作为期望，或接受 P0 回归在漂移页上失败并另行归因。

公共组件的兼容边界：`ui/` 组件在 P6 后不依赖 antd，因此**只回退某批业务页面**不需要动依赖；**回退到 P6 之前**才需要把 `antd` 装回。Toast/弹层等公共实现的回退按 P2.x 的提交 revert，证据在对应批次目录。

## 与 main 的关系

- 复核目标是迁移项目的最终交付（项目 tip `c04e79238`，已由晋升合并 `96852b785` 进入 main）。P7.1 的交付提交把 `c04e79238` 与当时的 main `0f07cf72e` 合并后测得。
- 本轮复核期间 main 又前进到 `3b23aa163`：自候选提交起 `src/web` 有 11 个文件、+1,075/−158 的变化——其中 `ProjectLandingCard.tsx`、`ProjectPanoramaHeader.*`、`LandingJobsSheet.test.tsx`、`ProjectMergeStrip.tsx`、`WorkspaceView(.projectSessions.test).tsx` 与 `index.css` 的大部分是其他项目（Landing 卡片）的落地工作，`ui/MultiSelect.tsx`（5 行）、`ui/Floating.ts`、`ui/Floating.anchor.test.tsx` 是本项目自己的多选修复（见下）；`src/web/package.json` 与锁文件未变；`p0-drift/` 两个登记表与候选提交逐字节相同。
- 迁移项目线上的后续动作：多选组件 WebKit 手机 ResizeObserver 循环的修复（`62ab70582`，任务 `34dcr9bZPPrl6TDzvXowg`，证据 `multiselect-ro-loop/`）在候选提交之后进入项目分支与 main（项目分支 tip `a55e9d113` 已是 main 的祖先）。也就是说：P7.1 在候选提交上记录的「choices 两条 WebKit 手机既存红」在**当前 main 上已被修复**；候选提交上的三条 red 分类（2 条既存红 + 1 条网络抖动）与 P6/P7.1 的记录一致。

## 逐项验收索引（项目 P7 条目 `5wbhutjez7Qv5GCTNLb0P7`）

项目共 8 条验收（`project_get` 的 `acceptanceCriteriaItems`），逐条对应证据与最终提交一致性如下。「最终提交一致」指该条证据所依据的交付提交都在项目线历史里（P0.2 `3e1d1ca08`/`6bbf3ecc3` → … → P6 `6879542dc` → 项目 tip `c04e79238`），本轮的 P0 回归与体积/性能测量都在这个 tip 的 `src/web` tree 上。

| # | 验收条目 | 证据 | 本轮核对 |
| --- | --- | --- | --- |
| E1 | P0：迁移清单和现有视觉、行为基线可复现，所有 AntD 使用点均有迁移归属 | `p0.2/`（252 原图、环境、bundle-size、性能）、根 `README.md`（`audit-baseline.json`/`ownership.json`/`component-contracts.md`/`css-ownership.json`/`routes-and-tests.md`） | 环境哈希逐字节一致；原图自 P0.2 起未被改动；三层期望机制仍在该目录；`--check-owners` 0 未归属 |
| E2 | P1：公共基础组件使用现有设计变量与主题机制，呈现与当前控件基准一致 | `p1.1/`（含 revision-2）、`p1.2/`（controls 矩阵 24/24、foundation 48/48） | 主题在 P0 明暗矩阵与 `test:ui-foundation` 中持续被验证（本轮重跑见步骤 4） |
| E3 | P2：弹层、选择及反馈组件保持键盘、焦点、通知和确认行为 | `p2.1/revision-2/`、`p2.2/revision-8/`、`p2.3/revision-3/`、`p2-p3-hardening/`、`p2-keyboard-window/`、`p2-keyboard-window-2/`、`p2.3-b1/`、`toasts*` 入口 | P0 的 known-failures 16 项由 expected-failure 归还为普通通过；`test:ui-foundation` 本轮重跑 |
| E4 | P3：任务详情与分享试点及会话输入代表场景达到既有外观和操作要求，并形成成本对照 | `p3.1/`、`p3.2/`（+ `p3.2-accepted/`）、`p3.3` 报告在任务 `34Za39Br6OaoCg0nc1ipA` 的评论（**没有独立目录**） | 43 条已接受差异中 23 条引 P3.2 的 CONFIRM（本轮抽查 digest 一致） |
| E5 | P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致 | `p4.1/`（+`p4.1-accepted/`）、`p4.2/`、`p4.3a/`、`p4.3b/`、`p4.4/` | P0 页面矩阵本轮全过；非会话页面运行时 AntD 类普查 0（`p4.4`） |
| E6 | P5：会话工作区完成迁移，输入、附件、富内容、消息操作及滚动导航行为无迁移回归 | `p5.1/`、`p5.2/`、`p5.3/`（+ `p5.3-p0-registration/`、模拟器记录、真机清单） | 43 条中 8 条引 P5.3 的 CONFIRM（抽查一致）；真机项列缺口 |
| E7 | P6：Orbit Web 不再依赖 antd 组件运行时及其内部 DOM/选择器 | `p6/`（锁文件、干净安装、产物扫描、清单闭合、六个样例） | 本轮在候选提交上重跑 `--check-retired`（0 阻塞，退出 0） |
| E8 | P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录 | `p7.1/`（三项命令）+ **本目录**（保真复核、同条件收益、回退说明） | 本轮独立复跑三项命令全部退出 0（build、ui-migration、vitest），另加体积/性能实测与回退说明 |

## 缺口与遗留（交协调者）

**按决定不执行、如实记录（不是失败）**

1. **真机验证未执行**：软键盘、系统输入法组词、触摸、手机返回的真机记录需账号所有者按 `p5.3/real-phone-checklist.md` 在部署后执行。本环境没有真机，模拟器记录只作补充。
2. **P7.1 的证据分支未并入 main/项目分支**：`orbit/task-p7-1-41e8e5` 上的 `docs/evidence/base-ui-migration/p7.1/`。如果交付要求证据在 main 上可读，需要一次把该目录并入的提交（内容与分支逐字节相同，本轮已核对）。
3. **P1.1/P1.2 的交付提交 SHA 没写进各自 README**（只有起点或实现提交）。历史完整、可回退不受影响，但「证据与最终提交一致」的读者要在分支历史上多走一步。
4. **P3.3 的报告没有独立证据目录**：它只在任务 `34Za39Br6OaoCg0nc1ipA` 的评论与账号上传归档 `/root/.orbit/uploads/78dc8fb5-…/p33/`（含 SHA256SUMS）里，`docs/evidence/base-ui-migration/` 下没有 `p3.3/`。E4 的索引因此指向任务评论；如果交付要求证据目录自足，需要一次把该归档并入的提交。

**已记录的迁移期缺口（都有任务或判定，供最终阅读）**

5. **MultiSelect WebKit 手机 ResizeObserver 循环**：候选提交上 `choices` 仍 2 条红（P7.1 记录 757/760）。本轮的**有界复核**逐条对上：`choices.browser.mjs` × 两个 WebKit 手机项目 = 46 通过 / 2 失败，失败就是用例末尾页面错误断言里的 `ResizeObserver loop completed with undelivered notifications.`（与 P6、P7.1 记录逐字相同），没有第三条（`checks/choices-targeted-summary.json`）。修复 `62ab70582` 与证据 `multiselect-ro-loop/` 已在候选提交之后进入项目分支与 main；任务 `34dcr9bZPPrl6TDzvXowg` 已 DONE。候选提交上的分类（既存、非迁移引入）有 P6 的因隔离证据。
6. **P2.2 revision-8 的 Select 快速按键残留缺口**（无节流时 2/189 丢失，被替换组件 0/95）与 **Menu 打开窗口内的其余按键「只记录」组合**：各批已记录为已知差异，未修复项仍在 `p2-keyboard-window(-2)` 的边界一节。
7. **`34dq7m9wxKsEaWbvtNqk2`（OPEN）**：退役 keyboard window 第 2 批的 AntD 一侧比较用例（体积/维护性跟进，无产品影响）。
8. **`34ccjgcldZWdgdrAAm3uV`（OPEN）**：会话导出遇到复核请求回合时失败——P4.3b 已证明**两棵树都失败**的既存缺陷，不属于迁移回归。
9. **P0 之外的既有缺陷**：分享页焦点两项已修；依赖图 639/641/1280px 的裁切/重叠保留为既存例外（截图与 `graphGeometry` 在 `p0.2/`）；`known-failures` 保留的断言没有删除或放宽。

## 复现

```sh
# 候选提交的独立检出（本轮的复核树）
git worktree add --detach /mnt/data/tmp/<任务目录>/cand 09d94a12f4bb969d69edf75c208d8ab0f9777423
cd /mnt/data/tmp/<任务目录>/cand && bash scripts/worktree-overlay.sh
# 三项命令（每步单独取退出码，各自放进 MemoryMax=6G 的 cgroup）
NO_COLOR=1 npm run build -w @orbit/web
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
NO_COLOR=1 npm run test -w @orbit/web
# 本轮使用的独立测量工具（在 /mnt/data/tmp/34Za39UxopXFSlSSCGBZG/tools/）
python3 tools/bundle-size.py <dist> <commit> out.json     # 与 P0.2 同口径的逐资源 gzip
node tools/perf-compare.mjs <browser-performance-samples.json>  # 与本目录 checks/performance-baseline.json 对照
python3 tools/pngdiff.py a.png b.png                      # 每通道 >2 判为超出抗锯齿级
node tools/p0-run-analysis.mjs <src/web/.ui-migration-results>  # 从原始 report.json 统计
node src/web/ui-migration/collect-evidence.mjs <新目录>    # 收集一次运行的证据（拒绝收集有意外失败的运行）
```

原始运行原件（含 attachments 的完整 `report.json`、逐用例 computed-styles JSON）在 `/mnt/data/tmp/34Za39UxopXFSlSSCGBZG/`，判定后清理。
