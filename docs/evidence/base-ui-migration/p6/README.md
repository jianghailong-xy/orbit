# P6 移除 antd 依赖、主题入口与内部选择器

服务于 [P6 移除 antd 依赖、主题入口与内部选择器](orbit-task:34Za39RS6A28G7xPqMD0p)，项目验收条目 key `7OizgUcvRPJIhroS7fHJBq`：**P6：Orbit Web 不再依赖 antd 组件运行时及其内部 DOM/选择器；独立图标包允许保留。** 本任务负责的子范围（任务验收原文）：Web 源码/样式/测试无 antd 组件引用、Provider、主题运行时、内部 ref 或 .ant-* 选择器依赖；依赖树与构建产物无 antd 运行时，干净安装/构建通过，独立图标保留。

本批接在 origin/main `f78e93f61` 上（它已含项目 tip `f1e5383b2`），6 个提交，交付 `6879542dc`；之上是本目录所在的提交，见[提交](#提交)。范围上的两处取舍由协调者 2026-10-10 判定（回复项目请求 `34dTwCz72AUihG8rDf2zd`，选「1A + 2 保留」）：共存样例里与 AntD 现场比较的用例与共存场景删除，Orbit 一侧的断言全部保留；各批同提交对照工具与其 `[class*="ant-"]` 普查保留，只改真正导入 antd 的两个入口。见[范围](#范围)。

## 结论

| 验收要点 | 结果 |
| --- | --- |
| 源码/样式/测试无 antd 组件引用、Provider、主题运行时、内部 ref、`.ant-*` 选择器依赖 | `audit-antd.mjs`：导入 antd 的生产文件 9 → 0、测试文件 3 → 0；命中行 antd 引用 84 → 0、Provider 13 → 0、主题 1 → 0、`useApp` 2 → 0、内部 ref 1 → 0、`.ant-*` 选择器 9 → 0、AntD 类名 10 → 0。`--check-retired` 的阻塞文件 37 → 0（退出码 0）；`--check-owners` 0 未归属、0 待定，归属 P6 42、KEEP 1 → 都是 0。`src/web/ui-migration`：P0 回归与六个组件样例 0 命中；各批的同提交对照工具按判定保留双选择器，13 个文件 106 行上 191 处，逐个列在[批次工具](#ui-migration-目录与批次工具)。见[迁移清单](#迁移清单)。 |
| 依赖树与构建产物无 antd 运行时 | 锁文件只删 antd 独占的 57 个条目，0 新增，改动只有 `src/web` 的依赖表；npm 自己把交付的锁文件重写成的，与 `npm uninstall antd` 写出的逐字节相同。干净安装后 `npm ls antd` 为空，`npm explain antd` 无匹配，`node_modules` 下没有 antd。构建产物里 AntD 类名、`antd` 字样、cssinjs、`ant-` 前缀、rc 组件签名都是 0（起点 10 / 4 / 6 / 48 / 1）；gzip 总量 1,302,288 → 1,215,092 B，`index.js` 592,912 → 506,310 B。见[依赖与锁文件](#依赖与锁文件)、[干净安装与构建产物](#干净安装与构建产物)。 |
| 干净安装/构建通过 | 交付 `6879542dc` 的全新检出（没有 node_modules，没有 dist）：`npm ci` 退出 0，`npm run build -w @orbit/web`（`tsc -b && vite build`）退出 0。 |
| 独立图标保留 | `@ant-design/icons` 6.3.4 与它依赖的 icons-svg、colors、fast-color、`@rc-component/util` 留在依赖树里；产物里 `anticon` 75 处。图标自己注入的样式（`.anticon`、`.anticon-spin` 与 `loadingCircle`）两棵树逐字相同。 |
| 运行时没有变化 | 同提交对照（交付 vs 撤回了运行时切换与依赖删除的参照）：8 个 P0 路由 × 8 个环境共 64 页、17,692 个元素，计算样式 0 处差异，DOM 0 处差异，根容器的文字样式与 html/body 相同；普查在参照 64 页上都只见到根上的 `ant-app`，交付 0 页。静态页面不经过的链接悬停/按下/焦点/禁用，root.css 读的变量与被替换根容器解析出的 token 两个主题逐项相同。P0 页面矩阵：两棵树都是 101 通过，交付对着参照的截图严格比较也是 101 通过；252 张截图 237 张逐字节相同、12 张抗锯齿级、3 张 Chromium 上 1–7 个像素超出（最大单通道差 13），同样的位置在同一棵树重跑两次之间也变化，252 次取证的计算样式 0 处差异。见[运行时](#运行时reset根容器与链接)、[同提交对照](#同提交对照)。 |
| 删除的对照与补偿控制 | 样例 spec 删去的 128 条断言：51 条在 Orbit 一侧原样保留，39 条是与 AntD 现场的比较，38 条属共存用例，逐条归类在 [checks/removed-assertions.json](checks/removed-assertions.json)，逐用例的表与 P1–P3 证据出处见[删除的对照与共存用例](#删除的对照与共存用例)。补偿控制：同一份删除后的 spec 在本批前（交付的父提交 `f78e93f61`，样例仍在 ConfigProvider/AntApp 与 antd reset 下画出 AntD 的一半）与本批后各跑一遍，交付再跑一遍作噪声对照。1,368 个测试里 1,365 个结果相同；toasts 的 1 个是一次性的时序红（两棵树各重复 20 次都过）；choices 的 1 个用例在两个 WebKit 手机环境红，是 P6 之前就有、因样例位置暴露的 MultiSelect 问题（四种样例隔离：父提交删掉同一个按钮也红），按协调者判定记录并另立修复任务。附件：静止状态的测量逐值相同，其余 JSON 差异都是时序（交付两遍之间同样在变）、页面位置偏移或 composer 复刻工具栏（交付上与真实会话页同为 43px）；377 张两遍稳定的截图差异都落在删掉的 legacy/AntD 元素、它们引起的位置变化或过渡中途的状态上。 |
| 合并检查、标准 P0、OrbitKit、批次工具普查 | 合并检查：构建成功，Vitest 399 个文件、5,167 个用例全部通过。标准 P0：交付与起点各 101 通过、11 跳过，期望层相同，不需要登记新的 P0 期望。OrbitKit：3,671 个测试，0 失败。批次工具普查（P4.4、P5.1、P5.2、P5.3 的用例在交付上）：2,264 步里画出 AntD 类名的 0 步。 |

未消除的差异见[已知差异](#已知差异)；没有确立的部分见[未确立的部分](#未确立的部分)。

## 范围

开工时（项目 tip `a167c2ff0`，已含当时的 origin/main `6fa5196e5`）按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`：0 未归属；P6 名下 42 个使用点，KEEP 1 个；`--check-retired` 37 个阻塞文件。逐点见 [inventory-closure.json](inventory-closure.json) 的 `before`（这里的起点是交付的父提交 `f78e93f61`，与 `a167c2ff0` 的使用点相同）：

- 运行时：`main.tsx`（`ConfigProvider`、`App as AntApp`、`antd/dist/reset.css`）、`theme.ts`（`theme.darkAlgorithm` 与两套 token，只供 ConfigProvider）。
- 死代码：`components/StatusTag.tsx`（导入 antd 的 `Tag`，P0.1 时已无引用，清单交 P6 删除）。
- index.css 9 行：≤960px 规则里的 `.ant-input`、`.ant-input-affix-wrapper input`、`textarea.ant-input` 与 `.ant-select-input` 一段（字段迁到 Orbit 以后已不匹配任何元素），另 5 行提到 AntD 的注释。
- 测试：3 个测试仍用 antd 的 `App` 包裹（`App.infrastructure`、`InfrastructurePage.overview`、`RunnerDetailPage.engines`），`boundary.test.ts` 的「公共 ui 不依赖 antd」一条，`firstPageStylesheet.test.ts` 钉住的 `antd/dist/reset.css`，另 5 个测试的名字或注释提到 AntD。
- 六个组件样例（`components/ui/__fixtures__`）与它们的 `ui-migration` 入口：每个 Orbit 控件旁边画出它替换的 AntD 控件，在 ConfigProvider/AntApp 下现场比较（P1–P3 的对照工具）。
- 其余：组件与样式里提到 AntD 的注释、许可说明里的 `antd-empty.LICENSE` 文件名、`components/ui/README.md` 的历史段落（P0.1：历史说明移入证据目录）。
- KEEP 1 个：`WikiMarks.tsx` 的注释称图标为「AntD glyph」，图标本身是允许保留的 `@ant-design/icons`。

范围上的判定（协调者，2026-10-10）：

- **1A**：b 类（与 AntD 现场比较）整个删，含共存场景（a 类）；Orbit 一侧的每一条断言都留、不弱化；删除的用例逐条列在证据里（名称、它原先证明的差异、指向 P1–P3 哪份证据）；补偿控制必须做：这些 spec 的 Orbit 一侧在本批前后两棵树上各跑一遍。
- **2 保留**：各批的同提交对照工具与 `[class*="ant-"]` 普查保留，只改真正导入 antd 的 `p43b-cards.tsx` 与 `reviews.tsx`；证据里逐个列出每个工具、用途与它对应的批次；普查保留并作为本批的运行检查；`check-retired` 若因这些字符串不归零，先报告。结果：`check-retired` 只扫 `src/web/src`、`package.json` 与锁文件，这些工具在 `src/web/ui-migration`，归零不受影响，不用再报告。
- src 里注释、测试名、README 的历史字样按 P0.1 移入证据目录，目标 `check-retired` 归零。

## 跟上 origin/main

origin/main 与项目 tip 由多个会话推送，本批开工后各动了数次：

| 时刻（UTC） | origin/main | 项目 tip | 做法 |
| --- | --- | --- | --- |
| 10-10 11:48 开工 | `6fa5196e5` | `a167c2ff0`（P5.3 合入，已含 `6fa5196e5`） | 项目 tip 不在 main 里：分支从项目 tip 开出。 |
| 12:40 | `a209ed434`（已含 `a167c2ff0`） | `a167c2ff0` | 项目 tip ⊂ main：变基到 `a209ed434`（`8ab3e2f58`）。 |
| 12:56 | `84965d622` | `f1e5383b2`（12:42，P5.3 的 P0 登记），不在 main 里 | 改为接在项目 tip `f1e5383b2` 上并合并 main。 |
| 13:17 | `f78e93f61`（13:14，项目合进 main，含 `f1e5383b2`） | `f1e5383b2` | 项目 tip ⊂ main：重建在 `f78e93f61` 上，交付 `6879542dc`；复跑 `--check-owners`：0 未归属、0 待定、归属表空。 |
| 10-10 18:05 正式轮之后 | `1f3386c8a`：`f78e93f61` 之后 42 个提交，`src/web` 下 55 个文件（含项目的主分支一组），包清单与锁文件没变 | `d3e40181e`（⊂ main，不在本批分支里） | 正式轮已开始，只预演不变基：`git merge-tree` 与 main、与项目 tip 都无冲突；预演的合并（`eeffb8e26`，本地，不推送）上 `--check-retired`、`--check-owners` 都是 0，锁文件里没有 antd 与 cssinjs，导入 antd 的只有审计自检的测试字符串与 `p51-fixtures.mjs` 的 diff 文字（与交付相同）；合并检查：构建成功，Vitest 402 个文件、5,247 个用例全部通过（`bgj_3d67f3f2fbc3`，[runs/merge-dry-check.txt](runs/merge-dry-check.txt)）。第一次跑（`bgj_2405748b7578`）报了 2 个类型错误（`mainBranch` 不在共享类型上）：临时检出的 `src/web/node_modules/@orbit/shared` 是从任务工作树抄来的绝对链接，指着任务工作树的 `src/shared`（没有 main 的这组改动）；改链到预演检出自己的 `src/shared` 后即是上面的结果。 |

`a167c2ff0` 与 `f78e93f61` 在 `src/web` 下只差 6 个文件（`referencedTask` 一组与 `copyLanguage.test.ts`，另一项目的文案工作），都不在样例与组件里。

## 提交

| 提交 | 内容 |
| --- | --- |
| `b1010a5ad` | test(web)：`App.infrastructure`、`InfrastructurePage.overview`、`RunnerDetailPage.engines` 不再用 antd 的 `App` 包裹；被测的东西早已不读它的上下文，断言不变。 |
| `8572d1a2f` | feat(web)：`components/ui/reset.css`（Ant Design 6.6.5 的 `dist/reset.css` 逐条搬来，MIT）、`components/ui/root.css`（被替换根容器给它下面一切的文字与链接）、`components/ui/AppRoot.tsx`（画出 `div.orbit-app`，内联全精度的 22/14 行高）。此提交里还没有使用者。 |
| `c4396e776` | test(web)：六个组件样例只画 Orbit 一侧，在 `AppRoot` 里、用 Orbit 的根样式与 reset；spec 删去与 AntD 的现场比较与共存用例，Orbit 一侧的断言全部保留；`p43b-cards.tsx`、`reviews.tsx` 两个批次入口改用 `AppRoot`。 |
| `3339873a7` | feat(web)：运行时切换。`main.tsx` 去掉 `ConfigProvider`（theme.ts 的 token 与 darkAlgorithm）、`AntApp`（及其 message/notification/modal holder，P5.3 以后已无人调用 `App.useApp`）、`antd/dist/reset.css`；`root.css` 排在首位、`reset.css` 在原 reset 的位置，`AppRoot` 在原根容器的位置。删除 `theme.ts`；index.css 去掉最后的 AntD 选择器与 theme.ts 的说明。 |
| `a244dfc06` | chore(web)：`src/web/package.json` 去掉 antd，锁文件只删它独占的 57 个条目；删除死代码 `StatusTag.tsx`。 |
| `6879542dc` | docs(web)：注释、测试名与 `components/ui/README.md` 里提到 AntD 的历史字样改为「被替换的 …」或代码现在做的事；原文逐行列在 [history-notes.md](history-notes.md)。`boundary.test.ts` 去掉「公共 ui 不依赖 antd」一条：包已不在依赖里，导入它在类型检查与构建时就失败。行为不变。 |

本批 65 个文件，+1177 / −2501 行。参照树（[同提交对照](#同提交对照)）撤回的是 `3339873a7` 与 `a244dfc06` 两个提交。

## 运行时：reset、根容器与链接

被替换的运行时给页面的东西，逐项落到 Orbit 自己的文件里：

| 被替换的运行时给的 | 现在 |
| --- | --- |
| `antd/dist/reset.css`（main.tsx 导入） | `components/ui/reset.css`：去掉首行 `/* stylelint-disable */`，正文与 antd 6.6.5 的 `dist/reset.css` 逐字节相同（3,563 字节），加一段头注释（出处与 MIT 许可文件）。导入位置不变。 |
| `App` 根容器 `div.css-oc1rc0.ant-app`：14px、`--ant-color-text`、无单位行高 `--ant-line-height`、应用字体 | `AppRoot` 画出的 `div.orbit-app`：`root.css` 给 14px、`var(--text-1)`、同一套字体；行高由 `AppRoot` 以内联样式给出 `22 / 14`（1.5714285714285714）。写进样式表时构建的压缩器（lightningcss）会把它写成 1.57143，自定义属性与 `calc()` 里也一样，WebKit 里继承下去的 22px 行高就变成 22.000019px；被替换的根容器从运行时变量拿到的是全精度值。 |
| 被替换根容器下的链接重置（antd 的 `genLinkStyle`，以 `:where(.css-oc1rc0) a` 注入，权重为 `a` 本身） | `root.css` 的 `:where(.orbit-app) a` 一组：颜色、无下划线、透明背景、`cursor: pointer`、`transition: color 0.3s`、`:hover`/`:active`/`:focus`/`:focus-visible`/`[disabled]`，权重相同。antd 同时注入的 `a:where(.css-oc1rc0)` 一组要求链接自己带 hash 类，参照 64 页的 216 个链接没有一个带（带 hash 类的只有根容器），所以不搬。 |
| 根容器上的 `--ant-*` 变量（`.css-var-_r_0_`） | 不再需要：`src/web` 里没有任何地方读 `--ant-*`。 |
| ConfigProvider 为图标再注入的一份 `.anticon` 规则（一份带 hash，一份不带） | 不再注入。`@ant-design/icons` 自己注入的一份（`.anticon`、`.anticon-spin { animation: 1s linear infinite loadingCircle }` 与关键帧）两棵树逐字相同；带 hash 的那份要求图标自己带 hash 类，匹配不到任何元素；不带 hash 的那份与图标自己的取值相同。 |
| `App` 的 message/notification/modal holder | 不再需要：通知由 `lib/toast.tsx` 与 `ToastViewport` 画（P2.3 起），确认框由 `useConfirm`（P2.1 起），P5.3 以后没有调用 `App.useApp` 的地方。 |
| ConfigProvider 的主题算法（theme.ts 的 token、darkAlgorithm） | 不再需要：组件都已是 Orbit 的，主题是 `lib/theme.tsx` 的 `<html data-theme>` 与 foundation.css/index.css 的变量，与之前相同。 |

**加载顺序**：被替换的运行时把样式注入在打包样式之前，所以同权重时页面与组件的规则胜出。`root.css` 是 `main.tsx` 的第一个导入，首屏的单个样式表（Vite 的 `codeSplitting` 分组）里排在最前，位置与之前的注入相同；`firstPageStylesheet.test.ts` 钉住前 7 个模块的顺序（`root.css`、`Overlay.css`、`ReviewCard.css`、highlight.js、`reset.css`、`index.css`、`foundation.css`）。传送门挂在 `<body>` 下，之前与现在都拿不到根容器的文字与链接重置。

**链接各状态的取值**（[checks/link-tokens.json](checks/link-tokens.json)，`scripts/link-tokens.py` 从参照的运行时记录读被替换根容器解析出的 token，从交付的 foundation.css/index.css 读 Orbit 的变量）：两个主题 26 项全部相同。明色：链接 `#3370ff`、悬停 `#85b1ff`、按下 `#2152d9`、焦点轮廓 `#adceff` 3px、禁用 `rgba(0,0,0,.25)`、文字 `#1f2329`；暗色：`#2e62dc`、`#223d7e`、`#2850ad`、`#1d305b` 3px、`rgba(255,255,255,.25)`、`#c9ced5`；两个主题的三种链接装饰都是 none，过渡 0.3s，字号 14px，行高 1.5714285714285714。这些值 P1.1 时已量进 foundation.css。

## index.css

- 头注释去掉「AntD components are themed separately in theme.ts (darkAlgorithm).」。
- ≤960px 的 16px 规则去掉 `.ant-input`、`.ant-input-affix-wrapper input`、`textarea.ant-input` 三个选择器与 `.ant-select-input` 一段（含两行注释）：P1.2/P2.2/P3.1 以后页面上没有这些类，Orbit 的字段自己在这个宽度把字号提到 16px（`components/ui/TextControls.css`、`Select.css`），规则旁的注释写明这一点。
- 两处注释改写（「replaced a modal whose line height is unitless」「as the modal this dialog replaced」）。
- 运行时对照里 64 页 17,692 个元素的计算样式不变，说明去掉的规则不匹配任何元素。

## 测试与样例

### 六个组件样例

`components/ui/__fixtures__` 的 Foundation、Controls、Overlays、Choices、Toasts、Composer 六个样例原先把每个 Orbit 控件与它替换的 AntD 控件并排画在 ConfigProvider/AntApp 下，P1–P3 用它们现场比较两边。按 1A，样例只画 Orbit 一侧：都在 `<AppRoot>` 里，`ui-migration` 的入口先导入 `root.css` 再导入 `reset.css`，与 `main.tsx` 相同。

- Controls 保留三栏网格（注释说明），去掉 `.ant-input-affix-wrapper` 选择器。
- Overlays 去掉旧 Modal/Drawer 里外嵌套的样例（`LegacyChildren`、`LegacyParentContent`）与 AntD 样本。
- Choices 去掉 `?system=antd`、旧 Modal 与子菜单的 `popupClassName`，样式去掉 `.ant` 规则。
- Toasts 去掉旧 AntApp 确认框（`LegacyConfirm`）。
- Composer 去掉 `impl=ant`，复刻的页面用页面自己用的 Orbit `Button`、`Image`（`cover`）与 `Avatar`；样式去掉 `.ant-input`。

### 删除的对照与共存用例

逐条归类（[checks/removed-assertions.json](checks/removed-assertions.json)，`scripts/removed-assertions.py c4396e776`）：样例 spec 删去 128 条断言（含 `expect(` / `expect.soft(` / `expect.poll(` 的行）。

- **51 条保留**：同一检查仍在，只是去掉了消息里的 `${system}`/`${impl}` 前缀、按系统选的选择器或循环变量，或挪进了单行 for 循环；`orbitTextareas` 改名为 `state.textareas` 的一条单独登记。去掉的是它的 AntD 分支。
- **39 条比较**：拿 Orbit 一侧与 AntD 一侧现场比（或断言 AntD 一侧本身）。
- **38 条共存**：所在用例检查旧组件在 Orbit 组件里外的共存，整个删除。
- 无法归类的 0 条（脚本有一条就以 1 退出）。

| spec · 用例（原名 → 现名） | 删去的 | 它原先证明的 | 结果所在 |
| --- | --- | --- | --- |
| foundation · foundation states match current AntD and the frozen P0 palette → …match the frozen P0 palette | 4 条比较（计算样式、悬停、焦点与 AntD 按钮相同） | Orbit 基础按钮的计算样式与悬停、焦点反馈同 AntD；P0 冻结色板的断言保留 | [P1.1](../p1.1/README.md) |
| foundation · body and nested portals inherit theme and preserve focus ownership → body portals inherit… | 10 条共存（嵌在 AntD Modal 里的 Orbit 对话框） | 嵌套表面继承主题、在上方、Tab 留在弹窗内、Escape 逐层关闭并归还焦点 | [P1.1](../p1.1/README.md) |
| controls · fixed control states match AntD geometry, typography and surfaces → …keep the frozen P0 palette | 1 条比较（逐项 `compare(orbit, ant)` 的差异为空） | 按钮、输入、徽标等各状态的几何、排版与表面同 AntD（每组合 197 项） | [P1.2](../p1.2/README.md) |
| controls · hover and keyboard focus preserve visible control feedback | 2 条比较（悬停与焦点样式同 AntD） | 悬停、焦点反馈同 AntD；焦点可见的断言保留 | [P1.2](../p1.2/README.md) |
| controls · a focused field under the pointer and the 601–960px font size match AntD → …stays hovered and focused; its 601–961px sizes are recorded | 2 条比较 | 指针下聚焦的字段与 601–960px 的 16px 字号同 AntD | [P3.1](../p3.1/README.md)（`fe18bb5b8`） |
| overlays · dialog and drawers match current surfaces, geometry, typography and actions → …open with no control hovered or focused; the sheet field takes hover and focus | 1 条比较（各浮层的测量同 AntD） | 对话框、右抽屉、底部抽屉、危险确认的几何、排版、表面与按钮同 AntD | [P2.1](../p2.1/README.md) |
| overlays · actual legacy modal, Popconfirm and Select work inside Orbit dialog/drawer | 整个用例，12 条共存 | 旧 Modal、Popconfirm、Select 在 Orbit 对话框/抽屉里能用 | [P2.1](../p2.1/README.md) |
| overlays · Orbit dialog and nested confirmation work inside a legacy modal/drawer | 整个用例，9 条共存 | Orbit 对话框与嵌套确认在旧 Modal/Drawer 里能用 | [P2.1](../p2.1/README.md) |
| overlays-app-frame · `${system} ${kind}` leaves the page where it was scrolled… → Orbit `${kind}`… | AntD 一侧的用例（断言与 Orbit 一侧相同） | 旧浮层在 app 框架里保持页面滚动位置，作 Orbit 一侧的对照 | [WebKit 滚动锁](../webkit-scroll-lock/README.md) |
| overlays-close-hover · the dialog Close takes the replaced modal Close hover background | 4 条比较（AntD 一侧的静止/悬停/底色，Orbit 等于 AntD） | Orbit 对话框 Close 的悬停底色同被替换 Modal 的 Close；三个字面值改由 Orbit 一侧承担 | [Select 首项与 Close 悬停](../select-first-option/README.md)（`a755f816a`） |
| choices · `${kind}` matches the current surface, density and option states → …opens its surface; its density and option states are recorded | 3 条比较（菜单字形、测量同 AntD；手机附件菜单 17px 的预期由 AntD 测量改写） | 选择面、密度、选项状态同 AntD | [P2.2](../p2.2/README.md) 与 [第二版](../p2.2/revision-2/README.md) |
| choices · empty, disabled, hover and focus choice surfaces match the existing states → …: disabled refuses input, empty says No data | 1 条比较 | 空、禁用、悬停、焦点状态同 AntD | [P2.2](../p2.2/README.md) |
| choices · `${kind}` chip appearance matches current labels and email fields → `${kind}` chips: appearance recorded, disabled refuses input | 1 条比较 | 标签与邮箱 chip 外观同 AntD | [P2.2](../p2.2/README.md) |
| choices · legacy Modal owns choices, top-layer Escape, Tab and theme（`${legacy ? … }` 的旧 Modal 一支） | 旧 Modal 一支（断言与 Dialog 一支相同） | 选择控件在旧 Modal 里的顶层 Escape、Tab 与主题 | [P2.2](../p2.2/README.md) |
| choices · legacy host final Tab matches the AntD-only baseline, including its browser-focus boundary | 整个用例，2 条共存 | 旧宿主里最后一个 Tab 的焦点边界同纯 AntD | [P2.2](../p2.2/README.md) |
| choices-first-frame · `${name}` is drawn where it settles from its first frame, at the replaced popup's place → …from its first frame | 2 条比较（AntD 的落点与 Orbit 第一帧相同） | Orbit 浮层第一帧就在被替换浮层的落点 | [浮层第一帧](../overlay-first-frame/README.md)（448 处在半像素以内） |
| choices-first-option · opened by … the list is on the option the old select was on and Enter picks it | 3 条比较（AntD 一侧的高亮项与 Enter 结果，Orbit 等于 AntD） | 打开时的高亮项与 Enter 的选择同 AntD；预期的字面值改由 Orbit 一侧承担 | [Select 首项与 Close 悬停](../select-first-option/README.md)（`332fcb1eb`） |
| choices-motion · 三个用例（matches → stays in view / runs its entrance and exit） | 2 条比较（时长、关键帧、原点、filter 与中点帧同 AntD） | 入场、退场动效同 AntD；在视口内、帧连续的断言保留 | [P2.2 第二版](../p2.2/revision-2/README.md) |
| choices-open-value · `${kind}` dims the current value while open and restores it on Escape | 1 条比较（整组记录同 AntD） | 打开时当前值变淡、Escape 后恢复同 AntD；0.25 透明度等 5 条保留 | [P2.2 第二版](../p2.2/revision-2/README.md) |
| choices-submenu-geometry · submenu at the … settles where the replaced submenu does → …opens to the replaced submenu's side; its box is recorded | 3 条比较（项与盒同 AntD） | 子菜单的起点、宽度与翻转同 AntD；它开向的一侧改由 Orbit 一侧承担 | [子菜单几何](../submenu-geometry/README.md) |
| toasts · legacy AntApp confirmation still works with the same notification service | 整个用例，5 条共存 | 旧 AntApp 确认框与同一通知服务共存 | [P2.3](../p2.3/README.md)（该页已写明「fixture 中 AntApp 对照在 P6 退役」） |
| composer · 六个用例（draws exactly like / matches the AntD field → 记录或对照 P0） | 9 条比较（逐状态的样式、几何、两种截图的像素同 AntD 字段，过渡的唯一预期差异） | Orbit Textarea 在会话输入与评论框里的几何、样式、像素、镜像对齐、附件、手动高度、断点与过渡同 AntD 字段 | [P3.1](../p3.1/README.md)（`e207a13eb`、`1d00d6665`） |
| composer-input · 输入序列（`runs.orbit` 等于 `runs.ant`） | 1 条比较 | 中文组合输入、Enter、Shift+Enter 等序列的结果同 AntD 字段 | [P3.1](../p3.1/README.md) |

**用例数**（开工树上原 spec 的报告对交付上删除后的报告，按 spec 与用例名）：整个删掉的是 11 个用例 × 8 个环境 = 88 个测试——overlays 8 个（overlays-app-frame 的 4 个 AntD 变体：dialog、confirm、右抽屉、底部抽屉；overlays 的 4 个共存用例），choices 2 个（旧 Modal 一支、旧宿主最后一个 Tab），toasts 1 个（旧 AntApp 确认框）；overlays 184 → 120、choices 776 → 760、toasts 272 → 264，foundation 48、controls 32、composer 144 不变。其余用例都还在，只是名字不再说「同 AntD」。

**改由 Orbit 一侧承担的字面值**：原先断言在 AntD 一侧、对着 spec 里写死的值或 P0 的，同一检查现在落在 Orbit 一侧，值不变：

- overlays-close-hover：静止时不在悬停、悬停时在悬停、悬停底色 `rgba(0, 0, 0, 0.06)`（暗色 `rgba(255, 255, 255, 0.12)`）。
- choices-first-option：高亮项（`Never` / `7 days` / `7 days`）、Enter 选到的值、`aria-expanded="false"`、焦点回到选择框。
- choices-submenu-geometry：子菜单开向的一侧（页面左侧开向右，右缘与对话框右缘开向左）。
- composer：样例的字段与 P0 页面的字段尺寸相同（`expectP0`）。

### 补偿控制：Orbit 一侧在本批前后

同一份删除后的 spec（`c4396e776` 的 17 个文件）跑在两棵树上（`formal.sh f1` 的 fixtures 步，`bgj_797adbf2ea17`）：本批之前，交付的父提交 `f78e93f61`，样例仍在 ConfigProvider/AntApp 与 antd 的 reset 下、仍画着 AntD 的一半（spec 只看 Orbit 一侧，跑完把父提交的 spec 复原，[runs/base-specs.txt](runs/base-specs.txt)）；本批之后，交付 `6879542dc`。交付再跑第二遍作噪声对照（`scripts/fixtures-rerun.sh`，`bgj_ca03725794e8`）：同一棵树两次之间也会变的，是时序，不是 P6。

| 配置 | 父提交 | 交付 | 交付第二遍 |
| --- | --- | --- | --- |
| foundation | 48 通过 | 48 通过 | 48 通过 |
| controls | 32 通过 | 32 通过 | 32 通过 |
| overlays | 120 通过 | 120 通过 | 120 通过 |
| choices | 760 通过 | 758 通过、2 失败 | 758 通过、2 失败 |
| toasts | 264 通过 | 263 通过、1 失败 | 264 通过 |
| composer | 121 通过、23 跳过 | 121 通过、23 跳过 | 121 通过、23 跳过 |

**用例状态**：1,368 个测试里 1,365 个两棵树都通过（或都按用例设定跳过），3 个不同：

- toasts「entrance progress survives a modal transfer before its first 180ms completes」（webkit-dark-desktop）：一次性的时序红（入场动画在 180ms 内被转进模态框时取帧没取到中间态）。交付第二遍通过；交付与父提交各重复 10 次 × 两个 WebKit 桌面环境，20/20 与 20/20 通过（`scripts/flake-check.sh`，`bgj_a6556178b400`，[runs/flake/](runs/flake/)）。
- choices「multiple labels search, toggle, collapse, remove and clear without losing the remaining values」（webkit-light-phone、webkit-dark-phone）：交付上每次都红，父提交上每次都过（各 20 次，同一个 `bgj_a6556178b400`）；断言都过，红在 afterEach 的页面错误检查：`ResizeObserver loop completed with undelivered notifications.`。**不是 P6 的运行时**：同一个用例 × 5 在两个 WebKit 手机环境、四种样例上（`scripts/ro-loop-variants.sh`，`bgj_afddf5ba27ca`；临时检出，改动跑完复原）——

  | 样例 | 区块上方的「Open legacy Modal」按钮 | 结果 |
  | --- | --- | --- |
  | 交付原样 | 没有（删 AntD 时一起删的） | 10/10 红 |
  | 交付，补回一个同名占位按钮（背后什么都没有） | 有 | 10/10 通过 |
  | 父提交原样 | 有 | 10/10 通过 |
  | 父提交，删掉这个按钮 | 没有 | 10/10 红 |

  起因是 Multiple choices 区块在页面上的位置：少了这个按钮，区块从 y 694 上移到 650（390×844 视口），P6 之前的代码在同一位置也红。逐步探针（`scripts/ro-loop-probe.mjs` + `ro-loop-pair.sh`，与用例相同的上下文选项，`bgj_0c9e6ba3ad60`）把它定在「点 Ops」一步：第三个标签让 chip 换行，字段 `div.orbit-select.orbit-multi` 从 20px 长到 40px，再收成「+1 more」回到 20px，同时浮层的 positioner 也在被观察；靠近视口下缘时 WebKit 报这个循环，四种样例里出不出它与上表一致。这是 Orbit MultiSelect 早就有的问题，P6 删掉 AntD 的按钮让样例碰到了它。协调者 2026-10-10 判定（回复请求 `34dcqZVoYZzIzT6KwnYbT`）：P6 不改用例、不改样例布局、不补占位，按「P6 之前就有、因样例位置暴露」记录；修复另立任务 [MultiSelect 视口下缘：chip 换行收起不触发 ResizeObserver 循环（WebKit 手机）](orbit-task:34dcr9bZPPrl6TDzvXowg)（依赖 P6，验收是这条用例在 WebKit 明/暗两个手机环境连续多次转绿，且不改用例、样例与断言）。这条红在 P6 之后仍在，直到那个任务落地；它属既存、已记录的一类，不是 P6 的回归，也不是 P6 的未完成项。

**附件**（`scripts/compare-fixtures.py` 逐个比较两棵树的附件，`scripts/classify-fixture-diffs.py` 拿交付两遍的比较归类；[checks/fixtures-compare/](checks/fixtures-compare/)）：两棵树都有的 1,497 份 JSON、1,220 张截图。

- JSON：990 份逐值相同；507 份不同，全部归了类，无法归类的 0 份——465 份同一测试在交付两遍之间也不同（动效帧、取样时刻、耗时等），6 份不同的路径都是同类附件在交付两遍之间会变的那些字段（帧数、取样数、毫秒），16 份只差页面位置且每份内是同一个偏移（overlays 的页面滚动 1646 → 1606 等、choices 指针菜单的 y 上移 44px：样例页删掉了上方的内容），20 份是 composer 复刻工具栏（父提交 39px、交付 43px，见下）。静止状态的测量（几何、计算样式、表面、字形、选项状态、焦点与悬停）除此之外两棵树逐值相同。
- composer 复刻工具栏：交付的样例把 `+` 与发送按钮从 AntD 的 Button 换成会话页自己用的 Orbit Button（`c4396e776`），工具栏 637×43，与真实会话页的 `div.composer-toolbar` 相同（运行时对照的会话页两棵树都是 43px，桌面 637 宽）；父提交的复刻用 AntD Button，自 P5.3 页面样式改用 Orbit 的选择器后它拿不到页面样式，只有 39px——与原 spec 的既存红是同一个起因。
- 截图：753 张逐字节相同；467 张不同，90 张在交付两遍之间也不同（动效中间帧、旋转的加载图标等），377 张两遍相同而与父提交不同，按差异的位置逐组核对（`classify-fixture-diffs.py` 给出每张的差异框）：
  - 删掉的 legacy/AntD 元素本身：toasts 的 138 张差异框都是「Legacy confirm」按钮所在的矩形（桌面 586–712 × 392–424 或 399–431，手机 24–151 × 576–608 或 583–615；少数几张只差它被盖住以外的一截），choices 的 nested-open 10 张是「Open legacy Modal」按钮（手机上它下面的内容随之上移），foundation 的 8 张是「AntD reference」卡片。
  - 删掉它们引起的位置变化：controls 的 8 张整页截图（页面变短，手机 13042 → 8916px 高）、overlays 的 bottom-sheet/confirm/drawer 页面截图 28 张（浮层背后变暗的页面少了 AntD 与 legacy 的按钮，其余按钮重新排列）、浮层表面截图边缘几个像素透出的背后页面（Close 悬停 4 张右缘 4 列、对话框 4 张底边 1 行、底部抽屉 2 张，单通道差 ≤2）。controls 的 1 张 WebKit 手机交互区截图：区块里各边框落点差 1px，几何探针（`scripts/fixture-geometry.mjs` + `geometry-pair.sh`，动画定在起点，`bgj_493ea963f695`）测得区块内 81 个可见元素相对区块的盒两棵树逐值相同，只是区块在页面上上移了 4124.8px、小数部分从 .6875 变成 .875，像素网格对齐不同；桌面上区块位置不变，截图也相同。
  - composer 的 161 张：差异都在复刻工具栏那一行（手机上截图因此高 4px）。
  - 过渡中途的状态：choices 动效用例的中间帧 12 张（浮层离开时 MultiSelect 字段的边框、悬停中的提示触发器）与 toasts 的 before-exit 1 张（刚点过的 Open Drawer 按钮，另差着 Legacy confirm 按钮）。交付两遍里它们碰巧相同；这几个用例在两棵树上各重复 4 次（`scripts/repeat-shots.sh`，`bgj_03d2c5fb421f`）：choices 的 84 张截图里 74 张在同一棵树的几次之间就在变，52 张两棵树都画出过同一张图，没有一张是每棵树各自固定而彼此不同的；toasts 那张在每棵树内也在变。

用例状态与静止测量都不变，截图差异落在 P6 删掉或挪动的样例内容上，P6 没有改变 Orbit 组件的行为；唯一的状态差别是上面那个早就有、因样例位置暴露的 MultiSelect 问题。

### 原 spec 的既存红

删除之前的六个配置原样跑在两棵 P6 之前的树上（`scripts/fixture-specs.sh`）：开工树 `a167c2ff0`（`bgj_f9dc9efa8238`）与交付的父提交 `f78e93f61`（choices、composer 两个有红的配置，`bgj_31788b1a06a9`）。开工树上 foundation 48/48、controls 32/32、overlays 184/184、toasts 272/272 通过；choices 756 通过、20 失败；composer 41 通过、80 失败、23 跳过。父提交上 choices 756 通过、20 失败，composer 41 通过、80 失败、23 跳过，与开工树相同。两棵树逐条比较（[checks/preexisting-reds-choices.json](checks/preexisting-reds-choices.json)、[checks/preexisting-reds-composer.json](checks/preexisting-reds-composer.json)，`scripts/preexisting-reds.py`，同一个 `bgj_31788b1a06a9`）：100 条红是同样的用例、同样的环境，报错文字（去掉各自的检出路径与终端颜色）逐字相同。

这些红全是与 AntD 一侧的现场比较（b 类），按既存红记录，不是 P6 引入的：协调者 2026-10-10 的提醒指出 choices 的 20 条在 main `9274d5242` 本身、以及任何一批的交付与参照上都相同。起因都在 P5.3（`c868a02c2`）：它把页面样式里给 AntD 的规则删了（页面已不用 AntD），样例里的 AntD 参照样本还靠这些规则拿页面的样式。

- choices 的 20 条在四个手机环境的附件菜单上，每个环境 5 条：`choices.browser.mjs:83` 的 surface、`choices-motion` 三个方向、`choices-first-frame:177`。index.css 去掉了 `.composer-attach-menu.ant-dropdown-menu …` 一组手机规则（250px 宽、42.4px 行高、17px 字、19px 图标、`#8a8a8e`），`ChoicesFixture.tsx:67` 给 AntD 参照的 `composer-attach-menu` 从此拿不到手机密度，画成桌面密度（antd 默认的 130px 宽、12px 图标）；Orbit 一侧是 `Menu` 的 `attachment` 变体，手机密度是 P2.2（`1a70fbb90`）起在 `ui/Floating.css` 里的。
- composer 的 80 条：index.css 去掉了 `.composer-field textarea.ant-input` 等 8 条，AntD 复刻的字段画回 antd 默认（静止 32px 高，Orbit 字段 38px，内容左缘差 12px），每个与它比较的用例都不再相等：composer 5 个用例 × 8 个环境、4 个断点宽度 × 4 个桌面环境、composer-input 3 个用例 × 8 个环境。跳过的 23 个是用例自己的设定：断点在手机上不跑（16 个），逐键成本只在 chromium-light-desktop 采样（7 个）。

按 1A 删除这些比较后它们随之退场：交付的样例不再画 AntD 一侧，删除后的 spec 在两棵树上的结果见上节的补偿控制。它们在 P5.3 之前的结果在 P2.2、P3.1 的证据里。

## 历史字样移入证据

按 P0.1（「历史说明移入证据目录」），`src/web/src` 里提到组件库的注释、测试名与 README 段落改写为「被替换的 …」或代码现在做的事，许可说明指向「本目录的 Ant Design 许可文件」而不写文件名。原文与现文逐行列在 [history-notes.md](history-notes.md)（`scripts/history-notes.py`，每个提交一张表，原行不截断）：97 行，其中 `6879542dc` 43 行，其余是运行时切换、样例与依赖删除时随代码一起去掉的行。

留下的、审计按「支持」类计数但不阻塞退役的行：

- `package-lock.json`：图标的依赖 `@ant-design/colors`、`@ant-design/fast-color`、`@rc-component/util`。
- 注释里的 `rc-trigger`、`rc-select`、`rc-image`：Orbit 组件复刻的算法（浮层取整与翻转、无值时高亮首项、预览的缩放与回弹），`rc-image.LICENSE` 是其 MIT 许可。
- `ProfilePage.signInMethods.test.tsx` 的 `server.confirm()`：测试里假服务器的方法，与组件库无关。

## 依赖与锁文件

`src/web/package.json` 去掉 `"antd": "^6.6.5"`。锁文件（[checks/lockfile-proof.json](checks/lockfile-proof.json)，`scripts/lockfile-proof.sh`，`bgj_356ad61ac8a3`；只用两个提交的清单与锁文件，npm 只写锁文件）：

- 起点 847 个条目，交付 790 个：删 57 个，新增 0 个，改动的只有 `src/web`（依赖表少了 antd）。
- 删去的 57 个正是只有 antd 用到的：antd、`@ant-design/cssinjs`、`cssinjs-utils`、`react-slick`、42 个 `@rc-component/*`（及挂在其中两个下面的两份 `@babel/runtime`）、`@emotion/hash`、`@emotion/unitless`、dayjs、stylis、json2mq、throttle-debounce、compute-scroll-into-view、scroll-into-view-if-needed、string-convert。
- 留下的 `@ant-design/*` 与 `@rc-component/*` 只有图标的五个：icons、icons-svg、colors、fast-color、`@rc-component/util`。
- npm 11.19.1 的 `npm uninstall antd -w @orbit/web` 删 108 个条目：多出的 51 个是 esbuild 的可选 peer 条目，起点什么都不改、只 `npm install --package-lock-only` 也删这 51 个，是 npm 自己对这份锁文件的规整，不属本批，所以不收（`scripts/minimal-lockfile.py`：起点去掉「uninstall 删、规整不删」的条目）。
- 交付的锁文件与 `minimal-lockfile.py` 的输出逐字节相同；对交付再跑 `npm install --package-lock-only`，写出的与 `npm uninstall antd` 写出的逐字节相同——npm 认这份锁文件，只是会顺带做它那一份规整。

## 干净安装与构建产物

**干净安装**（[checks/clean-install.txt](checks/clean-install.txt)，`scripts/clean-install.sh 6879542dc`，`bgj_f8faf61bfb59`）：在 /mnt/data 上全新检出交付，`node_modules` 与 dist 都不存在；Node 26.10.0、npm 11.19.1。

- `npm ci` 退出 0；`npm ls antd --all`（web 工作区与整棵树）为空；`npm explain antd`：No dependencies found matching antd。
- `npm ls @ant-design/icons -w @orbit/web`：`@ant-design/icons@6.3.4`；装上的 `@ant-design/*` 与 `@rc-component/*` 只有 colors、fast-color、icons、icons-svg 与 `@rc-component/util`；`node_modules` 下没有名为 antd 的目录。
- `npm run build -w @orbit/web`（`tsc -b && vite build`）退出 0；产物扫描全 0（下表）。

**构建产物**（[checks/dist-scan.txt](checks/dist-scan.txt)，`scripts/dist-scan.mjs`，`bgj_8ca22d0f9b90`）：三棵树各自 `vite build` 后扫描 dist 里的每个文件。

| | 起点 `f78e93f61` | 参照 `76dc63242` | 交付 `6879542dc` |
| --- | --- | --- | --- |
| AntD 类名（`ant-*`，图标的 `anticon` 不算） | 10 | 10 | 0 |
| `antd` 字样 | 4 | 4 | 0 |
| cssinjs 签名 | 6 | 6 | 0 |
| `ant-` 默认前缀 | 48 | 48 | 0 |
| rc 组件签名 | 1 | 1 | 0 |
| `anticon` | 78 | 78 | 75 |
| 图标样式的注入 id / rc-util 动态样式 | 1 / 4 | 1 / 4 | 1 / 2 |
| 总量 / gzip | 4,669,051 / 1,302,288 B | 4,669,039 / 1,302,282 B | 4,417,889 / 1,215,092 B |
| `index.js` / gzip | 1,964,431 / 592,912 B | 1,964,431 / 592,911 B | 1,713,113 / 506,310 B |
| `app.css` / gzip | 495,526 / 81,135 B | 495,526 / 81,135 B | 496,278 / 81,221 B |

`app.css` 多 752 字节：`root.css` 的 7 条规则（856 字节）进来，index.css 去掉的 `.ant-input,.ant-input-affix-wrapper input,textarea.ant-input,` 与 `.ant-select-input` 一段出去（reset 前后都在 `app.css` 里）。`anticon` 少的 3 处与 `data-rc-order`/`data-rc-priority` 少的 2 处都在起点的 `index.js` 里，随 antd 的运行时一起去掉；图标自己注入样式的代码（`@ant-design-icons`，在 `taskDependencyGraph` 块里）两棵树都在。

## ui-migration 目录与批次工具

项目约定 P6 的内部选择器扫描须包含 `src/web/ui-migration`（[checks/ui-migration-scan.json](checks/ui-migration-scan.json)，`scripts/ui-migration-scan.mjs`，用审计自己的 `scanText` 行规则）。109 个文件分三组：

- **P0**（标准 P0 回归，`playwright.config.mjs` 及它运行、导入的文件）16 个：0 命中，0 个导入组件库。
- **样例**（六个组件样例的入口与 spec）51 个：0 命中，0 个导入组件库。
- **批次工具** 42 个：各批同提交对照工具，读本批参照树（AntD）也读交付（Orbit），所以写成 `'.ant-modal-container, .orbit-overlay'` 这样的双选择器，并带 `[class*="ant-"]` 普查。按判定 2 保留，只把真正导入 antd 的 `p43b-cards.tsx`、`reviews.tsx` 改用 `AppRoot`/`root.css`/`reset.css`。13 个文件 106 行上 191 处命中，逐行文字在 JSON 的 `batch[].lines`：

| 工具 | 批次 | 用途 | 命中（行号） |
| --- | --- | --- | --- |
| `p41-fixtures.mjs` | P4.1 | 登录、初始设置、个人资料、设置 | 0 |
| `p41.browser.mjs` | P4.1 | 登录、初始设置、个人资料、设置 | 10（17, 18, 19, 20, 22） |
| `p41.config.mjs` | P4.1 | 登录、初始设置、个人资料、设置 | 0 |
| `p42-fixtures.mjs` | P4.2 | 提供方、账号池、运行器、管理员用户 | 0 |
| `p42.browser.mjs` | P4.2 | 提供方、账号池、运行器、管理员用户 | 22（23, 24, 25, 26, 27, 28, 350, 398, 577, 882, 926） |
| `p42.config.mjs` | P4.2 | 提供方、账号池、运行器、管理员用户 | 0 |
| `p43a-fixtures.mjs` | P4.3a | 任务与项目的列表、页面与工具栏 | 0 |
| `p43a.browser.mjs` | P4.3a | 任务与项目的列表、页面与工具栏 | 14（21, 22, 23, 24, 25, 26, 27） |
| `p43a.config.mjs` | P4.3a | 任务与项目的列表、页面与工具栏 | 0 |
| `p43b-cards-fixtures.mjs` | P4.3b | 依赖图与决策卡片 | 0 |
| `p43b-cards-ids.json` | P4.3b | 依赖图与决策卡片 | 0 |
| `p43b-cards.browser.mjs` | P4.3b | 依赖图与决策卡片 | 5（18, 19, 271） |
| `p43b-cards.config.mjs` | P4.3b | 依赖图与决策卡片 | 0 |
| `p43b-cards.html` | P4.3b | 依赖图与决策卡片 | 0 |
| `p43b-cards.tsconfig.json` | P4.3b | 依赖图与决策卡片 | 0 |
| `p43b-cards.tsx` | P4.3b | 依赖图与决策卡片；本批改用 `AppRoot`/`root.css`/`reset.css` | 1（32） |
| `p43b-fixtures.mjs` | P4.3b | 依赖图与决策卡片 | 0 |
| `p43b-helpers.mjs` | P4.3b | 依赖图与决策卡片 | 4（13, 42） |
| `p43b.browser.mjs` | P4.3b | 依赖图与决策卡片 | 14（24, 25, 26, 27, 28, 29, 30） |
| `p43b.config.mjs` | P4.3b | 依赖图与决策卡片 | 0 |
| `p44-fixtures.mjs` | P4.4 | Wiki、分享页、关注与观察 | 0 |
| `p44.browser.mjs` | P4.4 | Wiki、分享页、关注与观察 | 26（17, 18, 19, 20, 21, 22, 23, 94, 96, 98, 577, 584, 671, 772, 887） |
| `p44.config.mjs` | P4.4 | Wiki、分享页、关注与观察 | 0 |
| `p51-fixtures.mjs` | P5.1 | 会话导航、搜索、输出 | 4（94, 95, 104） |
| `p51.browser.mjs` | P5.1 | 会话导航、搜索、输出 | 26（15, 16, 17, 18, 19, 20, 87, 89, 92, 94, 96, 333, 335, 338） |
| `p51.config.mjs` | P5.1 | 会话导航、搜索、输出 | 0 |
| `p52-fixtures.mjs` | P5.2 | Transcript 的图片与预览 | 0 |
| `p52.browser.mjs` | P5.2 | Transcript 的图片与预览 | 23（16, 17, 18, 19, 20, 63, 105, 135, 137, 139, 231, 459, 566） |
| `p52.config.mjs` | P5.2 | Transcript 的图片与预览 | 0 |
| `p53-fixtures.mjs` | P5.3 | 会话工作区 | 0 |
| `p53.browser.mjs` | P5.3 | 会话工作区 | 38（12, 17, 20, 21, 75, 76, 85, 86, 87, 89, 90, 93, 99, 100, 112, 115, 126, 387, 395, 398, 400, 445, 754, 760） |
| `p53.config.mjs` | P5.3 | 会话工作区 | 0 |
| `pilot-fixtures.mjs` | P3.2 | 任务详情 / 分享 / 附件试点 | 0 |
| `pilot-performance.browser.mjs` | P3.2 | 任务详情 / 分享 / 附件试点 | 0 |
| `pilot.browser.mjs` | P3.2 | 任务详情 / 分享 / 附件试点 | 2（21） |
| `pilot.config.mjs` | P3.2 | 任务详情 / 分享 / 附件试点 | 0 |
| `reviews.check.mjs` | [P2 集成修复](orbit-task:34a0sy3NmYy7MLbOcqhkW) | 紧凑评审卡片 | 0 |
| `reviews.config.mjs` | [P2 集成修复](orbit-task:34a0sy3NmYy7MLbOcqhkW) | 紧凑评审卡片 | 0 |
| `reviews.html` | [P2 集成修复](orbit-task:34a0sy3NmYy7MLbOcqhkW) | 紧凑评审卡片 | 0 |
| `reviews.tsx` | [P2 集成修复](orbit-task:34a0sy3NmYy7MLbOcqhkW) | 紧凑评审卡片；本批改用 `AppRoot`/`root.css`/`reset.css` | 0 |
| `tasks-toolbar.browser.mjs` | [WebKit 任务工具栏修复](orbit-task:34coPBqt8gi229cVNds0E) | 任务工具栏几何 | 0 |
| `tasks-toolbar.config.mjs` | [WebKit 任务工具栏修复](orbit-task:34coPBqt8gi229cVNds0E) | 任务工具栏几何 | 0 |

**改了入口的两个工具在交付上跑一遍**（`scripts/harness-check.sh`，`bgj_bfe554fa94ce`；父提交上用它自己原来的入口，`bgj_11c09fbc558c`）：reviews 6 通过、6 跳过；p43b-cards 64 通过、4 跳过、4 失败。4 个失败是同一个用例「the start card in a conversation: fills the transcript, More and Read all only while cut…」在四个桌面环境：用例认为对话里的启动卡片在桌面上会被截断、断言有「Read all」，两棵树上卡片都没被截断。父提交上用 ConfigProvider/AntApp 的原入口，同样这 4 个、同样的断言失败——工具与 main 上卡片的既有出入，不是 P6 改的入口。

命中的种类：双选择器常量与定位（`.ant-x, .orbit-x`）、普查（p44、p51、p52、p53：`[class*="ant-"]`，图标的 `anticon` 除外）、说明参照树的注释，以及 `p51-fixtures.mjs` 里作为样例数据的一段 diff 文字（会话输出面板显示的 P5.1 改动）。

**普查作为本批的运行检查**（[checks/census.json](checks/census.json)，`scripts/census.py`；`formal.sh f1` 的 census 步，`bgj_797adbf2ea17`）：带普查的四个工具在交付上各跑一遍（截图只写不比，P0 的生产构建与固定数据，8 个环境）：P4.4 112 通过，P5.1 60 通过、4 跳过，P5.2 56 通过，P5.3 56 通过；它们记录的 2,264 步（P4.4 708、P5.1 496、P5.2 468、P5.3 592）里，画出 AntD 类名（`[class*="ant-"]`，图标的 `anticon` 除外）的 0 步。作为对照，同样的普查在各批自己的交付上还见到根上的 `ant-app`（P5.3：592 步里只有它；P5.1：它与当时会话工作区自己的类），那是本批的。

## 迁移清单

[inventory-closure.json](inventory-closure.json)（`inventory-closure.mjs`，读起点 `f78e93f61` 与交付两次 `audit-antd.mjs --json`，按审计自己的 `--check-owners` 规则判每个使用点，P0.1 基线与 inventory-delta 记录都不改）：

| | 起点 `f78e93f61` | 交付 `6879542dc` |
| --- | --- | --- |
| 归属 | P6 42、KEEP 1 | 无 |
| 未归属 / 待定 | 0 / 0 | 0 / 0 |
| 退役阻塞文件（`--check-retired`） | 37 | 0 |
| 声明的依赖 | antd ^6.6.5、`@ant-design/icons` ^6.3.4 | `@ant-design/icons` ^6.3.4 |
| 锁定的 `@ant-design/*`、`@rc-component/*` 与 antd | 51 | 5（图标与它的依赖） |
| 导入 antd 的生产 / 测试文件 | 9 / 3 | 0 / 0 |
| 命中行：antd 引用、Provider、主题、`useApp`、内部 ref、`.ant-*` 选择器、AntD 类名 | 84、13、1、2、1、9、10 | 全 0 |
| 命中行：图标类名、图标引用、`ref-focus`、通知调用 | 88、125、24、220 | 88、125、24、220（不变） |

交付上 `audit-antd.mjs --check-owners`：`owners {}`、`unowned []`、`pending []`，退出 0；`--check-retired` 退出 0，列出的依赖只剩 `@ant-design/icons`（family `icons`）。

## 同提交对照

三棵树（`scripts/make-trees.sh`，都在 /mnt/data）：

- **参照** `76dc63242`：交付撤回 `a244dfc06` 与 `3339873a7`（本地提交，不推送）——`main.tsx` 回到 ConfigProvider/AntApp、antd 的 reset 与 theme.ts，依赖与锁文件里有 antd；其余（Orbit 的 reset 与根样式文件、只画 Orbit 的样例、注释）与交付相同。用开工时的安装（同一份锁文件）。
- **起点** `f78e93f61`：交付的父提交，用于标准 P0 与补偿控制。
- **交付** `6879542dc`。

**运行时**（[checks/runtime-compare.json](checks/runtime-compare.json)，`scripts/runtime-pair.sh` + `runtime-probe.mjs` 采集，`bgj_274087404e1c`；`analyze-runtime.py` 比较，`bgj_81e66a2149ab`）：两棵树的生产构建，8 个 P0 路由（task、projects、project、share、wiki、settings、profile、session）× Chromium/WebKit × 明/暗 × 桌面/手机，P0 的固定数据。每页记录生效的每个样式表与它的规则、`[class*="ant-"]` 普查、根容器与它的文字样式、`<body>` 下每个元素的盒与 40 项计算样式（reset 与根容器给的、或从它们继承的：盒模型、边距、边框宽度、字体各项、行高、颜色、背景、装饰、对齐、溢出、光标、触控、外观、轮廓样式、字号调整等）。

- 64 页、17,692 个元素：DOM 相同（同样的元素、同样的次序），盒与计算样式 0 处差异；根容器的文字样式相同；html、body 相同。
- 普查：参照 64 页都有根上的 `ant-app`，交付 0 页。
- 只在参照里的规则 44 种（按规则文字计，64 页共 2,432 次）：antd 的链接重置两组（`a:where(.css-oc1rc0)` 与 `:where(.css-oc1rc0) a`）；ConfigProvider 为图标注入的两份——带 hash 的一份，和不带 hash、文字与图标自己那份逐字相同的一份（`.anticon` 各条与 `@keyframes loadingCircle`；`.anticon-spin` 写成分项，取值相同）；`ant-app` 的样式；根容器上的 `--ant-*` 变量；以及 index.css 那段 `@media (width <= 960px)` 去掉 `.ant-*` 选择器之前的文字（两种浏览器的序列化各一种）。
- 只在交付里的 11 种（共 512 次）：`root.css` 的 `.orbit-app` 与链接一组（两种浏览器的序列化），以及那段 `@media` 去掉之后的文字。

**P0 页面矩阵**（P3.2 的 `p32-reference.config.mjs`：P0 的生产构建、固定数据与 8 个环境，截图写到或读自指定目录；`scripts/formal.sh f1`，`bgj_797adbf2ea17`）：

- 参照写截图（p0-ref）101 通过、11 跳过；交付对着参照的截图严格比较（p0-strict：`maxDiffPixels: 0`，Playwright 默认的逐像素色差阈值）101 通过、11 跳过；交付写自己的截图（p0-del）101 通过、11 跳过。两棵树跳过的是同样 11 个（手机上的断点探测与参照环境以外的性能基线，用例自己的设定）。
- 逐字节比较（[checks/p0-pair/](checks/p0-pair/)：P3.2 的 `compare_runs.py`、P4.1 的 `summarize.py`、P4.2 的 `beyond-clusters.py`，`bgj_12a8a20b52bf`）：252 张截图里 237 张逐字节相同，12 张抗锯齿级（每个差异像素每通道 ≤2），3 张超出；252 次取证的计算样式 0 处差异。差异全在 Chromium，WebKit 的 126 张全部相同。
- 超出的 3 张：`chromium-dark-desktop/breakpoint-961-wiki.png` 左上角标志处 9 个像素（7 个 >2，最大 13）、`chromium-dark-phone/projects-search-empty.png` 左缘三处共 13 个像素（最大 4）、`chromium-light-phone/task-action-focus.png` 2 个像素（最大 3）。
- **同一棵树重跑**（[checks/p0-pair/noise/](checks/p0-pair/noise/)，`scripts/p0-noise.sh f1`，`bgj_cd86ea8125ba`）：参照与交付各再跑一遍（都是 101 通过、11 跳过）。参照两次之间 244 张相同、7 张抗锯齿级、1 张超出（`task-action-focus.png`，2 个像素、最大 3）；交付两次之间 241 张相同、4 张抗锯齿级、7 张超出（Wiki 页与断点页左上角标志处 9 个像素、最大 13，`projects-search-empty.png` 13 个像素、最大 4，等）；第二次的参照对第二次的交付 240 张相同、7 张抗锯齿级、5 张超出。上面超出的 3 张，同样的位置在同一棵树的两次之间也变化（`breakpoint-961-wiki.png` 与 `projects-search-empty.png` 在交付两次之间，`task-action-focus.png` 在参照两次之间），是 Chromium 的光栅化噪声，不是两棵树的差别。

## 标准 P0、合并检查、OrbitKit

**标准 P0**（`ui-migration/playwright.config.mjs`，期望截图是 P0.2 原件与登记过的各层；[runs/](runs/) 的 `p0-standard*`）：交付 `6879542dc` 101 通过、11 跳过；起点 `f78e93f61` 101 通过、11 跳过。两次用的期望都是 44 张 P0.2 原件、165 张 main 漂移参照、43 张已接受的迁移差异（`*.expected-sources.json`）。本批不需要登记任何新的 P0 期望。

**合并检查**（任务工作树，即交付 `6879542dc`，`npm run build -w @orbit/web && npm run test -w @orbit/web`，`formal.sh f1` 的 merge-check 步）：类型检查与构建成功；Vitest 399 个文件、5,167 个用例全部通过。

**OrbitKit**（交付的 `git archive`，`swift:6.1` 容器，`--memory 6g`，`swift test`，`formal.sh f1` 的 orbitkit 步）：3,671 个测试，5 个跳过，0 失败。OrbitKit 的平行测试读的 Web 源文件里，本批改过的只有 index.css 与 `InfrastructurePage.overview.test.tsx`：前者被读的是 Wiki 的手机规则（本批没动），后者只在文档注释里提到。

## 已知差异

- 链接重置的另一组 `a:where(.css-oc1rc0)`（要求链接自己带 hash 类）没有搬：参照 64 页没有一个链接带它。若以后有链接自己带上某个类就想要被替换库的链接样式，那是新需求。
- 共存样例不再能与 AntD 现场比较（1A）：这些差异的权威记录是 P1–P3 各批证据与已接受层。删除之前的原 spec 在 P6 之前的两棵树上就有 100 条红（choices 20、composer 80，都是 b 类比较，P5.3 起），逐条相同，见[原 spec 的既存红](#原-spec-的既存红)。
- 删除后的 choices「multiple labels…」用例在两个 WebKit 手机环境是红的：P6 之前就有的 MultiSelect 问题，P6 删掉样例里的 AntD 按钮后区块的位置碰到了它；按协调者的判定记录，修复在 [MultiSelect 视口下缘：chip 换行收起不触发 ResizeObserver 循环（WebKit 手机）](orbit-task:34dcr9bZPPrl6TDzvXowg)，见[补偿控制](#补偿控制orbit-一侧在本批前后)。
- composer 样例的复刻工具栏从 39px 变成 43px：样例改用会话页自己用的 Orbit Button 后与真实会话页相同，是样例更接近页面，不是产品的变化。

## 未确立的部分

- 真实手机与真实浏览器（非 Playwright 的 Chromium/WebKit）上没有重跑；运行时对照是计算样式级的，像素见 P0 页面矩阵。
- 运行时对照只覆盖 P0 的 8 个路由的静止状态；链接的交互状态由 token 对照（[checks/link-tokens.json](checks/link-tokens.json)）而非浏览器操作确立。
- `src/web/ui-migration/p43b-cards.tsconfig.json`（不在任何门禁里）的类型检查在起点与交付上都有同样的 2 个错误，本批没有处理。
- 各批同提交对照工具里，没有普查的那些（P3.2 试点、P4.1、P4.2、P4.3a、P4.3b 的依赖图、WebKit 任务工具栏）本批没有在交付上重跑；它们照判定 2 原样保留，供用各批自己的提交复现当时的对照。本批改了入口的两个（`reviews.tsx`、`p43b-cards.tsx`）在交付上跑过一遍，见[批次工具](#ui-migration-目录与批次工具)。
- 补偿控制比较的是两棵树上同一份 spec 的结果与附件；Orbit 组件在样例以外（真实页面）的行为由 P0 页面矩阵、标准 P0 与运行时对照确立。

## 复现

都在仓库根目录运行；重的步骤在 /mnt/data，内存上限 6G、OOM 分数 500、独立网络命名空间，一次一步。

```bash
E=docs/evidence/base-ui-migration/p6
# 迁移清单与扫描
node src/web/scripts/audit-antd.mjs --check-owners; node src/web/scripts/audit-antd.mjs --check-retired
node src/web/scripts/audit-antd.mjs --json > after.json   # 在起点检出里同样得到 before.json
node $E/inventory-closure.mjs before.json after.json > $E/inventory-closure.json
node $E/scripts/ui-migration-scan.mjs > $E/checks/ui-migration-scan.json
python3 $E/scripts/history-notes.py b1010a5ad c4396e776 3339873a7 a244dfc06 6879542dc > $E/history-notes.md
python3 $E/scripts/removed-assertions.py c4396e776 > $E/checks/removed-assertions.json
# 锁文件、干净安装与产物
bash $E/scripts/lockfile-proof.sh f78e93f61 6879542dc /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/lockfile-proof
bash $E/scripts/clean-install.sh 6879542dc
node $E/scripts/dist-scan.mjs <起点 dist> <参照 dist> <交付 dist>
# 三棵树、运行时对照、正式轮
bash $E/scripts/make-trees.sh 6879542dc 3339873a7 a244dfc06 f78e93f61
bash $E/scripts/runtime-pair.sh /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/runtime-r3
python3 $E/scripts/analyze-runtime.py /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/runtime-r3 > $E/checks/runtime-compare.json
python3 $E/scripts/link-tokens.py /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/runtime-r3 src/web/src/components/ui/foundation.css src/web/src/index.css
bash $E/scripts/formal.sh f1
python3 $E/scripts/census.py p44=<census-p44 的报告> p51=<…> p52=<…> p53=<…> > $E/checks/census.json
# 正式轮之后的补充（一次一步）
bash $E/scripts/p0-noise.sh f1                      # P0 页面矩阵在同一棵树上重跑
bash $E/scripts/fixture-specs.sh /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1/start start-original                   # 原 spec，开工树
bash $E/scripts/fixture-specs.sh /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1/base base-original choices composer   # 原 spec，父提交
python3 $E/scripts/preexisting-reds.py start=<开工树的报告> base=<父提交的报告>
bash $E/scripts/flake-check.sh f1                   # 交付上没过的用例 × 10，两棵树
bash $E/scripts/fixtures-rerun.sh f1                # 交付第二遍（噪声对照）
python3 $E/scripts/compare-fixtures.py <父提交的报告> <交付的报告> > DIR/CONFIG.json            # 两棵树
python3 $E/scripts/compare-fixtures.py <交付的报告> <交付第二遍的报告> > DIR/CONFIG.noise.json  # 交付两遍
python3 $E/scripts/classify-fixture-diffs.py DIR foundation controls overlays choices toasts composer
bash $E/scripts/ro-loop-variants.sh /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/ro-loop-variants   # 四种样例
RUNS=4 bash $E/scripts/ro-loop-pair.sh /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/ro-loop-2        # 逐步探针
bash $E/scripts/geometry-pair.sh /mnt/data/tmp/34Za39RS6A28G7xPqMD0p/geometry-2
bash $E/scripts/repeat-shots.sh f1                  # 过渡中途的截图 × 4，两棵树
bash $E/scripts/harness-check.sh f1 && bash $E/scripts/harness-check.sh f1 base p43b-cards
bash $E/scripts/collect.sh f1                       # 把引用的记录抄进本目录
```

## 体积

本目录 14,734,746 字节、200 个文件（runs/ 12,898,981 字节、119 个；checks/ 1,623,973 字节、48 个；scripts/ 94,404 字节、29 个；其余 117,388 字节），在项目 30 MB 的约定以内。没有 trace 包，也没有带附件正文的 Playwright 报告：报告都是去掉附件正文的 `report.summary.json`（`p0-drift-3/tools/report-summary.py`）。大于 1 MB 的 8 个文件整份 gzip（`gzip -9 -n`，用 `zcat` 读）：原 spec 两次运行的 composer 报告与日志、choices 报告，补偿控制里 choices 的两份比较。截图、trace 与完整报告留在 /mnt/data/tmp/34Za39RS6A28G7xPqMD0p，到判定为止。
