# Orbit 公共组件基础

本目录是 Base UI 与业务之间的唯一实现边界。P1.1 接入依赖与主题，P1.2 提供基础控件，P2.1 提供 Dialog/Drawer/ConfirmDialog。公共 API 按实际调用需求定义，不导出私有验证样例。

## 导入与公共 API

- 业务按组件导入 `components/ui/<Component>`；组件内部按需导入 `@base-ui/react/<component>`，不把 Base UI 的 Root/Portal/状态对象直接重导出给业务。
- 公共 props 只覆盖当前业务需要；优先原生 DOM 属性、可访问名称与原生 ref。不要复制 AntD 全部 props，不读取第三方内部 class/DOM。
- `__fixtures__` 仅供 `ui-migration/foundation.html`、`controls.html`、`overlays.html`、`choices.html` 和 `composer.html` 使用，没有业务路由、生产入口或公共导出。Foundation 的临时按钮/弹窗仍为私有；其余使用真实公共组件与旧控件对照。
- `boundary.test.ts` 检查实际源码的导入、重导出、动态导入及类型引用：Base UI 只能在本目录内；业务不能引用私有 fixture；公共 ui 不能依赖 antd。共存 fixture 中的 AntD 对照在 P6 删除。

## 基础控件

| 导入 | 最小约定 |
| --- | --- |
| `Button` | `variant="default/primary/dashed/text/link"`（dashed：虚线边框的默认按钮，如“添加模型”“添加变量”），`size="small/middle/large"`，`danger`、`icon`、`loading`、`iconPlacement="start/end"`（P4.3a：`end` 时图标在文字之后，如展开/收起的箭头，与文字间隔同样 8px）；其余为原生 button 属性，**`type` 是 button/submit/reset**，默认 button。ref 为 HTMLButtonElement。纯图标必须给可访问名称。loading 阻止再次激活，保留焦点并暴露 aria-busy；disabled 按原生规则退出 Tab 顺序。 |
| `LinkButton`（同 Button 文件） | 同一外观的原生 anchor，使用 href/target/rel/download 等原生属性和 HTMLAnchorElement ref；链接与操作按钮分别保持导航和提交语义。 |
| `Input` | 原生 input 属性/ref，`size="small/middle/large"`、`invalid`、`warning`（P4.3a：被替换字段的 warning 状态——警告色边框、较浅的悬停色、聚焦时警告色外圈；与 `invalid` 同给时 `invalid` 优先）、`prefix/suffix`。有装饰时 className/style 指向外壳，其他原生属性与 ref 仍指向 input；装饰区点击聚焦。标签和错误说明由调用方使用 label/aria-describedby 关联。`allowClear` 加 `onClear`（P4.3a，受控字段的清除）：末尾一个名为 Clear 的按钮，12px 图标、第四级文字色，悬停与按下加深，同被替换字段；字段为空、禁用或只读时占位但不可见（被替换字段的 suffix 同样占位）；指针按下不夺焦点，点击后焦点回到字段，再由 `onClear` 清空调用方的值。 |
| `Textarea` | 原生 textarea 属性，ref 即 HTMLTextAreaElement；`invalid`、rows、`variant="outlined/borderless"`、`autoSize`（`true` 或 `{minRows,maxRows}`）。保留选区、输入与拖拽调整尺寸；自动增高与会话输入约定见下文。 |
| `Checkbox` | 必填 checked，onCheckedChange(boolean, event)（event 是引起变化的按下或按键，P4.3a 供需要读取 Shift 等修饰键的调用方）、indeterminate、disabled、invalid；支持 name/value/form 和原生 input ref。文字作为 children，点击标签与 Space 切换。 |
| `Radio` / `RadioGroup` | 组提供必填 value、onValueChange(value)、name、disabled；子项提供 value/children/disabled。组使用 aria-label 或 aria-labelledby 命名；箭头键跳过禁用项。variant="default/button"，size="small/middle"；按钮形态可设 `buttonStyle="outline/solid"`（默认 outline，solid 时选中项以主色填充，如暂停时长）。 |
| `Switch` | 必填 checked、onCheckedChange(boolean)，size="small/middle"、disabled、loading；使用 aria-label 或 aria-labelledby 命名，支持 name/value/form 和原生 input ref。宽 44px（small 28px），且同被替换开关的 min-width 不会更窄：flex 行里旁边的长文字挤不窄它（P4.2）。 |
| `Badge` | 原生 span 状态标签（替代 Tag），tone="default/info/success/warning/error/blue/green/orange/red/gold/purple"（blue 起的六种是被替换标签的同名预设色，明暗主题各取其色板；purple 由 P4.3a 为“等待核验”补上）、icon、children，其余为 span 属性（如 title）。使用可读文字表达状态；没有 ARIA 角色，测试按所在区域与文字定位。 |
| `Spinner` | 原生 span，size="small/middle"（14/20px），role=status、默认 aria-label="Loading"；嵌入已有加载状态时可设 aria-hidden，避免重复播报。 |
| `Avatar` | 原生 span 的圆形头像：`size`（px，默认 32）与文字 children，颜色/字号由调用方 style 给出。1px 透明边框、内容居中、行高为字号的 1.5714 倍。给 `src`（及可选 `alt`，默认空）时画图片：铺满边框内侧并按圆裁切，调用方背景在透明边框处仍可见；没有图片或图片加载失败时显示文字。`icon`（P5.1）：没有图片（或图片加载失败）时代替文字画出的图标，直接放在居中的盒里、字号为头像尺寸的一半，同被替换的图标头像（侧栏账号菜单在没有照片时的人形）。 |
| `Alert` | role=alert 的状态块：`type="error/warning/info"`（info：P4.3b，被替换说明块的信息色底、边框与 InfoCircleFilled 图标，明暗主题取其计算色）、`title`、`description`、`action`（P4.3a：文字之后 8px 的操作位，如 Retry）、className/style。无说明时 8px/12px 内边距、14px 图标与文字垂直居中；带说明时 20px/24px 内边距、24px 图标顶对齐、16px 标题。8px 圆角。说明或操作为空字符串、`false` 时不画，同被替换组件。 |
| `Empty` | 空状态（P4.3a）：`image="default"`（100px 插图）或 `"simple"`（40px 插图，整块次要文字色、上下 32px），`description`（默认 “No data”），children 是下方 16px 处的操作（如 New project）。两幅插图是被替换组件的 MIT 图形（见 antd-empty.LICENSE），颜色取主题变量，带 “No data” 标题，同被替换组件。 |
| `Skeleton` | 加载占位（P4.3a）：`rows`（默认 3）条 16px 高、4px 圆角、间隔 16px 的行，末行 61% 宽；1.4s 的流光同被替换组件，不随减少动态效果停止（被替换组件同样不停）。装饰性，`aria-hidden`；列表外边距沿用页面（P6 前为全局 reset 的下方 1em）。 |
| `Segmented` | radiogroup 分段切换：受控 `value`/`onValueChange`、`options`（value/label/disabled）、aria-label。`size="middle"`（默认，28px 项、11px 文字内边距、6px 轨道圆角、4px 项圆角）或 `"small"`（任务面板的 20px 项、7px 内边距、4px/2px 圆角），轨道均 2px。切换时选中块从旧项滑到新项（0.3s），减少动态效果时直接切换；方向键在项间移动并选中，选中项是唯一的 Tab 停留点。 |
| `PasswordInput` | Input 的密码形态（除 type 外同 Input 的 props）：末尾显示/隐藏开关同被替换字段——`role=button`、在 Tab 顺序中、Enter/Space 切换，名称为 Show/Hide 并以 aria-pressed 表示密码已显示；按下开关不夺走字段焦点与光标。`suffix` 排在开关之后，间隔 8px。默认自管显示状态；给 `visible` 时受控，开关经 `onVisibleChange(visible)` 请求变化（Provider 编辑页显示已保存的密钥前，先向服务器取回它）。 |
| `NumberInput` | 数字字段（替代 InputNumber）：受控 `value: number \| null`（空为 null）与 `onValueChange`，`min`/`max`/`step`（默认 1）/`precision`，`size="small/middle"`、disabled、placeholder、id/name、aria-label/aria-labelledby、`onPressEnter`。行为同被替换字段：输入中只上报界内的数（文字保持原样）；失焦、回车或步进时收回界内并按精度取整（四舍五入远离零，十进制精确运算），精度默认取值与步长小数位的较大者（步长 0.5 时 3 显示为 3.0）；ArrowUp/ArrowDown 步进；指针悬停时末端出现 22px 宽的上下步进键，按住 600ms 后每 200ms 重复。`role=spinbutton` 并暴露 aria-valuemin/max/now。没有封装 Base UI NumberField：它在输入中就把界外值夹到边界并上报（被替换字段只在失焦时收回，如暂停时长输入 169 时“暂停”按钮保持禁用），且用 `Intl.NumberFormat` 按地区格式化显示（200000 会显示为 200,000），两者都是可见的行为差异。 |

