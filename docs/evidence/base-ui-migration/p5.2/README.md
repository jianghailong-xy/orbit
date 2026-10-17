# P5.2 消息图片预览与富内容

服务于 [P5.2 迁移消息图片预览与富内容界面](orbit-task:34Za39Mm04q5p66pqUTtj)，项目验收条目 key `4Un2KxG0vLBv3dXWCfnqwK`：**P5：会话工作区完成迁移，输入、附件、富内容、消息操作及滚动导航行为无迁移回归。** 本任务承担其子范围：现有授权图片和预览组行为、消息富内容及流式呈现保持一致；对象 URL 清理与加载/错误状态可验证，Transcript 相关回归和视觉对照通过。

本批接在项目 tip `d580e572d` 上，13 个提交：9 个自己的，4 个合并（origin/main `ab47a1c11`、`9498167b9` 各一次，移动后的项目 tip `d354b64c5`、`951882866` 各一次）。交付 `211949ed8`，之上是本目录所在的提交，见[提交](#提交)。本批自己的应用与单测代码从 `c0317ce3c` 起没有再变，之后只改了用例文件里的一个选择器（`d9ffa6502`）。

## 结论

| 验收要点 | 结果 |
| --- | --- |
| 授权图片与预览组行为一致 | Transcript 的图片与查看器改由 Orbit 的 `Image`、`ImagePreview`（`components/ui/`，Base UI Dialog）画出，`Transcript.tsx` 不再导入 antd。同提交对照（交付对撤回业务切换的参照，Chromium/WebKit × 明/暗 × 桌面/手机 8 个环境）最终轮 f7 在交付 `211949ed8` 上，两棵树都是 56/56 通过：240 张截图里 210 张逐字节相同，3 张抗锯齿级，27 张超出，逐张归了类（[对照结果](#对照结果)）。trace 516 步里语义不同的 12 步都来自 Tab 循环。翻页、两端停住、按钮/滚轮/双击/拖动/双指缩放与回弹、转动与翻转、关闭方式、打开时的焦点、关闭后焦点回到缩略图、滚动锁、Back 都相同。 |
| 消息富内容与流式呈现一致 | Markdown、工具卡片与输出、审批与结果卡片本来就是自有实现，本批没有改动；清单里 `reviewPhase` 为 P5.2 的 10 个自有实现逐个核对，没有 AntD（[自有实现的核对](#自有实现的核对)）。流进来的回合按次序画出：会话的 16 行，8 个环境两棵树逐字相同。中途的截图是查看器的最后一页。图片晚到时会话仍停在尾部，f7 两棵树每次观察到尾部的距离都是 0。 |
| 对象 URL 清理与加载/错误状态可验证 | 授权获取与对象 URL 的生命周期仍在业务侧，没有改动。单测断言：卸载时撤销，卸载后才到的立即撤销，取到之前与取不到时都是占位。浏览器 trace 里每步的创建、撤销、存活数两棵树相同，Back 之后没有撤销的为 0。附件与产物的请求带 bearer，分享页的不带。取不到的附件留占位，取不到的产物退回文件条，被截掉的截图先转圈再画出。 |
| Transcript 相关回归与视觉对照通过 | 都在交付 `211949ed8` 上：合并检查构建成功，Vitest 392 个文件、5136 个用例全部通过；OrbitKit 3631 个测试 0 失败。P0 严格比较 101/101，交付在 P0 页面上与参照逐像素相同。标准 P0 交付与项目 tip `951882866` 的失败相同：28 个，是 main 带来的漂移，已交给 [第 8 批](orbit-task:34dI9lY63LC7ZEZHbJ4bG)。见[合并检查与 P0](#合并检查与-p0)。 |
| 迁移清单 | P5.2 的使用点从 11 个到 0 个；交付上 `--check-owners` 0 未归属、0 待定。范围外报出的 2 个点按协调者判定记入 `2026-10-10.json`、`2026-10-10b.json`，都归 P5.3（[迁移清单](#迁移清单)）。 |
| 给 WorkspaceView 复用 | `Image`（单张、带遮罩、自己打开查看器）与 `ImagePreview`（受控、可成组）在 `components/ui/`，用法写在 `ui/README.md`。输入框里“放回”的图片已经在用 `Image`；P5.3 换掉输入框新选图片的 AntD `Image` 时可以直接复用。 |

未消除的差异有 5 条，其中查看器的 Tab 循环已由协调者确认接受（[未消除的差异](#未消除的差异)）；没有确立的部分见[未确立的部分](#未确立的部分)。

## 范围

开工时按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`。P5.2 负责的使用点 11 个（逐点见 [checks/owner-points.txt](checks/owner-points.txt)）：

- 生产文件 1 个：`components/Transcript.tsx`（`import { Image } from 'antd'`，会话级预览组 `Image.PreviewGroup` 与单张 `Image`，以及三处提到 AntD 的注释）。
- 测试 4 个：`BackgroundWakeSteer.test.tsx`、`QueuedUserTurn.test.tsx`、`Transcript.backgroundWake.test.tsx`、`Transcript.settledReply.test.tsx`，都只用 antd 的 `App` 包裹被测组件。
- index.css 6 处命中（4 行）：`.chat-images .ant-image`、`.md .ant-image` 两条规则与两段提到 `.ant-image` 的注释。

清单里另有 10 个已是自有实现、`reviewPhase` 为 P5.2 的文件（`BackgroundJobsNote`、`BackgroundWakeCard`、`OrbitLinkCard`、`ReferencedTaskNote`、`SessionCreatedTasksStrip`、`SessionMessageCard`、`SessionReplyCard`、`TaskStartCard`、`WatchWakeCard`、`WikiContextNote`），按“已有自有实现以核对复用为主”核对，见[自有实现的核对](#自有实现的核对)。

范围外、本批只读不改的：会话工作区 `WorkspaceView`（P5.3，包括输入框里新选的图片用的 AntD `Image` 与 `.composer-attach .ant-image*` 两条规则）、会话侧栏/搜索/输出（P5.1），以及 `main.tsx` 的 `ConfigProvider`/`App`、`theme.ts`（P6）。

## 跟上 origin/main

| 时间（UTC） | 基础 | 说明 |
| --- | --- | --- |
| 10-10 00:31 开工 | 项目 tip `d580e572d`（已含 origin/main `46e28aaa3`） | 分支就在项目 tip 上，无需跟进；`--check-owners` 报出 main 带来的 1 个未归属点 `WorkspaceView.recapRow.test.tsx`，协调者判归 P5.3，由本批记入 `2026-10-10.json`（见[迁移清单](#迁移清单)） |
| 10-10 01:38（最终轮之前） | origin/main `ab47a1c11`（`46e28aaa3` 之后 34 个提交，含 T7 引擎/Provider `3a3c58c1f`、每轮的 worked-for 行 `d2e295917`、批次卡片的计划画布 `c26b69643`） | 项目 tip 不在 main 里，按规则在项目 tip 上合并 origin/main（`378b7033e`）。唯一文本冲突是 `WikiSettingsPage.tsx` 的导入块（P4.4 的 Orbit 导入对 T7 的 `providerEngines` 导入）；main 在 `WikiSettingsPage.test.tsx` 新加的用例查 AntD 的 DOM，在已迁移的页面上会失败。两个文件都取协调者为同一冲突做的晋升同步 `2fcd654d8` 的解，逐字节相同（[checks/merge-main.txt](checks/merge-main.txt)）。`Transcript.tsx` 与 index.css 自动合并，main 的改动与本批的不在一处。合并后 `--check-owners` 报出 T7 带来的 1 行 index.css，协调者判归 P5.3，由本批记入 `2026-10-10b.json`。 |
| 10-10 03:22（f4 进行中） | origin/main `9498167b9`（`ab47a1c11` 之后 23 个提交，其中 `94f61b52c` 改了 Transcript.tsx：回答过的提问记下问了什么、怎么答的） | main 改到了本批自己的文件，按规则再跟一次：`git merge-tree` 干跑无冲突，合并 `c0317ce3c`，没有手改（`--remerge-diff` 为空）。main 的改动在 ToolView 的提问卡片与 index.css 的新规则，不碰图片。合并后 `--check-owners` 0 未归属、0 待定。f4 中止，最终轮 f5 在这个合并上重跑全部检查。 |
| 10-10 04:15（f6 进行中） | 项目 tip `d354b64c5`（协调者把晋升同步 `2fcd654d8` 与 origin/main `9498167b9` 合并） | 项目线移动了，合入它（`9b28cd9c0`）。它的树与最终轮的起点 `1d97733fb` 逐字相同（`3793066ae`）。`git merge-tree` 干跑无冲突，结果就是本分支自己的树，所以合并没有改动任何文件，f5、f6 的检查仍对应 `9b28cd9c0` 的树；项目 tip 到它的差异只有本批的文件。协调者确认这次合并（项目线已含 T7 的晋升同步，落地时不会再碰到 WikiSettingsPage 的冲突）。 |
| 10-10 04:31（交证据前） | 项目 tip `951882866`（Select 关闭与任务列表工具栏一批落地：Select 用指针打开时高亮第一项、对话框 Close 的悬停底色、批量条下工具栏的高度） | 干跑在 P0 矩阵 `playwright.config.mjs` 的 `testIgnore` 一行冲突：两边都在末尾加了一项。合并 `211949ed8`，两项都保留，项目线的在前；`ui/README.md` 两边改的是不同段落，自动合并。这一批与本批的文件不交，但改到了 `src/web`，所以最终轮 f7 在这个合并上重跑全部检查（P5.2 对照、P0、合并检查、OrbitKit），起点就是项目 tip `951882866`。合并后 `--check-owners` 0 未归属、0 待定。 |

- 交证据前又看了一次（05:22Z，[checks/merge-tree-newest-main.txt](checks/merge-tree-newest-main.txt)）：项目线仍是 `951882866`，已在交付里。origin/main 前进到 `23bdaa967`：其中 `bcf00ab95` 是本项目线的晋升，与 `951882866` 同树；其余是另一个项目的 Android 改动和提问卡片的 iOS/macOS 证据（src/android 22 个文件、src/macos 3 个、docs 15 个），不碰 src/web、src/shared，也不碰本批的文件。干跑无冲突，按规则不再跟，只记录干跑结果。05:28Z 交证据前 main 又前进到 `cc16cb214`，新增的仍是提问卡片的客户端与证据（src/android、src/macos、docs），结论相同。
- 四次合并的完整记录在 [checks/merge-main.txt](checks/merge-main.txt)：干跑、合并的父提交、`--remerge-diff`（只有冲突的解）、与协调者同步的逐字节比较、项目 tip `d354b64c5` 与 f5 的起点同树，以及起点和项目 tip 到交付的差异都只有本批的文件。

## 提交

| 提交 | 内容 |
| --- | --- |
| `a5be9e4f8` | **feat：公共组件 `ImagePreview` 与 `Image`**（`components/ui/`，见[公共组件](#公共组件)），单测 13 个，`ui/README.md` 一节，`rc-image.LICENSE`。此时还没有调用方。 |
| `2699c6149` | **feat：业务切换。** `Transcript.tsx` 不再导入 antd；index.css 本批 4 行改写，另加输入框里“放回”的图片缩略图两条规则；4 个测试去掉 AntD `App` 包裹；新增 `Transcript.imagePreview.test.tsx`（6 个用例）。 |
| `08a8964da` | **test：同提交对照用例** `p52.browser.mjs`、`p52-fixtures.mjs`、`p52.config.mjs`；P0 矩阵忽略 `p52*`。 |
| `f77a538a9` | **docs：清单记录 `2026-10-10.json`**（`WorkspaceView.recapRow.test.tsx` → P5.3），生成脚本 `build-record-10.py` 与该次扫描的审计。 |
| `378b7033e` | **合并 origin/main `ab47a1c11`**，见上表。 |
| `e6420070b` | **docs：清单记录 `2026-10-10b.json`**（index.css `.ant-dropdown-menu-item.composer-provider-gone .scope-menu-row` → P5.3），生成脚本 `build-record-10b.py` 与该次扫描的审计。 |
| `363209cb5` | **test：** 用例里“打开时滚轮不滚动后面的页面”一步只在桌面跑（Playwright 在手机 WebKit 里没有滚轮，正式轮 f1 在两棵树的 WebKit 手机上都停在这一步）。 |
| `001220037` | **test：** 每次观察前等会话的滚动停下；关闭的动效采样到查看器消失为止（f2 的两处差别出在测量上，见[开发中对照找到并修正的差异](#开发中对照找到并修正的差异)下的说明）。 |
| `924a5c564` | **fix：** `Image` 的外层与遮罩改为 span，Markdown 图片在 `<p>` 里仍是合法 HTML（合并检查输出里的 React 警告）。 |
| `c0317ce3c` | **合并 origin/main `9498167b9`**，见上表。 |
| `d9ffa6502` | **test：** 流式用例的“rows in order”一步改为列出会话的行（原选择器选到的是滚动容器本身，两棵树都只记下容器，什么也没比较）。 |
| `9b28cd9c0` | **合并项目 tip `d354b64c5`**，不改动文件，见上表。 |
| `211949ed8` | **合并项目 tip `951882866`**，解 `testIgnore` 一行的冲突，见上表。交付。 |
| 本目录所在的提交 | **docs：本目录。** |

- 撤回 `2699c6149` 就恢复 Transcript 的 AntD 图片，同提交参照树正是这样得到的。
- `a5be9e4f8` 单独存在时没有业务页面用到新组件。

## 公共组件

用法写在 [components/ui/README.md](../../../../src/web/src/components/ui/README.md)「图片与预览（P5.2）」。

### ImagePreview（替代 `Image.PreviewGroup` 与 `Image` 自带的预览）

| 方面 | 实现 |
| --- | --- |
| 结构与外观 | 与被替换预览逐部件相同：根 `position: fixed; inset: 0`，字体取应用字体 14px（被替换根上的 `font-size: 14px` 来自 AntD 的 `genCommonStyle`），文字居中、不可选；45% 黑遮罩；图片最大为窗口宽度与 70% 高度；右上角关闭键、两侧切换键是 42px 圆键（12px 内边距、18px 图标、10% 黑底，悬停 20%，距边 12px，切换键在两端时 25% 白、透明底、`not-allowed`）；距底 32px 处是 65% 白的“n / 总数”与 42px 按钮的胶囊（24px 左右内边距、12px 间距、10% 黑底），按钮次序与图标同被替换预览（上下翻转、左右翻转、左转、右转、缩小、放大）。焦点环用 Orbit 控件的 3px 焦点色（等于 AntD 的 `colorPrimaryBorder`、`lineWidthFocus`）。计算样式与被替换预览逐项比对，见 `probe/`。 |
| 翻页 | `group` 时显示“n / 总数”，多于一张时两侧有箭头；←/→ 在 window 上监听（同被替换预览），所以在两端被禁用的箭头失去焦点、焦点落到页面后，按键仍能翻页；到两端即停。翻页时新图以原尺寸立即出现（那一帧不过渡）。 |
| 缩放、拖动、触摸 | 按钮每次 1.5 倍、1–50 倍；滚轮按 deltaY 缩放并以指针为中心；双击在原尺寸与以指针为中心的 1.5 倍间切换；拖动移动，松开后回弹到窗口边缘或居中；双指缩放、单指移动，抬起后回弹，缩到原尺寸以下时弹回。算法逐行移植 rc-image 1.10.0（`useImageTransform`/`useMouseEvent`/`useTouchEvent`/`getFixScaleEleTransPosition`，MIT，见 `ui/rc-image.LICENSE`），同一帧内的多次改变在下一帧一起生效，后者覆盖前者，与原实现相同。 |
| 关闭与焦点 | 关闭键、Esc、按遮罩关闭，按图片不关；打开时焦点在关闭键（同被替换预览：rc-util 的焦点锁把焦点放到第一个可聚焦元素），关闭后回到打开前的元素。基于 Base UI Dialog：模态焦点、Esc、文档滚动锁、弹层层级沿用本目录约定，顶层 z-index 1080（被替换预览的 1000+80），在 Orbit 弹层里按层递增；打开期间登记为通知的挂载层，与 Orbit 对话框相同。 |
| 动效 | 允许动效时同被替换预览：打开 0.3s 渐显、图片从按下的缩略图中心（`origin`）放大，关闭反之；缩放、旋转 0.3s `cubic-bezier(.215,.61,.355,1)`；按钮 0.3s。减少动态效果时都不播放（同 P2.1 起 Orbit 弹层的约定；被替换预览不管这个设置照样播放）。 |
| 可访问名称 | 按钮：Close、Previous image、Next image、Flip vertically、Flip horizontally、Rotate left、Rotate right、Zoom out、Zoom in；对话框以当前图片的 alt 命名，没有 alt 时为 Image preview。被替换预览的按钮名是图标名（close、left、right）与内部键名（flipY 等），组预览的对话框没有名称（见[未消除的差异](#未消除的差异)）。 |

### Image（替代单张的 `Image`）

外层 `span.orbit-image`（行内块、`role=button`、`tabIndex=0`、以 alt 命名、Enter/Space 打开），内层 `img.orbit-image-img` 加调用方的类（`chat-image`、`md-image`、`composer-attach-thumb`），之后是 `span.orbit-image-cover`（30% 黑底白字，悬停与键盘聚焦时显示，0.3s）。被替换组件画的是 div；改成 span、由 CSS 给出同样的 display，Markdown 图片放在 react-markdown 的 `<p>` 里时仍是合法 HTML，排版不变。与被替换组件一样，`.orbit-image .orbit-image-img` 以两个类的权重给图片 `width: 100%; height: auto; vertical-align: middle`，压过调用方单个类的宽高——例如输入框里的 48px 方块，图片按自身比例只占上部，下方是遮罩色（被替换组件同样如此，见截图 `p52-composer-chip`）。根上 14px 应用字体同被替换组件。按下时打开自己的 `ImagePreview`（无位置、无箭头），从按下处的中心放大。

两者都不取图、不持有对象 URL：授权获取与对象 URL 的生命周期仍在业务侧。

## 业务切换

| 位置 | 之前（AntD） | 现在 |
| --- | --- | --- |
| 会话级预览组 `ImagePreviewProvider` | `Image.PreviewGroup`，受控 `visible/current`，`items` 是 src 字符串 | `ImagePreview group`，受控 `open/current`；缩略图登记时带上 alt，所以查看器以图片命名。点击时按 seq 冻结列表、打开在被点的那张，不变。 |
| 单张 `ChatImage`（Markdown 图片、会话产物图片、排队中的回合、输入框里放回的图片） | `Image`，`preview.mask` 为 `<span class="chat-image-mask">👁 Preview</span>` | `Image`，`cover` 为同一个 mask |
| 组内缩略图 `GroupedChatImage` | 自有 `button.chat-image-btn`（P5.2 前已是自有实现） | 不变，只是登记时多传 alt |
| 授权获取与对象 URL | `ResolvedAttachmentImage`、`LocalArtifactImage`、`resolveFileObjectUrl`（15s 超时、晚到即撤销） | 不变 |
| 加载与失败 | 占位 `chat-image-loading`/`md-image-loading`/`chat-result-image-loading`；附件取不到时占位不变；产物图片取不到时退回可重试的文件条 | 不变 |
| 静态导出 | 纯 `<img>`，无预览 | 不变（单测断言输出里没有 `role="button"`、`orbit-image`、`role="dialog"`） |
| index.css | `.chat-images .ant-image`、`.md .ant-image` 圆角裁切与放大镜光标；两段注释提到 `.ant-image` | 同样的声明改挂 `.orbit-image`；注释改写。新增 `.composer-attach .orbit-image`（48px 方块）与 `.composer-attach .orbit-image-cover`（圆角继承），给输入框里放回的图片缩略图用，与旁边仍给 WorkspaceView 自己的缩略图用的 `.composer-attach .ant-image*` 两条（P5.3 的点）声明相同 |

层叠：两份组件样式在 index.css 之后加载。本批页面规则都比组件规则多一个类（`.md .orbit-image`、`.chat-images .orbit-image`、`.composer-attach .orbit-image`），组件规则 `.orbit-image .orbit-image-img` 又比页面的单类规则（`.md-image`、`.chat-image`、`.composer-attach-thumb`）多一个类，与被替换组件的权重关系相同，所以加载次序不影响结果。

## 自有实现的核对

清单里 `reviewPhase` 为 P5.2 的 10 个文件已是自有实现，本批只核对、不改：交付的审计（[checks/record-10b-audit.json](checks/record-10b-audit.json)）里，它们只导入独立图标包（`ReferencedTaskNote`、`WikiContextNote` 什么也不导入），没有 antd 导入、`.ant-*` 类或选择器、内部 ref。它们的单测都在合并检查里通过：

| 文件 | 画什么 | 覆盖它的单测 |
| --- | --- | --- |
| `BackgroundJobsNote` | 后台任务的折叠条目 | `Transcript.backgroundJobs.test.tsx` |
| `BackgroundWakeCard` | 后台任务唤醒的结果卡片 | `Transcript.watchWake.test.tsx`、`WorkspaceView.stickyWake.test.tsx`；`BackgroundWakeSteer.test.tsx`、`Transcript.backgroundWake.test.tsx`（本批去掉了它们的 AntD `App` 包裹） |
| `OrbitLinkCard` | 链接到任务/项目/会话/Wiki 的卡片 | `OrbitLinkCard.test.tsx`、`WikiContextNote.test.tsx` |
| `ReferencedTaskNote` | 引用任务的摘要 | `Transcript.referencedTask.test.tsx` |
| `SessionCreatedTasksStrip` | 会话建的任务条 | `SessionCreatedTasksStrip.test.tsx` |
| `SessionMessageCard` | 别的会话发来的消息 | `SessionMessageCard.test.tsx`、`QueuedUserTurn.test.tsx`、`WorkspaceView.sessionMessageQueue.test.tsx` |
| `SessionReplyCard` | 请求的回复 | `SessionReplyCard.test.tsx`、`SessionReplyCard.queued.test.tsx`、`QueuedUserTurn.test.tsx` |
| `TaskStartCard` | 任务运行的开场 brief | `TaskStartCard.test.tsx`、`QueuedUserTurn.test.tsx`、`WorkspaceView.taskStartWaiting.test.tsx` |
| `WatchWakeCard` | 关注触发的唤醒 | `Transcript.watchWake.test.tsx` |
| `WikiContextNote` | 会话收到的 Wiki 上下文 | `WikiContextNote.test.tsx` |

Transcript 里其余的富内容（Markdown 与代码块、工具卡片与输出、审批与结果卡片、子工作区）同样是自有实现，本批没有改动；同提交对照的运行时普查在交付的会话区里一个 AntD 类也没找到（见[同提交对照](#同提交对照)）。

## 同提交对照

方法沿用 P4.3a/P4.4 的同提交对照：参照树 = 交付撤回业务切换 `2699c6149`（Transcript 回到 AntD 的 `Image`/`Image.PreviewGroup`，新组件、用例与其余一切同交付），两棵树各自生产构建，同一个用例文件 [`p52.browser.mjs`](../../../../src/web/ui-migration/p52.browser.mjs) 在 Chromium/WebKit × 明/暗 × 桌面（1280×900）/手机（390×844，触屏）8 个环境、减少动态效果下各跑一遍，比较截图（逐像素）、截图时记录的计算样式，以及每一步的观察（trace）。浏览器、字体与 P0 环境校验同 P0.2。

**固定数据**（[`p52-fixtures.mjs`](../../../../src/web/ui-migration/p52-fixtures.mjs)）：把 P0 会话的记录换成一段带齐各种图片的对话。一个回合的两张附件经 `/api/attachments/:id` 取（带 bearer），第二个回合的一张取不到（404）；回复里一张 `orbit-attachment:` 的 Markdown 图片、一张会话产物图片（经 `/api/sessions/:id/artifacts`），另一张产物取不到（502，退回文件条）；工具结果里一张内联截图，一张字节被服务器截掉、卡片打开时经 `/events/:seq/full` 取回；一条未送达的消息带一张图片，可“放回输入框”；同一段对话经会话分享链接公开（`/api/shared/:token/...`，不带 bearer）；另有一个在会话打开时流进来的回合（用户图片、流式文字、中途的截图、收尾）。图片是生成的 PNG：四色象限加一角深色标记，转动或翻转一眼可见，按尺寸命名。

**用例**（每个环境 7 个）：
1. 加载：附件取回之前的占位与被截掉截图的转圈，取到后的样子，失败的占位与文件条，悬停（桌面）与键盘焦点环；
2. 查看器：从第二张打开，→、箭头、两端，按钮/滚轮/双击缩放、拖动与回弹（桌面）或双指缩放、单指移动、缩到原尺寸以下后弹回（手机），左右转、翻转，转过之后翻页回到原尺寸，按钮悬停（桌面），Tab 与 Shift+Tab 的顺序，打开时滚轮不滚动后面的页面（桌面），Esc、按图片不关、Close、遮罩；
3. 单独打开：Markdown 图片（→ 不翻页）、会话产物图片放大并转动、放回输入框的图片缩略图（悬停、打开、移除）；
4. 尾部与流式：图片晚到时会话仍停在尾部，流进来的回合按次序画出、中途的截图加入查看器最后一页；
5. 返回：从任务列表进入会话、打开查看器后浏览器 Back：回到任务列表、查看器随之消失、滚动锁解除、对象 URL 全部撤销；
6. 动效（允许动效）：打开时渐显并放大、缩放的缓动、关闭时渐隐，以及放大、转动后的截图；
7. 分享页：同样的图片经公开路由画出，查看器打开、翻页、关闭。

**每步记录**：地址；焦点（查看器按钮记 Orbit 的名称）；查看器的位置文字、当前图片、图片的 transform 与盒、按钮及禁用；滚动锁；会话里每张图片（所在行、哪张、页面给的类、属于组还是单独打开、盒）；占位；文件条；滚动位置与到尾部的距离；对象 URL 的创建/撤销/存活数；请求（是否带 bearer）；会话区、输入框附件与查看器里 AntD 类的运行时普查。比较由 [`trace-semantics.py`](scripts/trace-semantics.py) 逐字段做，查看器的可访问名称单列。

### 对照结果

最终轮 f7（交付 `211949ed8`；参照 `ff75efcee` = 在它上面撤回 `2699c6149`）：两棵树都是 56/56 通过（[runs/p52-ref.txt](runs/p52-ref.txt)、[runs/p52-del.txt](runs/p52-del.txt)、[runs/formal-f7.log](runs/formal-f7.log)）。之前两轮的这一对结论相同，归类也相同：f6 在 `d9ffa6502` 上，209 张逐字节相同、2 张抗锯齿级、29 张超出；f5 在 `c0317ce3c` 上，208、4、28，它的流式一步没有比较到行（见[开发中对照找到并修正的差异](#开发中对照找到并修正的差异)下的说明）。

| 环境 | 截图 | 逐字节相同 | 抗锯齿级（≤2） | 超出 |
| --- | ---: | ---: | ---: | ---: |
| chromium-light-desktop | 33 | 26 | 1 | 6 |
| chromium-dark-desktop | 33 | 25 | 2 | 6 |
| chromium-light-phone | 27 | 22 | 0 | 5 |
| chromium-dark-phone | 27 | 21 | 0 | 6 |
| webkit-light-desktop | 33 | 32 | 0 | 1 |
| webkit-dark-desktop | 33 | 32 | 0 | 1 |
| webkit-light-phone | 27 | 26 | 0 | 1 |
| webkit-dark-phone | 27 | 26 | 0 | 1 |
| 合计 | 240 | 210 | 3 | 27 |

超出的 27 张逐张归类（簇的位置与大小在 [compare/p52-beyond-clusters.txt](compare/p52-beyond-clusters.txt)，每张的并排图在 [sheets/beyond/](sheets/beyond/)）：

| 类 | 张数 | 截图 | 说明 |
| --- | ---: | --- | --- |
| Tab 循环 | 8 | `p52-viewer-focus`，每个环境一张，都是 1128 px | 截图时焦点所在的按钮不同：被替换的焦点锁让 Tab 从最后一个按钮落到页面一次，Orbit 直接回到 Close，往后每一步差一个按钮。见[未消除的差异](#未消除的差异)第 1 条。WebKit 手机两张的计算样式差（焦点按钮颜色 .85 对 .65）也是这一条。 |
| Chromium 在减少动态效果下的栅格化 | 18 | `p52-viewer-zoomed`、`-turned`、`-double-click`、`-dragged`、`-pinched`、`p52-single-mock`，只在 Chromium | 这些步骤 trace 里图片的 transform 与盒两棵树逐字相同，差别只在色块边缘（3705–10567 px，见并排图里的红线）。被替换预览不管减少动态效果仍以 0.3s 过渡缩放、转动，Orbit 在减少动态效果下直接到位，Chromium 两条路径栅格化同一张放大的图不同；WebKit 四个环境这些截图逐字节相同。允许动效的用例里两边都过渡，放大与转动后的截图（`p52-motion-zoomed`、`p52-motion-turned`）在全部 8 个环境逐字节相同。 |
| 参照自己在两种渲染之间变 | 1 | `p52-composer-chip-viewer`，chromium-dark-phone | 4 px（最大差 9），在图片下边缘（y 699）。这张图参照三轮里出现过两种：f5 一种，f6、f7 另一种；交付三轮都是同一种，就是 f5 参照的那种。chromium-light-phone 的同一张在 f6 也这样变过一次，f7 两棵树相同。这一步查看器的 trace 两棵树逐字相同。 |

抗锯齿级的 3 张都在 Chromium 桌面：两张悬停的 Markdown 图片（`p52-diagram-hover`），一张第一个回合（`p52-turn-1`），11–12 px，最大差 1–2。

f5、f6 里另有一类，f7 没有出现：键盘把焦点移到 Markdown 图片后，会话停在 110 或 113（差 3px，`p52-diagram-focus`，Chromium 手机）。两棵树两种都出现过（f5 chromium-dark-phone 参照 110、交付 113，chromium-light-phone 反过来；f6 chromium-light-phone 参照 110、交付 113），是用例这一步的不确定，不是实现的差别。

**Trace**（[compare/p52-trace-semantics.json](compare/p52-trace-semantics.json)）：56 个用例、516 步。语义字段（地址、焦点、查看器的位置/图片/transform/盒/按钮、滚动锁、图片与占位、文件条、滚动、对象 URL、请求）不同的 12 步，都来自上面的 Tab 循环：8 步是 Tab 顺序（每个环境的 “keyboard order”），4 步是其后一步（桌面的 “wheel over the mask”）的焦点。其余 504 步逐字相同，包括：
- **授权图片**：附件与会话产物的请求都带 bearer（`authorization: "Bearer"`），分享页的请求都不带；取不到的附件留占位，取不到的产物退回文件条，被截掉的截图先转圈、取回后画出并加入查看器。
- **对象 URL**：每步的创建、撤销、存活数两棵树相同；Back 之后没有撤销的对象 URL 为 0（两棵树都是），所有图片的 URL 在离开会话时撤销。
- **查看器**：每一步的位置文字、当前图片、transform 字符串与图片的盒、按钮与禁用状态；打开时焦点在 Close，Esc 关闭后焦点回到被按的缩略图（8 个环境、两棵树相同）；打开时 `body` 的滚动锁（`overflow-y: hidden`，两棵树相同），滚轮不滚动后面的会话；Esc、Close、遮罩关闭，按图片不关；Back 时查看器随会话卸载、滚动锁解除。
- **流式与滚动**：流进来的回合按次序画出（`rows in order`：会话的 16 行由上到下是 seq 1 到 18，流进来的用户回合 12、中途截图所在的工具卡片与结果 14、回复 17、回合分隔 18 都在末尾，8 个环境两棵树逐字相同），中途的截图是查看器的最后一页；图片晚到时会话停在尾部（到尾部的距离 0）。
- **动效**（允许动效的用例）：打开时渐显并放大、缩放有缓动、关闭时渐隐并缩回、终态，两棵树相同。

**运行时普查**：参照在 56 个用例的 460 步里画出 AntD 的类（`ant-image`、`ant-image-preview-*` 等 27 种），交付在 516 步里一个也没有。

**可访问名称**：232 步里查看器的名称不同（参照组预览没有名称、单张是 alt；交付以当前图片的 alt 命名），按钮名称见[未消除的差异](#未消除的差异)第 2 条；两棵树各自的名称原样附在报告的 `names` 附件里。

**并排图**：[sheets/key/](sheets/key/) 是 6 个关键状态（第一个回合的缩略图、回复里的图片、组查看器、单张查看器、输入框里放回的图片、分享页的查看器）在 8 个环境的参照 | 交付 | 差异图，覆盖桌面/手机与明/暗主题；[sheets/beyond/](sheets/beyond/) 是全部超出级的对与 Chromium 的动效对照。

### 开发中对照找到并修正的差异

| 差异（参照 → 修正前的交付） | 原因 | 修正 |
| --- | --- | --- |
| 查看器底部“n / 总数”的文字大 2px、位置偏 | 被替换预览的根带 AntD `genCommonStyle` 的 `font-size: 14px` 与应用字体，Orbit 的根继承 body 的 16px | `.orbit-image-preview`（及 `.orbit-image`）设应用字体与 14px |
| 停在两端、焦点所在的箭头被禁用后，←/→ 不再翻页 | 被禁用的按钮失去焦点，焦点落到页面；被替换预览在 window 上监听方向键，Orbit 的监听挂在弹层上，Base UI 还在弹层上截住方向键的冒泡 | 在 window 上以捕获阶段监听 ←/→（只在组且多于一张时） |
| React 警告 `<p> cannot contain a nested <div>`（合并检查的输出） | react-markdown 把图片包在 `<p>` 里，`Image` 画了被替换组件同样的 div | 外层与遮罩改为 span，CSS 照旧给出 display，排版不变（`924a5c564`；f5–f7 与 f3 的截图结论相同） |

开发轮另修了用例自己的几处时序（两棵树同样）：被替换预览打开的第一帧还没开始渐显，观察前等查看器“稳定”（不透明、没有缩放、图片两帧不动且没有动画在跑）；把某行滚到顶部后会话可能被跟随尾部拉回，滚到位后再确认停住；观察前等会话的滚动停下（跟随尾部可能是平滑滚动）；关闭的动效采样到查看器消失为止（被替换预览渐隐结束才移除，负载高时超过 0.5s）；手机 WebKit 没有滚轮、不能构造 Touch，相应步骤只在能做的环境做。f5 之后又发现流式用例的“rows in order”一步什么也没比较：选择器列表里的后代组合符只作用在后半个选择器上，两棵树记下的都是滚动容器本身。`d9ffa6502` 改为列出会话的行，f6 重跑这一对。

## 单测

| 文件 | 用例 | 说的是什么 |
| --- | ---: | --- |
| `components/ui/ImagePreview.test.tsx`（新） | 13 | 查看器：打开在指定的图片、以它命名、焦点在 Close、位置“n / 总数”、按钮次序；箭头与 ←/→ 翻页并在两端停住；单张没有位置与箭头；按钮、滚轮、双击缩放，缩不到原尺寸以下；左右转与翻转；翻页时新图以原尺寸立即出现（那一帧不过渡，用 MutationObserver 读到）；拖动与松开后回到中间；Esc、Close、遮罩关闭而按图片不关，焦点回到打开前的按钮；放大后关上再开回到原尺寸；关着时不画任何东西。缩略图：以 alt 命名的按钮、图片的类、遮罩内容；按下、Enter、Space 单独打开，其它键不开；从按下处的中心放大 |
| `components/Transcript.imagePreview.test.tsx`（新） | 6 | 附件经 resolver 取得并从对象 URL 画出，取到之前与取不到时都是占位；对象 URL 随会话卸载撤销，卸载后才到的立即撤销；查看器按会话次序翻页，不管字节到达的先后；Markdown 图片与排队回合的图片单独打开；导出的 HTML 只有纯图片、没有查看器 |
| `BackgroundWakeSteer`、`QueuedUserTurn`、`Transcript.backgroundWake`、`Transcript.settledReply`（改） | 55 | 去掉 AntD `App` 包裹，其余逐字不变；被测的 WorkspaceView 只在用户操作的确认里用 `App.useApp()` 的 modal，这些用例不触发 |

已有的 Transcript 单测（`Transcript.localArtifact`、`Transcript.test` 等 16 个文件）不改、照常通过；`Transcript.localArtifact.test.tsx` 断言的 `img.md-image` 在 Orbit 的 `Image` 里仍是图片自己的类。

## 合并检查与 P0

最终轮 f7 都在交付 `211949ed8` 上（[runs/formal-f7.log](runs/formal-f7.log)），起点是项目 tip `951882866`（不含本批）：

| 检查 | 结果 |
| --- | --- |
| 合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（任务工作树，NVMe） | 通过：`tsc -b && vite build` 成功；Vitest 392 个文件、5136 个用例全部通过，输出里没有 DOM 嵌套警告（[checks/merge-check.txt](checks/merge-check.txt)） |
| OrbitKit `swift test`（`docker … swift:6.1`；文案对照测试逐字读 `Transcript.tsx`） | 3631 个测试、5 个跳过（Linux 上的 PerfBaselineTests），0 失败（[checks/swift.txt](checks/swift.txt)）。本批没有改动任何文案周围的标记 |
| P0 页面矩阵，参照写截图、交付按它 0 像素比较（`p32-reference.config.mjs`，[runs/p0-strict.txt](runs/p0-strict.txt)） | 交付 101 通过、0 失败（11 个跳过同 P0 基线）：交付在 P0 页面上与参照逐像素相同 |
| P0 页面矩阵，两棵树各自写截图后比较（[compare/p0-summary.json](compare/p0-summary.json)） | 252 对：232 张逐字节相同，17 张抗锯齿级，3 张超出（项目列表三处小块，7–13 px、最大差 4，不在会话页）。是同一张图在两次运行之间的不确定，严格比较里已按参照逐像素通过 |
| 标准 P0（原图 + 已登记层，[runs/p0-standard.txt](runs/p0-standard.txt)、[runs/p0-standard-base.txt](runs/p0-standard-base.txt)） | 交付与项目 tip `951882866` 都是 73 通过、28 失败、11 跳过：失败的 28 个用例逐个相同、首行错误相同，失败截图 27 张逐字节相同，1 张（`task-detail`，chromium-dark-desktop）只差 3 px、最大差 1（[checks/p0-standard-compare.txt](checks/p0-standard-compare.txt)）。f5（交付 `c0317ce3c`，起点 `1d97733fb`，与 `d354b64c5` 同树）、f2（交付 `363209cb5`，起点 `8f492157c`）结果相同。失败的是 session ×8、task ×8、settings ×8、断点 599 的对话框 ×4，都是 main 带来的漂移。逐页看了期望与实际：settings 多出 “Session recaps” 卡片（`83671b995`），session 的回复上方多一行 “Worked for 1s”（`d2e295917`），task 详情多一行 “Engine”，599px 对话框背后的页面随之下移（T7 `3a3c58c1f`/`e2e5196f0`）。已报告协调者（附失败清单与起点），协调者转给 [P0 漂移登记（第 8 批）](orbit-task:34dI9lY63LC7ZEZHbJ4bG) 一并登记；本批不登记、不改 P0 场景 |
| `audit-antd.mjs --check-owners`（交付） | 退出 0：0 未归属、0 待定，P5.2 没有使用点（[checks/verify-records.txt](checks/verify-records.txt) 最后一节） |

之前的 f5 在 `c0317ce3c` 上也跑了同样的全部检查，结果相同（Vitest 391 个文件、5121 个用例；那时还没合入项目线的 Select 一批）。

## 迁移清单

开工时（项目 tip `d580e572d`）P5.2 有 11 个使用点，交付上 0 个（[checks/owner-points.txt](checks/owner-points.txt)）。`--check-owners` 两次报出的范围外未归属点，按协调者 2026-10-10 的两项判定由本批登记，各一个只改 inventory-delta 的提交：

| 记录 | 点 | 归属 | 来源 | 何时消失 |
| --- | --- | --- | --- | --- |
| [2026-10-10.json](../inventory-delta/2026-10-10.json)（`f77a538a9`） | `WorkspaceView.recapRow.test.tsx`（只用 antd 的 `App` 包裹 WorkspaceView） | P5.3，status new | main `2255a5313`（会话列表 recap，0418），开工时已在项目 tip | P5.3 与其余 `WorkspaceView.*.test.tsx` 一起去掉包裹时 |
| [2026-10-10b.json](../inventory-delta/2026-10-10b.json)（`e6420070b`） | index.css 17836 `.ant-dropdown-menu-item.composer-provider-gone .scope-menu-row {` | P5.3，status new | main `3a3c58c1f`（T7），随合并 `ab47a1c11` 进来 | P5.3 把输入框的菜单换成 Orbit Menu 时（兄弟规则 `.composer-provider-fix` 已归 P5.3） |

- 两份记录分别由 `build-record-10.py`、`build-record-10b.py` 从各自扫描的审计（[checks/record-10-audit.json](checks/record-10-audit.json)、[checks/record-10b-audit.json](checks/record-10b-audit.json)）生成，重新生成逐字节相同；`verify-record.mjs` 对两份记录与 `2026-10-09c.json` 各自的审计都通过，读入全部 11 份记录后 0 未归属、0 待定；交付上 `--check-owners` 退出 0（[checks/verify-record-10.txt](checks/verify-record-10.txt)、[checks/verify-records.txt](checks/verify-records.txt)）。
- 静态入口闭包（P4.4 的 [route-closure.mjs](../p4.4/route-closure.mjs) 在交付的审计上，[checks/route-closure.json](checks/route-closure.json)）：分享的会话页 `/s/:token/c/:sessionId` 的 109 个模块里已没有导入 antd 的模块（P4.4 时它经 `Transcript` 到达 AntD 的 `Image`）。`/s/:token`、`/tasks`、`/projects`、`/runners/:id` 现在经 `TaskDetailPanel` 导入的 `BrandMark` 到达 `NewSessionProviderHero`（P5.1 的 `Popover`），是 main 的 T7 带来的链，与本批无关。

## 未消除的差异

1. **Tab 循环：被替换预览让焦点掉到页面一次，Orbit 直接回到 Close**（8 步 Tab 顺序、其后 4 步的焦点、8 张 `p52-viewer-focus`、2 处计算样式）。rc-util 的焦点锁在焦点离开后才把它拉回：查看器在 body 的最后，从最后一个按钮按 Tab，浏览器把焦点交给文档本身，没有 focusin，锁不动，焦点停在 body；再按一次 Tab 才回到 Close。Orbit 的查看器用 Base UI 的模态焦点（与 P2.1 起所有 Orbit 弹层相同），Tab 从最后一个按钮直接回到 Close，Shift+Tab 反之。焦点所在之外，按钮、翻页、关闭都相同。没有为复现那一次掉焦点去改 Base UI 的焦点管理。**协调者 2026-10-10 确认**按已接受的迁移约定处理：焦点不漏出弹层更贴合本项目已成文的约定（打开时聚焦弹层自身，关闭后回到打开者，焦点不落到 body），接受为已记录差异，不改 Base UI 的焦点管理。
2. **可访问名称**（只在可访问树里，看不见）：按钮名从图标名与内部键名（close、left、right、flipY、flipX、rotateLeft、rotateRight、zoomOut、zoomIn）改为 Close、Previous image、Next image、Flip vertically、Flip horizontally、Rotate left、Rotate right、Zoom out、Zoom in；查看器以当前图片的 alt 命名（被替换的组预览没有名称）。图标改为 `aria-hidden`，不再把 “close”“left” 之类念两遍。两棵树的原样名称见报告的 `names` 附件。
3. **跟着尾部偶发失效，是已有缺陷，两棵树都有**：正式轮 f2、f3 各有一次，参照在 chromium-light-desktop 打开会话、图片全部画完后停在离尾部 650/853px 处（交付在尾部）。为此在 Chromium 桌面各加载 22 次（[checks/tail-probe.txt](checks/tail-probe.txt)，`scripts/tail-probe.mjs`）：参照 21/22、交付 21/22 停在尾部，两棵树各有一次停在离尾部 1053px 处。是 WorkspaceView 跟随尾部的逻辑在异步图片陆续画出时偶发跟丢，不是本批引入的；f5、f6、f7 两棵树在 8 个环境都在尾部（f7 尾部用例每棵树 56 次观察，到尾部的距离都是 0）。已告知协调者，是否另建任务由协调者决定。没有查到具体原因，按项目规则与迁移回归分开记录。
4. **Chromium 在减少动态效果下的栅格化**（18 张）：见[对照结果](#对照结果)。几何（transform 与盒）两棵树逐字相同，WebKit 逐字节相同，允许动效时 Chromium 也逐字节相同。这是 Orbit 弹层在减少动态效果下不播放动效的约定带来的，没有为贴合像素在减少动态效果下保留过渡。
5. **在本批之外、参照里就有的样子，原样保留**：输入框里“放回”的图片缩略图，图片按自身比例只占 48px 方块的上部，下方是遮罩的颜色（被替换组件 `.ant-image .ant-image-img { width: 100%; height: auto }` 的权重压过 `.composer-attach-thumb` 的 48px 高与 `object-fit: cover`），见并排图 `sheets/key/*/p52-composer-chip.png`；悬停时 48px 方块里的 “Preview” 字样超出方块被裁切。Orbit 的 `Image` 按同样的权重复现，没有借迁移修改；WorkspaceView 自己新选图片的缩略图（P5.3）同样如此。

## 未确立的部分

- 只在 Linux 上的 Playwright Chromium/WebKit 里比较，没有真机，也没有用读屏软件实测。手机环境是模拟的：Chromium 手机的双指缩放与单指移动是脚本构造的 TouchEvent，Playwright 的 WebKit 不能构造 Touch（`Illegal constructor`），WebKit 手机上这几步两棵树都只记“不支持”、图片不动；手机 WebKit 也没有滚轮，那一步只在桌面跑。真机的软键盘、输入法与触摸记录按项目安排在 P5.3/P7.2。
- 同提交截图对照在减少动态效果下做；允许动效时只对照了一个用例（打开、放大、旋转、关闭各一次），动效逐帧的时序没有比较，只比较了是否渐显、放大、缓动与终态。
- 后端是固定 REST 数据与空闲的 SSE 替身，不连真实服务；授权只看请求是否带 `Authorization: Bearer`，不验证服务端鉴权。
- 跟着尾部的偶发失效（[未消除的差异](#未消除的差异)第 3 条）只在 Chromium 桌面各 22 次加载里测了频率，没有查到原因。
- 输入框里新选的图片仍由 WorkspaceView 直接用 AntD `Image` 画（P5.3 的点）；本批只证明了同一容器里由 Orbit `Image` 画的“放回”的图片与 AntD 的样子一致，切换那一处由 P5.3 做。

## 复现

```bash
# 三棵树（都在 /mnt/data）：参照 = 交付撤回业务切换 2699c6149；起点 = 项目 tip 951882866（不含本批）；del = 交付
scripts/make-trees.sh 211949ed8 2699c6149 951882866
scripts/formal.sh f7               # P5.2 对照与 P0（矩阵、严格、标准，交付与起点）；各步可续跑，日志在 /mnt/data/tmp/34Za39Mm04q5p66pqUTtj/v1/f7/<name>.txt
# 合并检查与 OrbitKit 在任务工作树上跑（211949ed8）：npm run build -w @orbit/web && npm run test -w @orbit/web；docker … swift:6.1 swift test -j 4
scripts/analyze.sh f7              # P5.2 一对与 P0 矩阵一对的比较
scripts/analyze-p52.sh f7          # 截图、计算样式、trace、逐字段语义与并排图
scripts/collect.sh f7 f7 f7        # 本目录的副本（报告去掉附件正文）
# 之前两轮：f5 = make-trees.sh c0317ce3c 2699c6149 1d97733fb（起点 1d97733fb = 2fcd654d8 合并 main 9498167b9，本地，与 d354b64c5 同树）+ formal.sh f5；
#           f6 = make-trees.sh d9ffa6502 2699c6149 1d97733fb + formal-p52.sh f6（只跑 P5.2 一对）
node scripts/tail-probe.mjs 8      # 跟着尾部的频率（两棵树各开一个 preview：参照 :4361、交付 :4362）；再跑一次 14
# 清单记录（在仓库根目录）：重新生成应逐字节相同，再核对
python3 -I docs/evidence/base-ui-migration/inventory-delta/build-record-10b.py docs/evidence/base-ui-migration/p5.2/checks/record-10b-audit.json | cmp - docs/evidence/base-ui-migration/inventory-delta/2026-10-10b.json
node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs docs/evidence/base-ui-migration/p5.2/checks/record-10b-audit.json 2026-10-10b.json
# P5.2 用例单独运行（在要比较的树的 src/web 下）：
P52_SNAPSHOTS=<dir> P52_OUTPUT=<dir> npx playwright test --config ui-migration/p52.config.mjs --update-snapshots=all
# 开发时的单环境对照与探针：scripts/dev-run.sh、dev-compare.sh、probe1.mjs、probe2.mjs、probe3.mjs
```

## 证据体积

本目录约 13 MB、138 个文件（交证据时 `du -sh`），在项目 30 MB 的上限之内：

| 目录 | 大小 | 内容 |
| --- | ---: | --- |
| `compare/` | 4.2 MB | 截图与计算样式的逐张比较（f7 的 P5.2 一对与 P0 矩阵一对）、超出级的簇、trace 的逐字段比较 |
| `sheets/` | 2.9 MB | 半尺寸的并排图：`key/` 6 个关键状态 × 8 个环境，`beyond/` 每张超出级与 Chromium 的动效对照 |
| `traces/` | 2.5 MB | 两棵树 56 个用例的每步观察（从报告里取出的 trace 附件） |
| `runs/` | 2.1 MB | 各步的日志（去掉终端颜色码）、报告摘要（`report.summary.json`，去掉附件正文）、标准 P0 的期望来源 |
| `checks/` | 1.1 MB | 迁移清单两次扫描的审计、核对输出、合并记录、P0 失败比较、合并检查与 OrbitKit 的摘要等 |
| `probe/`、`scripts/` | 0.2 MB | 被替换与 Orbit 查看器的计算样式探针，以及本目录用到的脚本 |

没有 trace.zip、截图原件或完整的 report.json；原始运行（截图、报告、日志）留在 `/mnt/data/tmp/34Za39Mm04q5p66pqUTtj/v1/`，判定之前不删。
