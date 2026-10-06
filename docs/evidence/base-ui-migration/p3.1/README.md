# P3.1 自动增高 Textarea 与会话输入兼容

服务于 [P3.1 实现自动增高输入框并验证会话兼容](orbit-task:34Za398jkGI2ymxpFlbf2)，起点为项目分支 tip `8ef6b60d1c18976cfca0c1bd98081bd381703c6e`（含 P0–P2 已验收交付及 P2.2 第8版吸收的 main）。开工读取了任务完整信息与历史评论（协调者追加的 P2 晋升冲突前置说明）、项目目标/作业指导/8项验收、P0.1 清单（component-contracts、ownership、css-ownership）、P0.2 基线与 P1.2/P2.x 交付。项目验收条目 key `3ojnKuvd3dQLuwsFV8g7Ll`，原文：**P3：任务详情与分享试点及会话输入代表场景达到既有外观和操作要求，并形成成本对照。** 本任务只承担其中自动增高输入框与会话输入代表场景子范围。

范围依据 P0.1 的归属：`TaskDetailPanel.tsx` 的 textarea 内部访问由 P3.2 用本任务的原生 ref 替代，`WorkspaceView.tsx` 的两处访问在本任务验证兼容、由 P5.3 完整切换；composer 输入 CSS 区段归 “P3.1 → P5.3”。因此本次**没有切换任何业务页面**，也没有改动发送/队列/菜单/粘贴等业务逻辑、路由、REST/SSE、依赖或锁文件；真实页面切换以下文的验证补丁交给 P3.2/P5.3。

## 提交

| 提交 | 内容 |
| --- | --- |
| `8adad9550` | fix：共享文本控件的 focus 优先于 hover；普通 input/textarea 的 16px 断点由 600px 改为与 AntD 一致的 960px（P1.2 遗留差异，见下文） |
| `604812243` | feat：Textarea 的 `autoSize`、`variant="borderless"`、原生 ref、0.3s 过渡；index.css 会话输入区块与 `.tdp-compose` 让 `.orbit-textarea` 共用声明；`components/ui/README.md` 用法；加强 composer CSS 源码断言 |
| `192922e16` | test：`ui-migration/composer.html` 代表场景与 `test:ui-composer` 浏览器对照 |
| `d401915ff` | test：像素判定改为“同尺寸且每通道差≤2”（几何/样式仍逐项严格相等），原因见“像素判定” |
| `9b20343a5` | test：controls 增加 focus+hover 与 601–959px 字号回归，先在旧样式上复现失败 |
| `cb3980392` | docs：README 用语不再出现 AntD 内部 ref 名称（P6 扫描会计入文档） |

以上即全部代码改动；之后的提交只增加本目录证据。各提交可单独回退。

## 组件约定

`Textarea` 的 ref 就是 `HTMLTextAreaElement`，业务用原生 `focus()`、`setSelectionRange()`、`selectionStart`、`offsetHeight`、`scrollHeight/clientHeight`，不再经由 AntD 字段内部 ref。`autoSize` 为 `true` 或 `{minRows,maxRows}`：