Button、Checkbox、Radio、Switch 的交互封装 Base UI；文本输入与标签/加载图形使用原生语义。Checkbox/Radio/Switch 的值由业务持有，公共 API 不提供 defaultChecked/defaultValue；需要 reset 的表单由父级重置受控值。Checkbox/Radio 的 className/style 指向标签，其他 DOM 属性指向可聚焦控件，input ref 的 focus 由 Base UI 转交可访问控件。不要读取隐藏 input 或第三方 DOM 结构。

```tsx
<Button variant="primary" type="submit" loading={saving}>Save</Button>
<label>Title<Input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
<Checkbox checked={includeTasks} onCheckedChange={setIncludeTasks}>Include tasks</Checkbox>
```

组件自行导入局部样式，基础变量由应用入口统一加载。不要把原 AntD type="primary" 或内部 ref 直接带到新组件；按上述语义改写调用。业务布局的手机 40px 按钮、等宽字体等例外随页面迁移保留，不能仅靠切换 import 完成迁移。

## 卡片、表单字段与表格

P4.1（登录、初始化、个人资料、设置）按页面实际需要补齐，均为原生结构，不依赖 Base UI。

- `Card`（`Card.tsx` + `Card.css`）：`section` 以标题 `h2` 命名（aria-labelledby），`title` 与 children，其余为 section 属性；`extra` 放在头部末端（14px 常规正文，`.orbit-card-extra`，有它时标题占满其余宽度，与被替换头部一样没有间隔），`size="small"` 为被替换小卡片的 38px 头部、12px 左右内边距、14px 标题与 12px 正文内边距（P4.3a）。几何同被替换卡片：1px 分隔色边框、8px 圆角、凸起表面；56px 头部，16px 半粗标题（25.14px 行高，单行省略），头部下 1px 分隔线，正文上移 1px 与之重叠；24px 正文内边距。**不带外边距**，卡片间距由页面给（如 `style={{ marginBottom: 16 }}`）。`.orbit-card`、`.orbit-card-head`、`.orbit-card-title`、`.orbit-card-body` 是这份样式的公开类名：根元素不能是 section 的情形（AdminSignInPage 的表单卡片）沿用这些类名并直接导入 `Card.css`。这些类名原是 main 为资料页与管理页写在 index.css 的原生卡片，P4.1 收为本目录的公共样式，不另造同名或近名的卡片类。
- `Field`（`Field.tsx` + `Field.css`）：被替换表单的纵向字段：标签在上（8px 间距），控件行至少 32px，下方是消息与 `extra` 说明。字段底部保留 24px；有消息时消息占用这 24px（单行 22px 不推动下方字段），多行才撑开；`extra` 在消息之后，至少 24px。消息出现时 0.1s 淡入并下移 5px，消失时同样淡出（减少动态效果时直接切换）。`id` 必填：标签指向它，消息与说明的 id 为 `${id}_help`、`${id}_extra`。children 是函数，拿到 `{ id, aria-invalid, aria-required, aria-describedby }` 交给控件；没有 `label` 时控件自带名称（复选框自己的文字）。`FieldFeedback status="success/error"` 是放在控件末尾（如 `PasswordInput` 的 `suffix`）的校验结果图标，0.2s 放大淡入。
- `useFormFields(initial, rules, dependsOn)`（`useFormFields.ts`）：文本字段的值与校验，触发时机同被替换表单：改动某字段即校验该字段；某字段改动时，依赖它且已改动或校验过的字段一并重校验（确认密码跟随新密码）；提交时 `validate()` 校验全部并返回是否通过；`reset()` 回到初值并清除消息与改动记录；`checked(name)` 表示该字段已改动或校验过（此时才显示通过图标）。规则是 `(value, values) => message | null`，每条失败的规则一条消息；文案由业务给出。表单使用原生 `<form onSubmit>`（Enter 提交、浏览器自身的 type=email 约束保持不变），不新增表单框架。
- `Table.css` + `TableScroll`（`Table.tsx`）：原生 `table.orbit-table` 的被替换数据表外观：半粗表头与 1px 分隔线、表头单元之间 1px 竖线、16px 单元格、行悬停底色、空表时一行居中浅色说明（`tr.orbit-table-empty > td > div`：说明限在可见宽度内，表格横向滚动时不随之移动）。`TableScroll` 是横向滚动盒：表格至少与盒同宽，内容更宽时横向滚动，并在还有内容的一侧画出与被替换表格相同的内阴影；滚动条颜色同被替换表格（因而用浏览器自身的覆盖式滚动条，不是全站 8px 自定义滚动条）；表头为空的列保留一个空格宽（被替换表格的测量行给每列放了空格）。列定义、排序、分页与选择都不在其中；需要时按实际需求再加。
- `TableFrame` 与 `TableEmptyRow`（`Table.tsx`，P4.2）：表格与盒同宽、不横向滚动时（Provider 列表的密钥表、管理员的用户表）用 `TableFrame` 包住 `table.orbit-table`：表格 100% 宽、凸起表面；`loading` 时同被替换表格的加载遮罩——表格半透明、不可操作，上覆表面色薄层，中间一个 Spinner，并标 aria-busy。`TableEmptyRow colSpan` 是没有行时的一行：被替换表格的插图与“No data”，上下 32px。响应式列由页面按媒体查询决定渲染哪些 `th/td`，固定列宽用 `colgroup` 与 `table-layout: fixed`，不另设列模型。
- `Descriptions`（`Descriptions.tsx` + `.css`，P4.2）：带边框的单列标签-值表（被替换的 bordered、small 描述列表）：`items`（key/label/children），标签是 `th scope=row`、浅底色（`--orbit-fill-alter`）与次要文字色，单元格 8px/16px 内边距；`labelWidth` 固定标签列宽，未给时按最长标签。注册确认页与 CLI 登录页使用。
- `Result`（`Result.tsx` + `.css`，P4.2）：结果块（被替换 Result）：`status="success/info/warning"` 的 72px 状态图标居中，24px 标题与 14px 次要说明 `subTitle`。注册确认页与 CLI 登录页使用。

