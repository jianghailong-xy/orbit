
### b1010a5ad test(web): the last three tests render without the antd App wrapper (P6)

| 文件 | 原行 | 现行 |
| --- | --- | --- |
| `src/web/src/App.infrastructure.test.tsx` | import { App as AntApp } from 'antd'; | （删除） |
| `src/web/src/pages/InfrastructurePage.overview.test.tsx` | import { App as AntdApp } from 'antd'; | （删除） |
| `src/web/src/pages/InfrastructurePage.overview.test.tsx` | <AntdApp> | <QueryClientProvider client={qc}> |
| `src/web/src/pages/InfrastructurePage.overview.test.tsx` | </AntdApp>, | （删除） |
| `src/web/src/pages/RunnerDetailPage.engines.test.tsx` | import { App as AntdApp } from 'antd'; | （删除） |
| `src/web/src/pages/RunnerDetailPage.engines.test.tsx` | <AntdApp> | <QueryClientProvider client={qc}> |
| `src/web/src/pages/RunnerDetailPage.engines.test.tsx` | </AntdApp>, | （删除） |

### c4396e776 test(web): the coexistence fixtures draw only their Orbit side (P6)

| 文件 | 原行 | 现行 |
| --- | --- | --- |
| `src/web/src/components/ui/__fixtures__/ChoicesFixture.css` | /* The replaced share menu's icon offset, which left index.css with the AntD menu, for the AntD reference sample. */ | （删除） |
| `src/web/src/components/ui/__fixtures__/ChoicesFixture.css` | .fixture-access-menu .ant-dropdown-menu-item .ant-dropdown-menu-item-icon { margin-top: 3px; } | （删除） |
| `src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx` | import { App as AntApp, Button as AntButton, ConfigProvider, Drawer as AntDrawer, Dropdown, Modal, Popconfirm as AntPopconfirm, Popover as AntPopover, Select as AntSelect, Tooltip as AntTooltip } from 'antd'; | （删除） |
| `src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx` | const legacy = params.get('system') === 'antd'; | （删除） |
| `src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx` | ? <AntDrawer open title="Sample owner" closable={false} keyboard={false} maskClosable={false} style={moved}>{content}</AntDrawer> | （删除） |
| `src/web/src/components/ui/__fixtures__/ComposerFixture.css` | /* The task panel's comment field rule as index.css had it while the panel used the AntD field; P3.2 | （删除） |
| `src/web/src/components/ui/__fixtures__/ComposerFixture.css` | moved the panel to Orbit and kept only the Orbit half there, so the AntD reference keeps it here. */ | （删除） |
| `src/web/src/components/ui/__fixtures__/ComposerFixture.css` | .fixture-task-panel .tdp-compose .ant-input { | （删除） |
| `src/web/src/components/ui/__fixtures__/ComposerFixture.tsx` | import { App as AntApp, Avatar, Button as AntButton, ConfigProvider, Image, Input as AntInput } from 'antd'; | （删除） |
| `src/web/src/components/ui/__fixtures__/ComposerFixture.tsx` | // around either the AntD field they use today (?impl=ant) or the Orbit Textarea. Everything but the | // around the Orbit Textarea, with the Orbit buttons, image and avatar those pages draw. |
| `src/web/src/components/ui/__fixtures__/ComposerFixture.tsx` | // AntD: through its internal ref, as WorkspaceView/TaskDetailPanel do now. Orbit: the element itself. | const node = useCallback((): HTMLTextAreaElement \| null => orbit.current, []); |
| `src/web/src/components/ui/__fixtures__/ControlsFixture.css` | .controls-cell > input, .controls-cell > textarea, .controls-cell > .orbit-input, .controls-cell > .ant-input-affix-wrapper { width: 220px; max-width: calc(100% - 48px); } | .controls-cell > input, .controls-cell > textarea, .controls-cell > .orbit-input { width: 220px; max-width: calc(100% - 48px); } |
| `src/web/src/components/ui/__fixtures__/ControlsFixture.tsx` | Typography as AntTypography } from 'antd'; | （删除） |
| `src/web/src/components/ui/__fixtures__/ControlsFixture.tsx` | <div className="controls-cell" data-side="ant"><span className="controls-source">AntD</span>{ant}</div> | （删除） |
| `src/web/src/components/ui/__fixtures__/FoundationFixture.tsx` | import { App as AntApp, Button as AntButton, ConfigProvider, Modal } from 'antd'; | （删除） |
| `src/web/src/components/ui/__fixtures__/FoundationFixture.tsx` | {/* Keep the nested portal inside AntD's focus boundary. */} | （删除） |
| `src/web/src/components/ui/__fixtures__/FoundationFixture.tsx` | <section aria-label="AntD reference" className="foundation-section"> | </div> |
| `src/web/src/components/ui/__fixtures__/FoundationFixture.tsx` | <h2>AntD reference</h2> | </main> |
| `src/web/src/components/ui/__fixtures__/FoundationFixture.tsx` | <AntButton onClick={() => setAntOpen(true)}>Open AntD dialog</AntButton> | （删除） |
| `src/web/src/components/ui/__fixtures__/FoundationFixture.tsx` | <Modal open={antOpen} title="AntD dialog" onCancel={() => setAntOpen(false)} footer={null} destroyOnHidden> | （删除） |
| `src/web/src/components/ui/__fixtures__/FoundationFixture.tsx` | <AntButton onClick={() => setAntOpen(false)}>Close AntD dialog</AntButton> | （删除） |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | import { App as AntApp, Button as AntButton, ConfigProvider, Drawer as AntDrawer, Input as AntInput, Modal, Popconfirm, Select } from 'antd'; | （删除） |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | {['dialog', 'right drawer', 'bottom drawer', 'confirm'].flatMap((kind) => ['Orbit', 'AntD'].map((system) => { | {['dialog', 'right drawer', 'bottom drawer', 'confirm'].map((kind) => { |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | if (name === 'AntD confirm') modal.confirm({ title: 'Delete runner?', content: 'This removes the runner from your account.', | })} |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | <Modal open={current === 'AntD dialog'} onCancel={close} title="Edit workspace" footer={legacyFooter} classNames={classNames}> | （删除） |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | <AntDrawer open={current === 'AntD ${placement} drawer'} onClose={close} title="Edit workspace" placement={placement} | （删除） |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | </AntDrawer> | （删除） |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | <AntDrawer open={open === 'Legacy drawer'} onClose={close} title="Legacy drawer" destroyOnHidden> | （删除） |
| `src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx` | </AntDrawer> | （删除） |
| `src/web/src/components/ui/__fixtures__/ToastsFixture.tsx` | import { App as AntApp, ConfigProvider } from 'antd'; | （删除） |

### 3339873a7 feat(web): the app on Orbit's reset and root; ConfigProvider, AntApp and theme.ts leave (P6)

| 文件 | 原行 | 现行 |
| --- | --- | --- |
| `src/web/src/firstPageStylesheet.test.ts` | 'antd/dist/reset.css', | 'components/ui/reset.css', |
| `src/web/src/index.css` | same names. AntD components are themed separately in theme.ts (darkAlgorithm). | same names. |
| `src/web/src/index.css` | .ant-input, | Orbit fields lift themselves (components/ui/TextControls.css, Select.css). */ |
| `src/web/src/index.css` | .ant-input-affix-wrapper input, | （删除） |
| `src/web/src/index.css` | textarea.ant-input, | （删除） |
| `src/web/src/index.css` | /* AntD Select focuses this hidden search input on tap — a <16px font here is what | （删除） |
| `src/web/src/index.css` | AntD sizes it from the Select's own font token through a rule that outranks a plain | （删除） |
| `src/web/src/index.css` | .ant-select-input { | （删除） |
| `src/web/src/main.tsx` | import { App as AntApp, ConfigProvider } from 'antd'; | （删除） |
| `src/web/src/main.tsx` | import 'antd/dist/reset.css'; | import './components/ui/reset.css'; |
| `src/web/src/main.tsx` | // Toasts are not AntD's: lib/toast.tsx posts them into one feed and <ToastViewport /> draws it | // lib/toast.tsx posts toasts into one feed and <ToastViewport /> draws it (docs/mocks/toast-system), |
| `src/web/src/main.tsx` | // Feeds AntD the matching theme for the resolved light/dark mode; custom CSS is | （删除） |
| `src/web/src/theme.ts` | import { theme as antdTheme, type ThemeConfig } from 'antd'; | （删除） |
| `src/web/src/theme.ts` | // Dark counterpart. AntD's darkAlgorithm derives the full dark palette from the | （删除） |
| `src/web/src/theme.ts` | // values index.css uses for its dark tokens, so custom CSS and AntD stay in sync. | （删除） |
| `src/web/src/theme.ts` | algorithm: antdTheme.darkAlgorithm, | （删除） |

### a244dfc06 chore(web): remove the antd dependency (P6)

| 文件 | 原行 | 现行 |
| --- | --- | --- |
| `src/web/src/components/StatusTag.tsx` | import { Tag } from 'antd'; | （删除） |

### 6879542dc docs(web): the history notes about the replaced library leave the source (P6)

| 文件 | 原行 | 现行 |
| --- | --- | --- |
| `src/web/src/components/ProjectDoneConversation.test.tsx` | /** Six criteria, every one of them Not met yet — the antd migration the owner reported on | /** Six criteria, every one of them Not met yet — the component migration the owner reported on |
| `src/web/src/components/ProjectDoneConversation.test.tsx` | it('draws nothing for a project whose criteria are not met yet — the antd migration', async () => { | it('draws nothing for a project whose criteria are not met yet — the component migration', async () => { |
| `src/web/src/components/ProjectWhyNotDoneGate.test.tsx` | /** The antd migration the owner reported on 2026-10-06: started, OPEN, six criteria and every one | /** The component migration the owner reported on 2026-10-06: started, OPEN, six criteria and every one |
| `src/web/src/components/ProjectWhyNotDoneGate.test.tsx` | it('holds of nothing with a criterion still unmet — the antd migration the owner reported', () => { | it('holds of nothing with a criterion still unmet — the component migration the owner reported', () => { |
| `src/web/src/components/TaskDetailPanel.test.tsx` | // '' is no tooltip — antd renders nothing for an empty title, which is right when there is | // '' is no tooltip — an empty title draws nothing, which is right when there is |
| `src/web/src/components/ToastViewport.tsx` | * both of AntD's surfaces used to hang as two separate stacks; a phone centres one column under the | * the replaced message and notification surfaces used to hang as two separate stacks; a phone centres one column under the |
| `src/web/src/components/WikiMarks.tsx` | * by a parity test. What is here is the drawing: which AntD glyph stands for a kind, and which tone | * by a parity test. What is here is the drawing: which @ant-design/icons glyph stands for a kind, and which tone |
| `src/web/src/components/ui/Empty.tsx` | *  (attribution and license: ./antd-empty.LICENSE), with their colours read from the theme. Each | *  (attribution and license: the Ant Design license file in this directory), with their colours read |
| `src/web/src/components/ui/Floating.css` | /* Retains Ant Design's rounded arrow geometry (MIT; ./antd-empty.LICENSE). */ | /* Retains Ant Design's rounded arrow geometry (MIT; the Ant Design license file in this directory). */ |
| `src/web/src/components/ui/MultiSelect.tsx` | // AntD keeps a multiple picker open after selecting a search result. | // As the replaced multiple picker: it stays open after selecting a search result. |
| `src/web/src/components/ui/README.md` | - 公共 props 只覆盖当前业务需要；优先原生 DOM 属性、可访问名称与原生 ref。不要复制 AntD 全部 props，不读取第三方内部 class/DOM。 | - 公共 props 只覆盖当前业务需要；优先原生 DOM 属性、可访问名称与原生 ref。不要复制被替换组件库的全部 props，不读取第三方内部 class/DOM。 |
| `src/web/src/components/ui/README.md` | - 'boundary.test.ts' 检查实际源码的导入、重导出、动态导入及类型引用：Base UI 只能在本目录内；业务不能引用私有 fixture；公共 ui 不能依赖 antd。共存 fixture 中的 AntD 对照在 P6 删除。 | - 'boundary.test.ts' 检查实际源码的导入、重导出、动态导入及类型引用：Base UI 只能在本目录内；业务不能引用私有 fixture。被替换的组件库在 P6 离开依赖，再导入它在类型检查与构建时就失败。 |
| `src/web/src/components/ui/README.md` | \| 'Empty' \| 空状态（P4.3a）：'image="default"'（100px 插图）或 '"simple"'（40px 插图，整块次要文字色、上下 32px），'description'（默认 “No data”），children 是下方 16px 处的操作（如 New project）。两幅插图是被替换组件的 MIT 图形（见 antd-empty.LICENSE），颜色取主题变量，带 “No data” 标题，同被替换组件。 \| | \| 'Empty' \| 空状态（P4.3a）：'image="default"'（100px 插图）或 '"simple"'（40px 插图，整块次要文字色、上下 32px），'description'（默认 “No data”），children 是下方 16px 处的操作（如 New project）。两幅插图是被替换组件的 MIT 图形（许可见本目录的 Ant Design 许可文件），颜色取主题变量，带 “No data” 标题，同被替换组件。 \| |
| `src/web/src/components/ui/README.md` | 组件自行导入局部样式，基础变量由应用入口统一加载。不要把原 AntD type="primary" 或内部 ref 直接带到新组件；按上述语义改写调用。业务布局的手机 40px 按钮、等宽字体等例外随页面迁移保留，不能仅靠切换 import 完成迁移。 | 组件自行导入局部样式，基础变量由应用入口统一加载。不要把被替换组件的 type="primary" 或内部 ref 直接带到新组件；按上述语义改写调用。业务布局的手机 40px 按钮、等宽字体等例外随页面迁移保留，不能仅靠切换 import 完成迁移。 |
| `src/web/src/components/ui/README.md` | - 'Result'（'Result.tsx' + '.css'，P4.2）：结果块（被替换 Result）：'status="success/info/warning"' 的 72px 状态图标居中，24px 标题与 14px 次要说明 'subTitle'。注册确认页与 CLI 登录页使用。'status="404"'（P5.3）：图标位置换成被替换结果块的 404 插图（250×295 的盒，图 252×294，固定配色，两种主题相同；MIT，见 antd-empty.LICENSE，插图在 'ResultNotFound.tsx'，只由 Result 引用）；'extra'（P5.3）：文字下方 24px 的操作行，居中，相邻 8px（会话控制台找不到会话时的 Go home）。 | - 'Result'（'Result.tsx' + '.css'，P4.2）：结果块（被替换 Result）：'status="success/info/warning"' 的 72px 状态图标居中，24px 标题与 14px 次要说明 'subTitle'。注册确认页与 CLI 登录页使用。'status="404"'（P5.3）：图标位置换成被替换结果块的 404 插图（250×295 的盒，图 252×294，固定配色，两种主题相同；MIT，许可见本目录的 Ant Design 许可文件，插图在 'ResultNotFound.tsx'，只由 Result 引用）；'extra'（P5.3）：文字下方 24px 的操作行，居中，相邻 8px（会话控制台找不到会话时的 Go home）。 |
| `src/web/src/components/ui/README.md` | 被替换的 Typography 与 List 没有交互，迁移为原生元素加本目录的公开类名，样式文件由调用方导入（'import '../components/ui/Typography.css''、'List.css'）。选择器保持被替换规则的权重，并在 index.css 之后加载，所以页面原有的覆盖规则对新元素的层叠结果与对被替换元素相同；改写页面覆盖时把 '.ant-typography'/'.ant-list-*' 换成对应的 Orbit 类名即可。 | 被替换的 Typography 与 List 没有交互，迁移为原生元素加本目录的公开类名，样式文件由调用方导入（'import '../components/ui/Typography.css''、'List.css'）。选择器保持被替换规则的权重，并在 index.css 之后加载，所以页面原有的覆盖规则对新元素的层叠结果与对被替换元素相同；页面覆盖已在迁移中改写为对应的 Orbit 类名。 |
| `src/web/src/components/ui/README.md` | 命令式入口是局部 'useConfirm()'，返回 '[confirm, holder]'。holder 放在调用处的上下文和所属 Dialog/Drawer 内，不新增全站 Provider、静态单例或 AntD modal API 仿制。confirm(options) 返回 Promise<boolean>；同一个 hook 的重复调用复用当前确认及 Promise，不排队叠加窗口；宿主卸载时未完成的确认结果为 false，已经发出的业务请求不会被组件取消。若请求需要取消，由业务自行持有 AbortController。 | 命令式入口是局部 'useConfirm()'，返回 '[confirm, holder]'。holder 放在调用处的上下文和所属 Dialog/Drawer 内，不新增全站 Provider、静态单例或旧组件库 modal API 的仿制。confirm(options) 返回 Promise<boolean>；同一个 hook 的重复调用复用当前确认及 Promise，不排队叠加窗口；宿主卸载时未完成的确认结果为 false，已经发出的业务请求不会被组件取消。若请求需要取消，由业务自行持有 AbortController。 |
| `src/web/src/components/ui/README.md` | 对照样例和行为矩阵在 'ui-migration/overlays.html'，包含真实 AntD Modal/Drawer/Popconfirm/Select 与新组件，全部使用固定数据。旧业务页面的整页替换仍由 P3/P4/P5承担。 | （删除） |
| `src/web/src/components/ui/README.md` | 'main.tsx' 按 'ui/Overlay.css'、'ReviewCard.css'、highlight.js 的 'github.css' → 'antd/dist/reset.css' → 'index.css' → 'ui/foundation.css' 加载。生产构建把首屏静态导入的全部 CSS 合成一个文件，顺序就是模块第一次被导入的顺序（'vite.config.ts' 的 'codeSplitting' 分组，由 'src/firstPageStylesheet.test.ts' 守着）：前三个在 reset 与 index.css 之前，是此前生产构建一直给它们的位置（入口与懒加载的会话导出共用的 chunk），同权重时 index.css 的规则胜过它们；其余 Orbit 组件样式都在 index.css 之后，与开发模式相同。只有懒加载 chunk 才用到的 CSS（React Flow）仍随那个 chunk 加载。不分组时，入口与懒加载 chunk 共用的组件会被拆进共用 chunk，它的样式链接排在入口样式（含 index.css）之前，层叠随拆包结果变化（P4.3b 记录）。'foundation.css' 只声明变量，不引入 reset、全局 button/input 样式、CSS layer 或新的 stacking context；控件样式限定自己的 '.orbit-*' 类或 CSS module。图标继续使用 '@ant-design/icons'。 | 'main.tsx' 按 'ui/root.css' → 'ui/Overlay.css'、'ReviewCard.css'、highlight.js 的 'github.css' → 'ui/reset.css' → 'index.css' → 'ui/foundation.css' 加载。生产构建把首屏静态导入的全部 CSS 合成一个文件，顺序就是模块第一次被导入的顺序（'vite.config.ts' 的 'codeSplitting' 分组，由 'src/firstPageStylesheet.test.ts' 守着）：'root.css' 在最前，是被替换组件库注入运行时样式的位置；随后三个在 reset 与 index.css 之前，是此前生产构建一直给它们的位置（入口与懒加载的会话导出共用的 chunk），同权重时 index.css 的规则胜过它们；其余 Orbit 组件样式都在 index.css 之后，与开发模式相同。只有懒加载 chunk 才用到的 CSS（React Flow）仍随那个 chunk 加载。不分组时，入口与懒加载 chunk 共用的组件会被拆进共用 chunk，它的样式链接排在入口样式（含 index.css）之前，层叠随拆包结果变化（P4.3b 记录）。'foundation.css' 只声明变量，不引入 reset、全局 button/input 样式、CSS layer 或新的 stacking context；控件样式限定自己的 '.orbit-*' 类或 CSS module。图标继续使用 '@ant-design/icons'。 |
| `src/web/src/components/ui/README.md` | 行高：Checkbox/Radio/Switch 标签使用无单位的 1.5714（14px 时即 22px），其中字号不同的说明文字按自身字号计算行高，与被替换组件相同。Dialog/Drawer 外壳保持 22px（评审等对话框直接基于它设计）；替换 AntD Modal 的对话框需要被替换的无单位行高时，在业务样式中限定到该对话框（如 '.share-dialog.orbit-overlay'）。业务样式（index.css）覆盖 Orbit 组件类时，要用组件类限定提高优先级（如 '.share-layer-check.orbit-choice'），因为组件样式在 index.css 之后加载（'Overlay.css' 例外，见上）。 | 行高：Checkbox/Radio/Switch 标签使用无单位的 1.5714（14px 时即 22px），其中字号不同的说明文字按自身字号计算行高，与被替换组件相同。Dialog/Drawer 外壳保持 22px（评审等对话框直接基于它设计）；替换旧 Modal 的对话框需要被替换的无单位行高时，在业务样式中限定到该对话框（如 '.share-dialog.orbit-overlay'）。业务样式（index.css）覆盖 Orbit 组件类时，要用组件类限定提高优先级（如 '.share-layer-check.orbit-choice'），因为组件样式在 index.css 之后加载（'Overlay.css' 例外，见上）。 |
| `src/web/src/components/ui/README.md` | AntD 'ConfigProvider' / 'AntApp'、'theme.ts' 算法和 reset 保留到 P6。当前 AntD 是 6.6.5，无需 v5 React 19 patch。新控件直接继承根 CSS 变量，body portal 同样继承 html 主题，不需要复制主题 class。 | 应用没有组件库的 Provider 与主题运行时。被替换的根容器给它下面的一切的样式，现在在 'root.css'，排在所有样式表之前（组件库的运行时样式注入在打包样式之前），同权重时页面与组件规则照旧胜出：'AppRoot'（'main.tsx' 与各样例入口用它）画出的 'div.orbit-app' 给页面 14px、无单位 22/14 行高、正文色与应用字体，行高以内联样式给出全精度（写在样式表里会被压缩器写成 1.57143，继承下去的行高都偏大一丝，WebKit 下 22px 成 22.000019px），同被替换根容器从运行时变量得到的值；它下面的链接沿用被替换组件库的链接 reset（Ant Design 6.6.5，MIT）——':where(.orbit-app) a' 不加权重，链接色、悬停与按下色、无下划线、键盘焦点环取 foundation.css 里同值的变量。挂在 body 下的 portal 两者都不继承，与此前相同，自己给出字号与行高。'reset.css' 是被替换组件库 reset 的逐条移植（同一许可），放在原 import 的位置。控件直接继承根 CSS 变量，body portal 同样继承 html 主题，不需要复制主题 class。'ui-migration' 的样例入口按同样顺序加载 root、reset、index.css 与 foundation.css，并包同样的根。 |
| `src/web/src/components/ui/README.md` | 样式只使用 Orbit 类名、自己的属性与 Base UI 公开的 data-selected/data-highlighted/data-disabled 等状态；不查询或覆盖 AntD DOM。箭头与空态 SVG 沿用原 MIT 许可图形，保留许可。详见 [P2.2 证据](../../../../../docs/evidence/base-ui-migration/p2.2/README.md)，其中明示原手机14px覆盖缺陷与任务要求17px的差异，以及旧 Modal 最后一次 Tab 的宿主缺陷。 | 样式只使用 Orbit 类名、自己的属性与 Base UI 公开的 data-selected/data-highlighted/data-disabled 等状态；不查询或覆盖第三方 DOM。箭头与空态 SVG 沿用原 MIT 许可图形，保留许可。详见 [P2.2 证据](../../../../../docs/evidence/base-ui-migration/p2.2/README.md)，其中明示原手机14px覆盖缺陷与任务要求17px的差异，以及旧 Modal 最后一次 Tab 的宿主缺陷。 |
| `src/web/src/components/ui/README.md` | P3.1 把自动增高、手动高度和 DOM 访问收进 'Textarea'，业务不再经由 AntD 字段的内部 ref 取 textarea。ref 直接是原生 textarea：'focus()'、'setSelectionRange()'、'selectionStart'、'scrollHeight/clientHeight/offsetHeight' 都按 DOM 原义使用，组件不暴露其它句柄。 | P3.1 把自动增高、手动高度和 DOM 访问收进 'Textarea'，业务不再经由被替换字段的内部 ref 取 textarea。ref 直接是原生 textarea：'focus()'、'setSelectionRange()'、'selectionStart'、'scrollHeight/clientHeight/offsetHeight' 都按 DOM 原义使用，组件不暴露其它句柄。 |
| `src/web/src/components/ui/README.md` | 'ui-migration/composer.html' 用真实 CSS、ComposerMirror 和输入框辅助函数复现 WorkspaceView 会话输入与 TaskDetailPanel 评论框，同一脚本分别驱动旧 AntD 字段和 Orbit Textarea。'npm run test:ui-composer -w @orbit/web' 比较几何、计算样式、截图像素、镜像字形对齐、附件对齐、手动高度、断点、过渡，以及中文组合输入、Enter/Shift+Enter、⌘/Ctrl+Enter、候选菜单、粘贴、长度上限和历史回溯。Chromium 用 DevTools 真实组合输入；WebKit 无输入法自动化，以 insertText 加组合事件/keyCode 229 重放，不代表真机输入法或软键盘。详见 [P3.1 证据](../../../../../docs/evidence/base-ui-migration/p3.1/README.md)。 | 'ui-migration/composer.html' 用真实 CSS、ComposerMirror 和输入框辅助函数复现 WorkspaceView 会话输入与 TaskDetailPanel 评论框。P3.1 时同一脚本分别驱动旧字段与 Orbit Textarea 并逐项比较；P6 起只驱动 Orbit Textarea：'npm run test:ui-composer -w @orbit/web' 检查与 P0 页面字段相同的起始尺寸、自动增高与滚动、手动高度、镜像字形对齐、附件对齐、断点字号、过渡，以及中文组合输入、Enter/Shift+Enter、⌘/Ctrl+Enter、候选菜单、粘贴、长度上限和历史回溯。Chromium 用 DevTools 真实组合输入；WebKit 无输入法自动化，以 insertText 加组合事件/keyCode 229 重放，不代表真机输入法或软键盘。详见 [P3.1 证据](../../../../../docs/evidence/base-ui-migration/p3.1/README.md)。 |
| `src/web/src/components/ui/README.md` | 'ImagePreview'（'ImagePreview.tsx' + '.css'）和 'Image'（'Image.tsx' + '.css'）替代 AntD 'Image.PreviewGroup' 与 'Image'。 | 'ImagePreview'（'ImagePreview.tsx' + '.css'）和 'Image'（'Image.tsx' + '.css'）替代被替换组件库的 'Image.PreviewGroup' 与 'Image'。 |
| `src/web/src/components/ui/Select.tsx` | // to the element focus is moving to; they then act as in the list, as with AntD. Tab and Shift+Tab | // to the element focus is moving to; they then act as in the list, as with the replaced select. Tab and Shift+Tab |
| `src/web/src/components/ui/SelectEmpty.tsx` | * MIT-licensed Empty/simple; attribution and license: ./antd-empty.LICENSE. */ | * MIT-licensed Empty/simple; attribution and license: the Ant Design license file in this directory. */ |
| `src/web/src/components/ui/TextControls.css` | /* Focus outranks hover, as in AntD: a field just clicked into is still under the pointer. */ | /* Focus outranks hover, as in the replaced fields: a field just clicked into is still under the pointer. */ |
| `src/web/src/components/ui/TextControls.css` | /* As the AntD textarea: every change eases over 0.3s, the auto-size height included. */ | /* As the replaced textarea: every change eases over 0.3s, the auto-size height included. */ |
| `src/web/src/components/ui/TextControls.css` | /* Borderless: no frame or fill, the frame's 1px given back as padding, and AntD's in-field focus | /* Borderless: no frame or fill, the frame's 1px given back as padding, and the replaced field's in-field |
| `src/web/src/components/ui/TextControls.css` | /* Preserve the existing mobile text-field sizing: index.css lifts AntD's unadorned inputs and | /* The existing mobile text-field sizing, as index.css gave the replaced fields: unadorned inputs and |
| `src/web/src/components/ui/TextControls.css` | textareas to 16px at ≤960px. AntD affix inputs keep their component font size. */ | textareas are lifted to 16px at ≤960px; inputs with a prefix or suffix keep their component font size. */ |
| `src/web/src/components/ui/Textarea.tsx` | // The measured size wins over the caller's style, as it did for the AntD field it replaces. | // The measured size wins over the caller's style, as it did for the field it replaces. |
| `src/web/src/components/ui/Textarea.tsx` | // the same list and arithmetic as the AntD field it replaces, so a migrated field grows to the | // the same list and arithmetic as the field it replaces, so a migrated field grows to the |
| `src/web/src/components/ui/boundary.test.ts` | it('keeps Base UI inside Orbit components, fixtures private, and public components free of AntD', () => { | it('keeps Base UI inside Orbit components and fixtures private', () => { |
| `src/web/src/components/ui/boundary.test.ts` | if (inside(file, uiRoot) && !inside(file, fixtureRoot) && /^antd(?:\/\|$)/.test(specifier)) { | （删除） |
| `src/web/src/components/ui/boundary.test.ts` | report('AntD inside public ui'); | （删除） |
| `src/web/src/index.css` | /* The Reopen question replaced an AntD Modal, whose line height is unitless: text of another size | /* The Reopen question replaced a modal whose line height is unitless: text of another size |
| `src/web/src/index.css` | /* Unitless line height, as the AntD Modal this dialog replaced: smaller text inside keeps its own | /* Unitless line height, as the modal this dialog replaced: smaller text inside keeps its own |
| `src/web/src/indexCss.test.ts` | * it are held at the two they had rather than judged here (the toast rule left with AntD's toasts). At-rules are not counted — '@media (max-width: 600px)' is | * it are held at the two they had rather than judged here (the toast rule left with the replaced toasts). At-rules are not counted — '@media (max-width: 600px)' is |
| `src/web/src/lib/toast.test.tsx` | // AntD's handle settled only when the toast closed, and an error toast never closes on its own: | // The replaced library's handle settled only when the toast closed, and an error toast never closes on its own: |
| `src/web/src/lib/toast.tsx` | // None of these hands anything back. AntD's handle, which they used to return, was a thenable that | // None of these hands anything back. The replaced library's handle, which they used to return, was a thenable that |
| `src/web/src/lib/toastStore.ts` | * singleton, like AntD's message holder was: a toast outlives the page that raised it. | * singleton, like the replaced message holder was: a toast outlives the page that raised it. |