- 测量与被替换字段相同：离屏 textarea 副本复制同一组尺寸样式，值为空时按 placeholder 计高，用 scrollHeight 与单行高度求 min/max，超过 maxRows 后取消 `overflow-y: hidden` 改为滚动；结果写入 height/min-height/max-height/overflow-y/resize，并覆盖调用方 style 同名项（与 AntD 合并顺序一致）。副本只在测量时挂入 body，页面里不残留第二个 textarea（AntD 会常驻一个 `name="hiddenTextarea"`）。
- 触发：受控 `value` 或行数界限变化时在绘制前测量（现有调用全部为受控值）；字段宽度变化由 ResizeObserver 下一帧重测；placeholder 变化本身不触发，与旧字段一致。
- 手动高度：调用方传 `autoSize={false}` 与 `style={{ height }}`，复位时恢复 autoSize，与 WorkspaceView 现有拖动/双击复位逻辑原样配合。
- `variant="borderless"`：无边框/底色/焦点阴影，上下 padding 5px，`:focus-visible` 为 1px 品牌色 outline（-1px 偏移）且只过渡 outline，因此聚焦输入时增高即时完成；会话输入框的 index.css 规则仍去掉该 outline。默认外观以 `transition: all 0.3s` 与 AntD textarea 相同（含自动增高的高度动画）。`prefers-reduced-motion: reduce` 时沿用 P1.2/P2.1 规则不过渡——这是唯一保留的有意差异，AntD 在减少动态效果下仍为 0.3s。
- 键位、候选菜单、粘贴、历史、发送仍归业务组件。Textarea 透传原生事件（含 `nativeEvent.isComposing`）；AntD 的 onChange 交给业务的是复制了值与选区的克隆 target，并在 compositionend 额外触发一次同值 onChange，业务读到的值/选区相同（下文行为对照逐步核对）。

### 一并修正的共享文本控件差异

对照评论框时发现 P1.2 的共享规则与 AntD 有两处不同，均会出现在 Textarea 上：

1. **focus 被 hover 覆盖**：`.orbit-text-control:hover:not([data-disabled])` 的特异性高于 focus 规则，点进字段后指针仍停在上面时显示 hover 色 `rgb(92,146,255)`，AntD 显示 focus 色 `rgb(51,112,255)`。
2. **16px 断点**：index.css 在 ≤960px 把 AntD 普通 input/textarea 提为 16px，Orbit 规则写的是 600px；601–959px 时 AntD 16px/35.14px 高，Orbit 14px/32px（空评论框 60px vs 32px）。

修正在共享规则中完成，因此同样作用于 P1.2 的 Input（尚无业务页面使用）。新增的 controls 用例在原样式上复现两处失败（[before-fix](checks/controls-regression-before-fix.txt)、[breakpoint-before-fix](checks/controls-regression-breakpoint-before-fix.txt)，均为未提交的临时还原，记录中保存当时源码哈希），修正后八环境通过；P1.2 原 24 项与新 8 项共 [32/32](checks/controls-matrix-2.txt)。

## 代表场景与对照方法

[composer.html](../../../../src/web/ui-migration/composer.html) 用真实 index.css、ComposerMirror、`lib/slashCommands`、`lib/composerRefs`、`MAX_PROMPT_CHARS` 复现 WorkspaceView 会话输入框（附件区、镜像、字段、`/`/`@`/`#` 菜单、拖动柄、发送键、历史、粘贴文件）和 TaskDetailPanel 评论框（`@` 提及、⌘/Ctrl+Enter、经 ref 恢复光标）。键位与菜单代码从两个页面照录，`?impl=ant` 渲染两页今天的 AntD 字段（并按页面现状经其内部 ref 取 textarea），默认渲染 Orbit Textarea；两者之外全部共用，所以差异只可能来自字段。`?scenario=plain` 另测脱离 composer CSS 的 borderless 外观。

夹具锚定真实页面：AntD 侧空闲与两行时的宽高必须等于 P0.2 在真实页面记录的值（会话 637/360px 宽、38/62px 高；评论 559.890625/285.296875px 宽、桌面 32px、手机 85px——手机空评论框按换行的 placeholder 计为 3 行）。每个用例在 P0 environment.mjs 校验的固定环境中运行 Chromium/WebKit × 明/暗 × 桌面1280×900/手机390×844，默认 reducedMotion=reduce，另有 no-preference 用例。

对照内容：