## 排版与列表样式（P4.3a）

被替换的 Typography 与 List 没有交互，迁移为原生元素加本目录的公开类名，样式文件由调用方导入（`import '../components/ui/Typography.css'`、`List.css`）。选择器保持被替换规则的权重，并在 index.css 之后加载，所以页面原有的覆盖规则对新元素的层叠结果与对被替换元素相同；改写页面覆盖时把 `.ant-typography`/`.ant-list-*` 换成对应的 Orbit 类名即可。

- `Typography.css`：`.orbit-typography` 是文字（`span`）、段落（`div`，下方 1em）或标题（`h2`/`h4`/`h5`：30/38px、20/28px、16/24px，半粗，下方 0.5em，紧跟另一个排版元素时上方 1.2em）。与被替换组件的根一样，自己取应用字体和 14px，不继承父级字号（放在 12px 的说明行里仍是 14px）；`.orbit-typography-secondary`（次要文字色）、`.orbit-typography-warning`（警告文字色）。强调与代码用内层 `<strong>`（600）与 `<code>`（85% 等宽、浅底细边框、3px 圆角），与被替换组件的结构相同。复制按键是 `.orbit-typography-actions > button.orbit-typography-copy`，放在 `<code>` 之内、正文之后 4px，链接色，已复制时为成功色；文案与计时（Copy / Copied，3 秒）由调用方给出。
- `List.css`：`div.orbit-list.orbit-list-split[.orbit-list-sm] > ul.orbit-list-items > li.orbit-list-item`，行 12px（small 8px/16px）、行间 1px 分隔线、末行无线，≤576px 时行内换行；标题加说明的行用 `.orbit-list-item-meta > .orbit-list-item-meta-content > h4.orbit-list-item-meta-title + div.orbit-list-item-meta-description`。与被替换列表一样，列表内的元素不画 outline，行自己的焦点标记由页面样式给出。

两份样式与 Empty、Skeleton、Card 的 extra/small、Alert 的 action、Badge 的 purple、Input 的 allowClear 与 warning、Button 的 iconPlacement 都在 `ui-migration/controls.html` 中与被替换组件逐部件对照（`npm run test:ui-controls -w @orbit/web`：盒、外边距、文字、颜色、部件在根内的位置、插图各形状的填充与描边，以及每个字形与图标的位置）。

## Dialog、Drawer 和异步确认

业务分别导入 `ui/Dialog`、`ui/Drawer`、`ui/ConfirmDialog`；`OverlaySurface` 是三者共享的实现，不是业务调用入口。全部要求受控 `open` 和可访问 `title`，正文为 children，简单说明可用 description（自动关联 aria-describedby）。

- Dialog：`onClose` 是关闭请求，业务更新 open；默认宽度520px、顶部100px，宽度上限 100vw−32px；<=767px时保留旧弹窗108px顶部和8px边距（上限 100vw−16px）。宽度按视口宽度计，弹层视口出现滚动条时对话框宽度不变；滚动到底止于对话框下缘，与被替换对话框相同。footer 完全由调用方提供，原生表单使用 Button 的 type/form 属性。默认无自动 OK/Cancel。放不下一行的按钮换到下一行，每行靠右、行间无间隙，同被替换对话框里行内排列的按钮（P4.3a：手机上的长确认按钮）。
- Drawer：相同关闭和焦点约定，`placement="right"`（默认）或 `"bottom"`；width/height 支持 CSS 尺寸，默认378px，底部可用 height="auto"。headerActions 放置已有最大化等动作。复用 Base Dialog，因为现有 Drawer 没有滑动关闭或吸附点；不新增手势。
- 默认支持 Esc、单击/单指轻点遮罩和 Close 按钮；内部按下、外部释放不关闭。Dialog 的 Close 叠在正文之上（z-index 10，同被替换对话框的关闭按钮高出其弹层基准 10）：没有标题行的对话框（P4.3b 的项目完成、启动项目：title 传 null，由业务样式收起空的标题行）正文从顶上开始，与它重叠。`closeOnEscape`、`closeOnOutsideClick`、`closable` 分别控制三种关闭方式。busy 阻止关闭请求并禁用 Close；调用方负责自己的提交按钮。隐藏 Close 时应提供可访问的退出按钮。Dialog 的 Close 悬停底色同被替换对话框（明 6%、暗 12%，`--orbit-dialog-close-hover-bg`），比控件共用的悬停底色（4%/8%）深一级，按下时仍是共用的按下底色；Drawer 的 Close 未改。
- 默认聚焦弹层容器，避免手机打开时自动弹出软键盘；initialFocus 可指定原生 ref。默认返回先前焦点；从菜单、触摸入口或会卸载的节点打开时，传 `returnFocus` 指向稳定的触发按钮。不能通过读取第三方 DOM 找触发器。弹层里有焦点的控件消失时（卡片换掉自己的内容，如完成问句的 Not yet），Base UI 把焦点交回弹层容器；容器取得焦点一律不滚动，与首次聚焦相同，所以高于屏幕的对话框不会因此跳到容器顶部（P4.3b）。
- 默认关闭后卸载正文；`keepMounted` 适用于需保留未提交表单值的场景，关闭时隐藏且退出可访问树。业务页面迁移时明确选择其现有生命周期。
- ConfirmDialog：`width`（P4.3a，默认 416，协调者“开始新的协调者”提问用 480，让两个较长的回答留在一行）；`kind="success"`（P4.2）是只需确认的通知：成功图标、只有确认键并默认聚焦它（管理员新建用户后显示一次性密码）；默认 `kind="confirm"`。`onConfirm` 返回 Promise 时自动 pending，成功调用 `onClose(true)`；取消/Esc 调用 `onClose(false)`；遮罩不关闭。默认聚焦 Cancel。提交期间按钮/取消/Esc均被锁住，同一事件轮内的重复提交也会被阻止。throw/reject 会保留弹窗，以 role=alert 显示错误并恢复重试/取消；业务已经有 toast 时仍由业务保留。必须返回 mutateAsync/请求 Promise，不能用返回 void 的 mutate 冒充可等待提交。

`Popconfirm` 是锚定的小确认浮层（替代旧 Popconfirm，与模态 ConfirmDialog 并存）：`trigger` 为触发按钮；没有按钮时（如分享弹窗从菜单项发起的“关闭链接”）传 `anchor` 并受控 `open/onOpenChange`。`title`、`description`、`confirmText`/`cancelText`、`danger`、`confirmLoading`。`onConfirm` 返回 Promise 时确认键 loading，resolve 后关闭、reject 时保持打开；返回其它值时立即关闭（与旧组件的 onConfirm 约定相同）。定位、箭头、阴影与 Popover 相同，打开时聚焦浮层，Esc/外部点击关闭，`returnFocus` 指定关闭后的焦点；内容保留旧样式：警告图标、粗体标题、4px 间隔的说明、右对齐 8px 间距的小号按钮。

命令式入口是局部 `useConfirm()`，返回 `[confirm, holder]`。holder 放在调用处的上下文和所属 Dialog/Drawer 内，不新增全站 Provider、静态单例或 AntD modal API 仿制。confirm(options) 返回 Promise<boolean>；同一个 hook 的重复调用复用当前确认及 Promise，不排队叠加窗口；宿主卸载时未完成的确认结果为 false，已经发出的业务请求不会被组件取消。若请求需要取消，由业务自行持有 AbortController。

```tsx
const [confirm, confirmation] = useConfirm();
const remove = () => confirm({
  title: 'Delete runner?',
  description: 'This removes the runner from your account.',
  confirmText: 'Delete', danger: true,
  onConfirm: () => deleteMutation.mutateAsync(runner.id),
  returnFocus: actionsButton,
});
return <><Button onClick={() => void remove()}>Delete</Button>{confirmation}</>;
```

弹层以1000为根层级，每个拥有者内递增100；现有 toast 为2050。每层有自己的遮罩，Base UI 管理模态焦点、Tab/Shift+Tab、IME期间Esc和文档滚动锁。长 Dialog 由 viewport 滚动，Drawer 正文单独滚动。主题仍来自 html 的 data-theme；没有第二套主题状态。不要给 portal 宿主增加 transform 或裁切样式。

通知继续使用 `useToast` / `toastFeed` / `toastStore` 和唯一的 `ToastViewport`。打开的 Orbit 弹层通过自有 ref 登记反馈挂载点，最上层接收通知，使已有通知与后到通知都留在可访问树和 Tab 范围内；关闭后回到父层或 body，keepMounted 的关闭层不接收通知。React portal 始终使用同一宿主，避免切层重建通知 DOM。宿主使用原生 `popover="manual"` 顶层绘制，逃离弹层的缩放、平移和裁切；不增加遮罩或抢焦点，也不改变原 Dialog/Drawer 动画。通知自身保留首次入场的动画起点，切层以负 delay 延续原进度，不重播或删除入场动画。样式清除 popover 的默认盒模型，保留原通知原点、字体和安全区规则。持久的 body 固定定位测量节点保留 WebKit 的滚动条预留宽度，并随通知视口卸载清理；桌面通知列始终按它定位。手机通知列在被弹层接管前不加内联宽度，沿用原 CSS 排版；接管后保持它在 body 中最后的宽度（ResizeObserver 记录；先在弹层内出现或视口宽度变化时按测量节点），直到通知清空，避免 WebKit 在弹层内或关闭过程中按另一视口宽度排版。切层时不读布局、不多提交一次。合成提示 `will-change` 放在通知列而不是每张卡片上，胶囊和卡片都按通知列的整数像素原点栅格化，与原 body 内的通知一致。此能力依赖浏览器的 Popover API，已在本项目固定 Chromium/WebKit 版本验证。

悬停仍只暂停原先可悬停的结果卡片和可操作短通知。真实 mouseover 覆盖通知到达或布局移动到静止指针下的进入；mousemove 补足 WebKit 切层时遗漏的 mouseleave。清空队列后再次进入会重新确认暂停状态；鼠标静止时切层继续暂停，真正离开后才重新完整计时，未悬停的通知保留原截止时间。队列、去重和计时内核未改动，不读取库的内部 DOM。短通知及空宿主穿透点击，通知动作不关闭拥有它的弹层。

通知行为与集成矩阵：`npm run test:ui-toasts -w @orbit/web`；固定端口14377，沿用 P0 浏览器/字体环境。`toasts-lifecycle.browser.mjs` 保留验收方的原复现，追加正常动画每帧卡片位置/透明度、嵌套开关、静止悬停和原截止时间检查；`toasts-hover.browser.mjs` 以原生时钟验证静止指针下的新通知，并精确验证布局进入/离开、清空后替换及恢复计时。可访问检查证明 live region 的优先级、内容和可见性，不代替真实读屏软件听测。P0 生产通知链路的单独复跑为 `npm run test:ui-migration -w @orbit/web -- feedback-production.browser.mjs`，原 P0 截图断言保持不变。