| 方面 | 做法 |
| --- | --- |
| 自动增高 | 空/1行/Shift+Enter 两行/长句换行/中文换行/末尾换行/12行/13行/15行到顶滚动/清空/shell 模式/附件/禁用/变窄后重测/长 placeholder 前后，逐状态比较字段与卡片几何、内联尺寸样式、55项计算样式、placeholder、scroll 数值和镜像 |
| 手动高度 | 真实鼠标拖动顶部手柄：+100px、下限44px、上限640px、短文本保持手动高度、双击复位、复位后恢复自动增高，以及到顶判定（手柄出现/消失） |
| 镜像对齐 | 探针分别只画字段自身字形和只画镜像字形，逐像素数差；附件缩略图、文字与卡片直边同在 24px |
| 断点 | 桌面指针 599/601/959/961px 下两场景比较；评论框 ≤960px 为 16px |
| 过渡 | 正常动效下比较高度动画（属性/时长/缓动/延迟）；减少动态效果下记录唯一差异 |
| 输入行为 | 中文组合输入（Chromium 用 DevTools `Input.imeSetComposition` 真实组合事件；WebKit 无输入法自动化，用 insertText 加 composition 事件与 keyCode 229 的 Enter 重放）、组合中 Enter 不发送、Enter/Shift+Enter/⌘Ctrl+Enter、三类菜单的方向键/Enter/Tab/Esc/指针、组合中菜单不响应、引用落地为链接、剪贴板文本与文件粘贴、50,000 字符上限、历史上下翻、经 ref 聚焦与恢复光标；每步记录值/选区/焦点/高度/菜单/芯片/发送结果/原生事件序列，两侧必须完全相同 |

### 像素判定

几何与计算样式逐项严格相等（数值只容 1/64px 布局子像素）。截图在比较前对两页做同一次整区重绘（`<main>` 短暂 opacity 0.99，不改布局、焦点或 hover），首绘图也保留比较。诊断发现 Chromium 对圆角/outline 圆角的抗锯齿取决于各自的重绘历史：评论框空闲时 AntD 首绘与自身重绘后相差 42 像素，Orbit 首绘与重绘后相同；另一次运行中重绘后 outline 圆角出现 17 像素差而首绘相同；换用 viewport 抖动或 html 背景重绘也只在单独场景中稳定。所有观察到的差异都只在抗锯齿弧线上、通道差≤2。最终判定为“两种截图同尺寸且每通道差≤2，差异像素数全部记录”；颜色、偏移或尺寸变化都远大于此，并且已被严格的样式/几何比较拦截。首个记录运行因原“0像素”判定在 Chromium 手机失败，原记录保留在 [composer-chromium](checks/composer-chromium.txt)。

## 结果

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| 代表场景，Chromium 四环境 | 61 通过 / 11 设计跳过（手机不跑桌面断点、成本只在参考环境）/ 0 失败 | [命令](checks/composer-chromium-2.txt)、[归档](composer-run/chromium/summary.json) |
| 代表场景，WebKit 四环境 | 60 通过 / 12 设计跳过 / 0 失败 | [命令](checks/composer-webkit.txt)、[归档](composer-run/webkit/summary.json) |
| 状态对照 | 388 个状态，0 个几何或计算样式差异 | [composer-summary.json](composer-summary.json) |
| 截图 | 584 张对照中 567 张逐像素相同；其余 17 张全为 Chromium 评论框首绘（空闲/禁用/清空后），每通道差≤2；重绘后全部相同 | 同上 `pixels` |
| 镜像探针 | 两侧每例数值相同。纯文本、多行、长句、中文：所有环境 0 像素；含芯片：Chromium 163–166、WebKit 0（芯片 span 与整段文本分开排字，两侧相同）；15 行滚动后：Chromium 手机 1 像素，两侧相同 | 同上 `mirrorProbe` |
| 输入行为 | 5 个用例 × 8 环境，两侧逐步记录完全相同（摘要脚本独立复核） | 同上 `inputBehaviour` |
| 过渡 | 正常动效：评论框 Shift+Enter 与未聚焦会话框的高度动画均为 300ms ease，两侧相同；聚焦输入时会话框无高度动画。减少动态效果：AntD 0.3s，Orbit 0s | 同上 `motion`/`reducedMotion` |
| 共享文本控件 | controls 32/32；P2.1 弹层 [96/96](checks/overlays-regression.txt) | [controls](checks/controls-matrix-2.txt) |
| 项目合并检查 | `npm run build -w @orbit/web && npm run test -w @orbit/web`：构建通过，Vitest 320 文件/3987 用例通过 | [merge-check](checks/merge-check.txt) |
| 静态扫描 | Textarea.tsx/TextControls.css 无 antd、`.ant-*`、内部 ref；业务中剩余的 3 处内部 ref 读取即 P3.2/P5.3 待切换处，另 1 处在夹具 AntD 对照侧 | [static-scan](checks/static-scan.txt)、[审计摘要](checks/antd-audit-summary.txt) |
| 夹具类型检查 | 通过 | [composer-types](checks/composer-types.txt) |