混用时显式标出拥有关系，不查询 `.ant-*`：

```tsx
// 新弹层在旧 Modal/Drawer 内：把其正文包在公共边界中。
<Modal open={open} onCancel={close}>
  <OverlayScope><EditorWithOrbitDialogs /></OverlayScope>
</Modal>

// 旧弹层在新 Dialog/Drawer 内：hook 必须在该新弹层的子组件中调用。
const legacy = useOverlayChild(childOpen, () => setChildOpen(false));
<Modal open={childOpen} onCancel={() => setChildOpen(false)} keyboard={false}
  getContainer={legacy.getContainer} zIndex={legacy.zIndex} />
// Popconfirm/Select 用 getPopupContainer；Select 用公开 styles.popup.root.zIndex。
```

useOverlayChild 按受控 open 登记旧子层，Esc 先交给最上层旧弹层的回调；关闭旧 Modal 的内置 keyboard 可避免其全局监听器参与第二次关闭。旧 Select 自身仍处理选项键盘。portal 留在父焦点范围，原生 focusout 在自有宿主处截断，避免子弹层卸载时父层的延迟焦点恢复覆盖子层返回目标。该边界仅用于明确拥有的混合组合；独立兄弟弹层应由业务确定打开/关闭关系。P2.2 的新 Menu/Popover/Select 沿用相同层级和拥有关系。

对照样例和行为矩阵在 `ui-migration/overlays.html`，包含真实 AntD Modal/Drawer/Popconfirm/Select 与新组件，全部使用固定数据。旧业务页面的整页替换仍由 P3/P4/P5承担。

## 主题和样式

复用 `lib/theme.tsx` 的 `ThemeProvider` / `useThemeMode`。唯一主题状态仍是 `system/light/dark`，解析结果写到 `<html data-theme>`；账号偏好为来源，localStorage 为首屏缓存。保留 `index.html` 的同步首屏脚本、theme-color 和原有 boot 样式。不创建第二套主题状态或把 Provider 包在每个控件外。

`main.tsx` 按 `ui/Overlay.css`、`ReviewCard.css`、highlight.js 的 `github.css` → `antd/dist/reset.css` → `index.css` → `ui/foundation.css` 加载。生产构建把首屏静态导入的全部 CSS 合成一个文件，顺序就是模块第一次被导入的顺序（`vite.config.ts` 的 `codeSplitting` 分组，由 `src/firstPageStylesheet.test.ts` 守着）：前三个在 reset 与 index.css 之前，是此前生产构建一直给它们的位置（入口与懒加载的会话导出共用的 chunk），同权重时 index.css 的规则胜过它们；其余 Orbit 组件样式都在 index.css 之后，与开发模式相同。只有懒加载 chunk 才用到的 CSS（React Flow）仍随那个 chunk 加载。不分组时，入口与懒加载 chunk 共用的组件会被拆进共用 chunk，它的样式链接排在入口样式（含 index.css）之前，层叠随拆包结果变化（P4.3b 记录）。`foundation.css` 只声明变量，不引入 reset、全局 button/input 样式、CSS layer 或新的 stacking context；控件样式限定自己的 `.orbit-*` 类或 CSS module。图标继续使用 `@ant-design/icons`。

行高：Checkbox/Radio/Switch 标签使用无单位的 1.5714（14px 时即 22px），其中字号不同的说明文字按自身字号计算行高，与被替换组件相同。Dialog/Drawer 外壳保持 22px（评审等对话框直接基于它设计）；替换 AntD Modal 的对话框需要被替换的无单位行高时，在业务样式中限定到该对话框（如 `.share-dialog.orbit-overlay`）。业务样式（index.css）覆盖 Orbit 组件类时，要用组件类限定提高优先级（如 `.share-layer-check.orbit-choice`），因为组件样式在 index.css 之后加载（`Overlay.css` 例外，见上）。

颜色优先直接用现有 `--bg-base/raised`、`--text-1/2/3`、`--border`、`--brand` 和状态变量。新增 `--orbit-*` 仅补足控件真实角色；**品牌色与主控件填充不是同一值**：暗色 `--brand=#5b8cff`，主控件实测为 `#2e62dc`，hover 为 `#5585e8`。禁用色和焦点轮廓也来自计算样式，不能从 seed 推测。

`--orbit-border-split` 保留旧 Drawer 的半透明分隔线计算值：light 为 `rgba(17, 42, 80, 0.08)`，dark 为 `rgba(223, 223, 226, 0.05)`。标题底边和 footer 顶边均为1px solid；透明色在 elevated 表面上的合成结果也纳入真实截图对照。

基础尺寸为 32px、圆角 6px，文字 14px/22px，按钮水平 padding 15px、gap 8px；小号为 24px/4px/7px，弹窗圆角 10px，菜单圆角 8px。保留以下局部差异，不新增全局手机控件高度规则：任务头部 <=600px 的主按钮与图标按钮 40px，小号 Save schedule 仍是 24px；设置卡片 8px；开关 44×22px；分享链接使用 12.5px 等宽字体。完整来源为 [P0.2](../../../../../docs/evidence/base-ui-migration/p0.2/README.md) 和 [P1.1 证据](../../../../../docs/evidence/base-ui-migration/p1.1/README.md)。

## 新旧组件共存

AntD `ConfigProvider` / `AntApp`、`theme.ts` 算法和 reset 保留到 P6。当前 AntD 是 6.6.5，无需 v5 React 19 patch。新控件直接继承根 CSS 变量，body portal 同样继承 html 主题，不需要复制主题 class。

保持现有页面层叠关系；不要直接给整个 `#root` 添加 `isolation`（会改变旧 toast/portal 的关系）。Foundation 的历史样例只验证一个嵌套方向；P2.1 的真实公共弹层及双向组合按上节约定使用。尚未迁移的其它浮层由后续批次按实际组合验证，不能把这些组合推广为全站均已兼容。

## 菜单、浮层与选择控件

P2.2 提供 `Menu`、`Popover`、`Tooltip`、`Select`、`Combobox` 和 `MultiSelect`。业务从具体文件导入；Base UI 的部件和事件类型不外泄。共同的 `open/onOpenChange` 可受控，也可省略；`side/align`、`popupClassName/popupStyle` 是公开定位/外观入口。默认 portal 归属当前 OverlayScope；在旧 Modal/Drawer 正文中包一层 Scope，沿用 P2.1 的共存约定。

- `Menu` 接收可承接 ref 的按钮 `trigger` 和 `items`。动作含 key/label/icon、disabled/danger/selected/onSelect；separator/group/children 覆盖现有分隔、分组与子菜单；分组内的项左右各缩进 8px，同被替换菜单（P4.3a）。`checked/onCheckedChange` 提供 checkbox 语义，默认选中后保持打开；普通动作默认关闭，`closeOnSelect` 可覆盖。复杂 label 可给 `textValue` 支持文字导航。动作的 `className`（P5.1）加在菜单项自身上，供页面单独设样式的行（账号菜单的资料行）。`footer`（P5.1）是菜单项之下、方向键与 typeahead 导航之外的内容（合并目标菜单的分支搜索）：菜单项在自己的盒里滚动，footer 固定在下方；在 footer 里按的键归它自己（Base UI 的 typeahead 会把输入的字母当作跳到对应项），只有 Esc 与 Tab 照常关闭菜单；没有菜单项时只画 footer。`variant="attachment"` 仅在 <=600px 使用42.4px行高、17px字号、26px圆角。菜单触发器和弹出内容拦截点击冒泡，避免触发行导航。菜单动作打开 Dialog 时给 Dialog `returnFocus` 指向稳定菜单按钮。打开后焦点在菜单内，按 Tab 离开并关闭菜单；这与旧 Dropdown（按 Tab 才进入菜单）不同，是协调者 2026-10-07 判定接受的约定，适用范围与测试依据见 [component-contracts](../../../../../docs/evidence/base-ui-migration/component-contracts.md)「Menu 打开后的焦点与 Tab」。触发器上的 ↑/↓ 默认打开菜单；`openOnArrowKeys={false}` 时，菜单关闭期间把这两个键留给页面（同被替换 Dropdown 的触发器，它没有方向键），Enter、Space 与点击照常打开，打开后的方向键仍归菜单：任务页的列表标题用它，选完列表后焦点留在标题上，↑/↓ 仍逐行移动任务（P4.3a）。
- `Popover` 用 `trigger/title/children`；无标题传 null。默认点击打开，可设 `openOnHover`；`initialFocus/returnFocus` 遵循弹层约定。内容内可直接放 Select/Combobox，Esc 逐层关闭。`pointAtCenter`（P4.4）：同被替换 Popover 的 `arrow.pointAtCenter`，在触发器上方或下方、与一边对齐时，浮层移到箭头（距对齐边 12px，宽 16px）指向触发器中心的位置，即对齐边在中心前或后 20px；越界翻到另一边时同 rc-trigger 从触发器的近角量起，新的对齐边在触发器原对齐一侧的边缘外 20px；不沿触发器滑动，避让留白为 0（rc-trigger 按可视区判断翻转）。Wiki 的脚注卡片用它：小小的脚注编号上，箭头仍指着编号。`arrow={false}`（P5.1）：不画箭头，与触发器的间距是 4px 而不是 12px，同被替换的无箭头 Popover（新会话的引擎列表）。`collisionPadding`（P5.1，默认 8）：滑回视口时与视口边缘保留的距离；被替换浮层用 `align.overflow.shiftX` 贴边滑回的，传 0（手机上的 Plan usage 浮层）。`Tooltip` 用 `children/content`，保留触发器原有 aria-describedby；disabled 原生按钮需用可聚焦 span 包裹，让提示可由键盘获得。`toggleOnClick`（P4.4）：按下触发器时打开关闭着的提示、关闭打开着的提示，同被替换提示的 click 触发，悬停与聚焦照常打开；Wiki 文档里被标记句子的说明带链接，触屏读者按句子打开它。默认按下只关闭打开着的提示（Base UI 的 closeOnClick）。
- `Select` 与 `Combobox` 共用字符串 `value | null`、`options` 和 `onValueChange`。空字符串是有效选择（账号 Automatic）；null 表示未选择/显式清除。options 为 `{value,label,disabled?,title?}` 或 `{label,options}` 分组（`title`，P4.3a：可检索列表中选项的原生悬停提示）；label 为搜索/无障碍文本，复杂展示使用 `renderOption/renderValue`。支持 small/middle、outlined/borderless、disabled/loading、placeholder/clearable、emptyContent、showArrow 和 matchTriggerWidth。
- 需要文本检索时使用 `Combobox`；默认按 label 忽略大小写匹配。修改查询和 Esc 不清掉已选值；显式清除才回调 null。远端搜索设置 `filter={false}` 与 `onSearch`，由业务处理请求/过期响应；`value={null}` 可用于选择后重置的动作入口。已选标签通过 aria-describedby 暴露给辅助技术。ref 分别指向 Select 按钮和 Combobox 输入框，name 支持原生表单值。

P3.2 试点据真实页面补齐：Select 家族根类名为 `.orbit-select`（原 `.orbit-choice` 与 Checkbox/Radio 的标签类同名，两份样式同时加载时互相套用边框与内边距）；loading 时在箭头位置显示旋转弧形图标，可搜索的 Combobox 打开时显示放大镜，与被替换的选择器一致；Combobox 的占位文字画在输入框旁（按文字宽度裁切），输入框在 ≤960px 提为 16px 时占位仍保持字段字号；Select 只在值真正改变时回调 `onValueChange`，重选当前项只关闭列表。没有选项持有 value（null 或不在选项中）时，用指针打开即高亮第一个可用选项，Enter 选它（被替换选择器的 defaultActiveFirstOption）；键盘打开沿用 Base UI：↓/Enter/Space 在第一项，↑ 在最后一项（`Select.test.tsx` 锁定）；有值时高亮当前值。

Combobox 的值、占位与搜索输入框放在同一个行盒 `.orbit-combobox-field` 中（与被替换选择器的 content 盒相同）：行高来自隐藏的不换行空格，同时给控件提供文字基线；输入框由 inset 撑满而非百分比高度（后者使输入文字低1px）；打开且有值时整个行盒（含业务的悬停底色）一起淡化到 .25。未选值时打开即高亮第一项，Enter 选它（旧选择器的 defaultActiveFirstOption）。