## 真实页面：同提交对照

直接运行 P0 页面矩阵 ([p0-regression](checks/p0-regression.txt)) 得到 37 个截图不符；它们与本任务无关——在**未改动的项目 tip** 上生成的 252 张参考截图里已有 137 张与不可变的 P0.2 基线不同（如设置页新增 Smart model selection 开关），见 [reference-manifest.json](p0-same-commit/reference-manifest.json)。因此本任务不覆盖 P0.2 基线，而用 P0 原测试和固定数据做同提交对照：[p0-reference.config.mjs](p0-reference.config.mjs) 只把截图目录换成临时目录，先在 tip 的独立工作树生成参考集，再以 0 像素容差比较。

| 运行 | 结果 |
| --- | --- |
| tip 生成参考集 | 99 通过；2 个失败是 P0 场景 `getByText('Name saved' / 'Setting saved', {exact:true})` 偶发同时匹配通知与其读屏副本（既有不稳定，非截图），单独补齐缺失的 2 张后共 252 张 |
| 对照组：tip 自身对参考集 | 101 通过 / 11 跳过 / 0 失败 |
| 交付提交 `9b20343a5` 对参考集 | 100 通过 / 1 失败（同一读屏副本偶发），单独重跑该用例通过；全部截图一致 |
| **真实页面替换**：交付提交 + [swap.patch](real-page/swap.patch)（WorkspaceView 会话输入框与 TaskDetailPanel 评论框改用 Orbit Textarea，3 处内部 ref 改为原生 ref） | 100 通过 / 1 失败（设置页同一偶发），重跑通过；**8 环境的 task 与 session 场景及 959/961 断点全部 0 像素一致**，包括空闲、流式、两行输入、附件菜单、暂存附件、发送失败通知和评论框 |

P0 记录的 textarea 计算样式另行比较（[脚本](real-page/compare-textarea-styles.py)）：交付提交 112 次采集 0 差异；替换后差异只有 `transitionDuration`（88 次，减少动态效果规则）和 WebKit 16px 时的 `lineHeight` 字符串 `25.142857px`→`25.142879px`（24 次）。后者来自生产构建的 CSS 压缩器把 P1.2 共享规则的 `line-height: 1.5714285714` 写成 `1.57143`（lightningcss 对任何数字写法包括自定义属性都保留 6 位有效数字），而 AntD 在运行时注入全精度值；两者落在同一个 1/64px 布局单位（1609/64），行框与截图均相同。替换树上的 WorkspaceView/TaskDetailPanel/ComposerMirror 现有单测 45 文件/434 用例全部通过（[记录](checks/unit-real-page-swap.txt)），说明切换无需改这些用例。

## 成本对照