浮层位置按被替换的 rc-trigger 计算：其每个 inset 向下取整（顶/左边缘 floor(锚点边+间距)，以底/右边缘定位的——在锚点上方/左侧或与锚点末端对齐——取对应 ceil），Floating UI 则四舍五入，小数部分≥.5 时会差1px，`useWholePixelOffsets` 用 Base UI 公开的 sideOffset/alignOffset 函数补齐。Menu、Select、Combobox、MultiSelect 的列表另用 `useDropdownPlacement`：与触发器起/止边对齐，超出视口时若另一边能显示更多则改对另一边，不沿触发器平移，并收窄到对齐一侧的剩余宽度（`--orbit-dropdown-room`）；与 rc-trigger 先按不受限宽度测量一样，列表在第一次越界前保持自然宽度，由那次越界决定本次打开的对齐边；`align="center"` 的菜单仍用 Base UI 平移。Tooltip、Popover、Popconfirm 越界时按各自避让留白滑回视口后再向下取整，箭头指向旧组件所指之处（未取整位置下所覆盖锚点段的中点，`--orbit-arrow-nudge`）。Popconfirm 与旧确认浮层一样贴视口边缘（无避让留白），最宽 100vw。与末端对齐的列表由旧组件的 right 定位，左缘保留列表宽度的小数部分；Base UI 取整后的余数以相对定位交还（`--orbit-dropdown-subpixel`），不改变定位层尺寸。

浮层都放在页面坐标里，与旧组件挂在 body 上一样（`useFloating` 统一决定，各浮层的 Positioner 传 `positionMethod`）：挂进弹层（Dialog/Drawer/ConfirmDialog、Popover 内容、旧 Modal 里的 OverlayScope）的用 `fixed`，挂在 body 的保持 `absolute`（本身就是页面坐标，随页面滚动原生移动）。原因是 Base UI 在还没定位的浮层处于 `position: fixed` 时测量，再按指定方式套用第一次结果；挂进弹层的 `absolute` 浮层以弹层盒为定位参照，第一次定位会偏一个弹层原点，到下一次测量才回位。实际绘制的帧在下一次测量之后，但这一帧的 requestAnimationFrame 回调（Base UI 移动焦点、测量）读到的是偏移的位置；`fixed` 下从第一次起就在最终位置，也不被弹层宽度限制。逐帧检查是 `choices-first-frame.browser.mjs`，证据见 [overlay-first-frame](../../../../../docs/evidence/base-ui-migration/overlay-first-frame/README.md)。

`MultiSelect` 使用字符串数组 value/onValueChange；选项正文同被替换选项一样伸到选项内边距为止，已选项伸到 14px 的勾为止（P4.3a，`renderOption` 两端对齐的内容如标签名与计数因此与旧列表同位）；搜索选项后保持列表打开，支持逐项移除、全清、分组和 maxTagCount。与被替换的多选一样，`mode="multiple"` 打开即高亮第一项（Enter 选它），打开期间箭头换成放大镜。`mode="tags"`、`open={false}`、`searchValue/onSearch`、`tokenSeparators={[',', ' ']}` 对应现有邮件输入：Enter 或失焦提交尾项，输入法组合期间不提交，值去重；格式校验和分享请求仍由业务负责。Backspace 删除数组末项，即使它在折叠计数内。

正常动效沿用旧实测：根菜单/选择列表200ms纵向展开，子菜单/Popover 200ms缩放，Tooltip 100ms缩放；入场/退场缓动与方向原点分别匹配旧组件。通过 Base UI 公开 data-open/data-closed/data-side/data-align/data-nested 设置 CSS 动画，由其生命周期等待退场完成，退场面不接收指针。入场结束不保留 transform，避免改变嵌套 portal 的定位参照。减少动态效果时与 P2.1 一样禁用缩放/渐隐。手机附件菜单除任务指定字号外保持旧实测布局：5px/12px行padding、4px行圆角、原分隔线、图标x=12px、总高240.953125px（本例5行）。

样式只使用 Orbit 类名、自己的属性与 Base UI 公开的 data-selected/data-highlighted/data-disabled 等状态；不查询或覆盖 AntD DOM。箭头与空态 SVG 沿用原 MIT 许可图形，保留许可。详见 [P2.2 证据](../../../../../docs/evidence/base-ui-migration/p2.2/README.md)，其中明示原手机14px覆盖缺陷与任务要求17px的差异，以及旧 Modal 最后一次 Tab 的宿主缺陷。

## 自动增高 Textarea 与会话输入

P3.1 把自动增高、手动高度和 DOM 访问收进 `Textarea`，业务不再经由 AntD 字段的内部 ref 取 textarea。ref 直接是原生 textarea：`focus()`、`setSelectionRange()`、`selectionStart`、`scrollHeight/clientHeight/offsetHeight` 都按 DOM 原义使用，组件不暴露其它句柄。

- `autoSize` 按受控 `value` 测量（现有调用都是受控值）：值或行数界限变化时在绘制前测量，字段宽度变化时下一帧重测。测量沿用被替换字段的离屏副本算法与样式清单，空值按 placeholder 计高，超过 `maxRows` 后改为滚动；结果写入 height/min-height/max-height/overflow-y/resize，并覆盖调用方 style 中的同名项。placeholder 变化本身不触发重测，与旧字段相同。
- 手动高度：调用方在用户拖动后传 `autoSize={false}` 和 `style={{ height }}`，双击复位时恢复 `autoSize`。拖动起点读 ref 的 `offsetHeight`，到顶判断读 `scrollHeight > clientHeight + 1`（下一帧读取，测量已在绘制前完成）。
- `variant="borderless"` 对应会话输入框：无边框/底色/焦点阴影，上下 padding 补回 1px 边框；`:focus-visible` 时只过渡 outline，输入中增高即时完成。默认外观的 textarea 与旧字段一样以 0.3s 过渡全部属性（包括自动增高的高度）；`prefers-reduced-motion: reduce` 时与其它 Orbit 文本控件一样不过渡。
- 会话输入框的共享度量仍在 index.css 的 `.composer-field` 区块，`textarea.orbit-textarea` 与旧选择器共用同一组声明，镜像和输入框只能一起改。任务评论框的 `.tdp-compose` 同样让 `.orbit-textarea` 取得 `flex: 1`。P3.2/P5.3 切换调用后删除对应 `.ant-input` 选择器。
- 键位、菜单、粘贴、历史和发送逻辑留在业务组件；Textarea 透传原生事件（含 `nativeEvent.isComposing`），不改写 onChange 的 target。

```tsx
const field = useRef<HTMLTextAreaElement>(null);
<Textarea ref={field} variant="borderless" value={text} onChange={(event) => setText(event.target.value)}
  autoSize={height == null ? { minRows: 1, maxRows: 12 } : false} style={height == null ? undefined : { height }} />
// 选中 @ 提及后恢复光标：
field.current?.focus();
field.current?.setSelectionRange(position, position);
```

`ui-migration/composer.html` 用真实 CSS、ComposerMirror 和输入框辅助函数复现 WorkspaceView 会话输入与 TaskDetailPanel 评论框，同一脚本分别驱动旧 AntD 字段和 Orbit Textarea。`npm run test:ui-composer -w @orbit/web` 比较几何、计算样式、截图像素、镜像字形对齐、附件对齐、手动高度、断点、过渡，以及中文组合输入、Enter/Shift+Enter、⌘/Ctrl+Enter、候选菜单、粘贴、长度上限和历史回溯。Chromium 用 DevTools 真实组合输入；WebKit 无输入法自动化，以 insertText 加组合事件/keyCode 229 重放，不代表真机输入法或软键盘。详见 [P3.1 证据](../../../../../docs/evidence/base-ui-migration/p3.1/README.md)。

## 图片与预览（P5.2）

`ImagePreview`（`ImagePreview.tsx` + `.css`）和 `Image`（`Image.tsx` + `.css`）替代 AntD `Image.PreviewGroup` 与 `Image`。

- `ImagePreview`：受控的全屏看图层。props 有 `open`、`onClose`（关闭键、Esc、按遮罩时调用；按图片本身不关闭）、`items`（`{ src, alt }`）、`current` 与 `onCurrentChange`。`group` 表示一组可翻页的图片：图片下方显示“n / 总数”；多于一张时两侧有上一张/下一张按钮，并响应 ←/→，到两端即停。`origin` 是打开时放大的起点（视口坐标，即按下的缩略图中心）。
- 外观同被替换预览：45% 黑遮罩，图片最大为窗口宽度和 70% 高度。右上角的关闭键和两侧的切换键都是 42px 圆键，距边 12px，10% 黑底，悬停时 20%。距底部 32px 处，是 65% 白的位置文字，下面是一排 42px 按钮组成的胶囊：上下翻转、左右翻转、左转、右转、缩小、放大。
- 缩放（按钮、滚轮、双击）、拖动、双指缩放与拖动、松开后的回弹，都沿用被替换预览的算法（rc-image，MIT，见 `rc-image.LICENSE`）：每次缩放 1.5 倍，范围 1–50 倍。翻页时新图以原尺寸立即出现。
- 基于 Base UI Dialog，模态焦点、Esc、文档滚动锁与弹层层级沿用本目录约定：顶层 z-index 为 1080（被替换预览的 1000+80），在 Orbit 弹层内按层递增。打开时焦点在关闭键（同被替换预览），关闭后回到打开前的位置。打开期间登记为通知的挂载层。
- 可访问名称：按钮依次为 Close、Previous image、Next image、Flip vertically、Flip horizontally、Rotate left、Rotate right、Zoom out、Zoom in（被替换预览用的是图标名与 `flipY` 这类内部名）。对话框以当前图片的 alt 命名，没有 alt 时为 Image preview。
- 减少动态效果时，打开/关闭的渐显与放大、缩放旋转的过渡和按钮的过渡都不播放。
- `Image`：按下即单独打开预览的一张图片。props 有 `src`、`alt`、`className`（加在 `<img>` 上，尺寸由调用方的类决定）和 `cover`（悬停或键盘聚焦时叠在图上的内容，30% 黑底白字）。外层 `.orbit-image` 是行内块，`role=button`，可 Tab 聚焦，以 alt 命名，Enter/Space 打开。内层 `<img>` 带 `.orbit-image-img`，默认宽度 100%、高度自动，同被替换组件；规则 `.orbit-image .orbit-image-img` 的权重高于调用方的单个类。业务样式通过 `.orbit-image`、`.orbit-image-cover` 调整外层，如 `.md .orbit-image`、`.chat-images .orbit-image`、`.composer-attach .orbit-image`。
- 授权图片的获取和对象 URL 的生命周期仍归业务侧（Transcript 的 `ResolvedAttachmentImage`、`LocalArtifactImage`）：拿到对象 URL 后再交给这两个组件。预览本身不持有、也不撤销对象 URL。

```tsx
// 一组：调用方冻结点击那一刻的列表，并持有当前序号（Transcript 的 ImagePreviewProvider）。
<ImagePreview group open={open} items={items} current={current} onCurrentChange={setCurrent} onClose={() => setOpen(false)} />
// 单张：会话输入框里的附件缩略图（P5.3 切换 WorkspaceView 时用法相同）。
<Image className="composer-attach-thumb" src={objectUrl} alt="" cover={<EyeOutlined className="composer-attach-eye" />} />
```

真实页面的对照见 [P5.2 证据](../../../../../docs/evidence/base-ui-migration/p5.2/README.md)。

## 验证入口

从仓库根执行：

```sh
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts
node node_modules/typescript/bin/tsc -p src/web/ui-migration/foundation.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/controls.tsconfig.json --noEmit
npm run test:ui-controls -w @orbit/web
npm run test:ui-overlays -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/overlays.tsconfig.json --noEmit
npm run test:ui-choices -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/choices.tsconfig.json --noEmit
npm run test:ui-composer -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/composer.tsconfig.json --noEmit
npm run test:ui-foundation -w @orbit/web
npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web
```

Foundation 使用独立 Vite 开发入口，运行 Chromium/WebKit × light/dark × desktop/phone；P0 回归使用正式生产构建。两者都校验 P0 固定浏览器/OS/字体环境。新样例截图作为运行附件保存；旧页面仍按原 252 张截图零像素差异比较，不覆盖基线。主题首屏检查暂停真实 main.tsx 加载，观察原 HTML boot 再放行应用；账号接口采用合成 fixture，不代表真实服务端跨设备验证。

Controls 使用相同环境矩阵；检查尺寸、字体、颜色、轮廓、图标与文本对齐、选择标记、hover/focus、键盘/标签/表单值及 disabled/loading。固定样例直接展示实际组件，测量附件与真实 PNG 见 [P1.2 证据](../../../../../docs/evidence/base-ui-migration/p1.2/README.md)。普通 input/textarea 按原 CSS 在 ≤960px 使用 16px（P3.1 修正了此前误用的 600px 断点），带前后缀输入保持实测 14px；focus 优先于 hover。这不代表已验证真机软键盘。