- 定制代码：Textarea.tsx 19→137 行（自动增高测量连注释约 90 行），TextControls.css +28/−7 行，index.css 在既有规则上增加 8 个选择器；取代的 AntD/rc 实现为 rc-component/input 的 TextArea/ResizableTextArea/calculateNodeHeight/BaseInput 568 行及 antd TextArea/样式 272 行。验证夹具与用例约 1,500 行，属可复跑的验证入口。
- 包体积（[bundle-size](checks/bundle-size.txt)，初始 HTML 引用资源，逐文件 gzip -9）：tip JS 1,006,802 / CSS 65,152 字节；交付提交只多 CSS 选择器（gzip +43；JS 仅资源哈希引用变化，+2）；替换两页后 JS +1,073、CSS +584 字节 gzip。其它页面仍用 AntD TextArea，AntD 输入代码不会因此离开包，节省要到 P6 才能实现。
- 每次按键的同步工作（Chromium 明亮桌面，30 次真实按键，原生 input 事件到 React 提交及自动增高测量完成）：AntD 中位 5.1ms / Orbit 2.8ms（1 行草稿），AntD 6.6ms / Orbit 3.8ms（200 行到顶草稿）；到第二帧的总时延两者相同（约 31ms，受帧节拍与 Playwright 往返支配）。数字来自 Vite 开发服务器、React 开发构建与 StrictMode，只用于同条件相对比较，不代表生产绝对值。

## 交给 P3.2 / P5.3

- [swap.patch](real-page/swap.patch) 即两页的最小切换：引入 `ui/Textarea`、`useRef<HTMLTextAreaElement>`、3 处 `taRef.current`、`Input.TextArea`→`Textarea`，其余 props（variant/autoSize/style/maxLength/事件）原样可用；同提交 P0 对照与现有单测已通过。切换后删除 index.css 中对应的 `.ant-input` 选择器。
- 现有行为原样保留并已记录：到顶判定只随文本/手动高度重算，宽度变化不重算；placeholder 变化不重测；评论框 `@` 菜单不检查 isComposing。这些属于业务现状，本任务未改。
- 夹具 AntD 对照侧随其它夹具在 P6 删除；当前清单中该文件的 1 处内部 ref 命中属于对照用途。

## 边界

- 不确立真机 iOS/Android 软键盘、原生输入法候选窗、Safari 在提交候选后的 keyCode 229 Enter 时序；Chromium 组合输入走 DevTools 真实事件，WebKit 为事件重放。P5.3 仍须按原验收做真机记录。
- 夹具用照录的键位/菜单代码代表页面；真实页面只经 P0 场景覆盖空闲、两行输入、附件、通知与评论框外观，以及替换后的单测，没有在真实页面重跑全部输入行为用例。
- P0 场景 `getByText` 的读屏副本偶发与 P0.2 基线漂移是项目既有状况，本任务未修改 P0 历史基线、断言或预期失败标记。
- 没有部署或发布；完成判定交由任务的 EVIDENCE_JUDGMENT，不直接写 DONE。

## 复跑

```sh
bash scripts/worktree-overlay.sh
node node_modules/typescript/bin/tsc -p src/web/ui-migration/composer.tsconfig.json --noEmit
NO_COLOR=1 npm run test:ui-composer -w @orbit/web
node src/web/ui-migration/collect-composer-evidence.mjs /tmp/new-composer-evidence
NO_COLOR=1 npm run test:ui-controls -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
# 同提交 P0 对照：在参考树与被测树的 src/web/ui-migration/ 放入 p0-reference.config.mjs，各自先 build
P31_SNAPSHOTS=/tmp/ref P31_OUTPUT=/tmp/out npx playwright test --config ui-migration/p0-reference.config.mjs --update-snapshots=all   # 参考树
P31_SNAPSHOTS=/tmp/ref P31_OUTPUT=/tmp/out2 npx playwright test --config ui-migration/p0-reference.config.mjs --update-snapshots=none # 被测树
python3 docs/evidence/base-ui-migration/p3.1/real-page/apply-swap.py <scratch checkout>   # 真实页面替换
```

[run-check.py](run-check.py) 为每条命令保存 argv、时间、提交、工作区改动、源码哈希、退出码与完整输出，`ROOT=` 用于临时工作树；[summarize.py](summarize.py) 只读已归档附件并逐个核对 SHA-256。
