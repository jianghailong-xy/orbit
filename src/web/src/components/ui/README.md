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
| `Button` | `variant="default/primary/text/link"`，`size="small/middle/large"`，`danger`、`icon`、`loading`；其余为原生 button 属性，**`type` 是 button/submit/reset**，默认 button。ref 为 HTMLButtonElement。纯图标必须给可访问名称。loading 阻止再次激活，保留焦点并暴露 aria-busy；disabled 按原生规则退出 Tab 顺序。 |
| `LinkButton`（同 Button 文件） | 同一外观的原生 anchor，使用 href/target/rel/download 等原生属性和 HTMLAnchorElement ref；链接与操作按钮分别保持导航和提交语义。 |
| `Input` | 原生 input 属性/ref，`size="small/middle/large"`、`invalid`、`prefix/suffix`。有装饰时 className/style 指向外壳，其他原生属性与 ref 仍指向 input；装饰区点击聚焦。标签和错误说明由调用方使用 label/aria-describedby 关联。 |
| `Textarea` | 原生 textarea 属性，ref 即 HTMLTextAreaElement；`invalid`、rows、`variant="outlined/borderless"`、`autoSize`（`true` 或 `{minRows,maxRows}`）。保留选区、输入与拖拽调整尺寸；自动增高与会话输入约定见下文。 |
| `Checkbox` | 必填 checked，onCheckedChange(boolean)、indeterminate、disabled、invalid；支持 name/value/form 和原生 input ref。文字作为 children，点击标签与 Space 切换。 |
| `Radio` / `RadioGroup` | 组提供必填 value、onValueChange(value)、name、disabled；子项提供 value/children/disabled。组使用 aria-label 或 aria-labelledby 命名；箭头键跳过禁用项。variant="default/button"，size="small/middle"。 |
| `Switch` | 必填 checked、onCheckedChange(boolean)，size="small/middle"、disabled、loading；使用 aria-label 或 aria-labelledby 命名，支持 name/value/form 和原生 input ref。 |
| `Badge` | 原生 span 状态标签（替代 Tag），tone="default/info/success/warning/error/blue"、icon、children。使用可读文字表达状态。 |
| `Spinner` | 原生 span，size="small/middle"（14/20px），role=status、默认 aria-label="Loading"；嵌入已有加载状态时可设 aria-hidden，避免重复播报。 |
| `Avatar` | 原生 span 的圆形首字头像：`size`（px，默认 32）与文字 children，颜色/字号由调用方 style 给出。1px 透明边框、内容居中、行高为字号的 1.5714 倍。只覆盖当前在用的文字头像，不含图片与加载失败回退。 |
| `Alert` | role=alert 的状态块：`type="error"`（目前唯一在用的语气）、`title`、`description`。带说明时 20px/24px 内边距、8px 圆角、24px 图标、16px 标题。 |
| `Segmented` | radiogroup 分段切换：受控 `value`/`onValueChange`、`options`（value/label/disabled）、aria-label。只有任务面板在用的紧凑尺寸（2px 轨道、20px 项、7px 文字内边距）。切换时选中块从旧项滑到新项（0.3s），减少动态效果时直接切换；方向键在项间移动并选中，选中项是唯一的 Tab 停留点。 |

Button、Checkbox、Radio、Switch 的交互封装 Base UI；文本输入与标签/加载图形使用原生语义。Checkbox/Radio/Switch 的值由业务持有，公共 API 不提供 defaultChecked/defaultValue；需要 reset 的表单由父级重置受控值。Checkbox/Radio 的 className/style 指向标签，其他 DOM 属性指向可聚焦控件，input ref 的 focus 由 Base UI 转交可访问控件。不要读取隐藏 input 或第三方 DOM 结构。

```tsx
<Button variant="primary" type="submit" loading={saving}>Save</Button>
<label>Title<Input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
<Checkbox checked={includeTasks} onCheckedChange={setIncludeTasks}>Include tasks</Checkbox>
```

组件自行导入局部样式，基础变量由应用入口统一加载。不要把原 AntD type="primary" 或内部 ref 直接带到新组件；按上述语义改写调用。业务布局的手机 40px 按钮、等宽字体等例外随页面迁移保留，不能仅靠切换 import 完成迁移。

## Dialog、Drawer 和异步确认

业务分别导入 `ui/Dialog`、`ui/Drawer`、`ui/ConfirmDialog`；`OverlaySurface` 是三者共享的实现，不是业务调用入口。全部要求受控 `open` 和可访问 `title`，正文为 children，简单说明可用 description（自动关联 aria-describedby）。

- Dialog：`onClose` 是关闭请求，业务更新 open；默认宽度520px、顶部100px，<=767px时保留旧弹窗108px顶部和8px边距，最大宽度适应视口。footer 完全由调用方提供，原生表单使用 Button 的 type/form 属性。默认无自动 OK/Cancel。
- Drawer：相同关闭和焦点约定，`placement="right"`（默认）或 `"bottom"`；width/height 支持 CSS 尺寸，默认378px，底部可用 height="auto"。headerActions 放置已有最大化等动作。复用 Base Dialog，因为现有 Drawer 没有滑动关闭或吸附点；不新增手势。
- 默认支持 Esc、单击/单指轻点遮罩和 Close 按钮；内部按下、外部释放不关闭。`closeOnEscape`、`closeOnOutsideClick`、`closable` 分别控制三种关闭方式。busy 阻止关闭请求并禁用 Close；调用方负责自己的提交按钮。隐藏 Close 时应提供可访问的退出按钮。
- 默认聚焦弹层容器，避免手机打开时自动弹出软键盘；initialFocus 可指定原生 ref。默认返回先前焦点；从菜单、触摸入口或会卸载的节点打开时，传 `returnFocus` 指向稳定的触发按钮。不能通过读取第三方 DOM 找触发器。
- 默认关闭后卸载正文；`keepMounted` 适用于需保留未提交表单值的场景，关闭时隐藏且退出可访问树。业务页面迁移时明确选择其现有生命周期。
- ConfirmDialog：`onConfirm` 返回 Promise 时自动 pending，成功调用 `onClose(true)`；取消/Esc 调用 `onClose(false)`；遮罩不关闭。默认聚焦 Cancel。提交期间按钮/取消/Esc均被锁住，同一事件轮内的重复提交也会被阻止。throw/reject 会保留弹窗，以 role=alert 显示错误并恢复重试/取消；业务已经有 toast 时仍由业务保留。必须返回 mutateAsync/请求 Promise，不能用返回 void 的 mutate 冒充可等待提交。

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

通知继续使用 `useToast` / `toastFeed` / `toastStore` 和唯一的 `ToastViewport`。打开的 Orbit 弹层通过自有 ref 登记反馈挂载点，最上层接收通知，使已有通知与后到通知都留在可访问树和 Tab 范围内；关闭后回到父层或 body，keepMounted 的关闭层不接收通知。React portal 始终使用同一宿主，避免切层重建通知 DOM。宿主使用原生 `popover="manual"` 顶层绘制，逃离弹层的缩放、平移和裁切；不增加遮罩或抢焦点，也不改变原 Dialog/Drawer 动画。通知自身保留首次入场的动画起点，切层以负 delay 延续原进度，不重播或删除入场动画。样式清除 popover 的默认盒模型，保留原通知原点、字体和安全区规则。持久的 body 固定定位测量节点保留 WebKit 的滚动条预留宽度，并随通知视口卸载清理。此能力依赖浏览器的 Popover API，已在本项目固定 Chromium/WebKit 版本验证。

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

`main.tsx` 按 `antd/dist/reset.css` → `index.css` → `ui/foundation.css` 加载。`foundation.css` 只声明变量，不引入 reset、全局 button/input 样式、CSS layer 或新的 stacking context；控件样式限定自己的 `.orbit-*` 类或 CSS module。图标继续使用 `@ant-design/icons`。

行高：Dialog/Drawer 外壳与 Checkbox/Radio/Switch 标签使用无单位的 1.5714（14px 时即 22px），其中字号不同的说明文字按自身字号计算行高，与被替换组件相同。业务样式（index.css）覆盖 Orbit 组件类时，要用组件类限定提高优先级（如 `.share-layer-check.orbit-choice`），因为组件样式在 index.css 之后加载。

颜色优先直接用现有 `--bg-base/raised`、`--text-1/2/3`、`--border`、`--brand` 和状态变量。新增 `--orbit-*` 仅补足控件真实角色；**品牌色与主控件填充不是同一值**：暗色 `--brand=#5b8cff`，主控件实测为 `#2e62dc`，hover 为 `#5585e8`。禁用色和焦点轮廓也来自计算样式，不能从 seed 推测。

`--orbit-border-split` 保留旧 Drawer 的半透明分隔线计算值：light 为 `rgba(17, 42, 80, 0.08)`，dark 为 `rgba(223, 223, 226, 0.05)`。标题底边和 footer 顶边均为1px solid；透明色在 elevated 表面上的合成结果也纳入真实截图对照。

基础尺寸为 32px、圆角 6px，文字 14px/22px，按钮水平 padding 15px、gap 8px；小号为 24px/4px/7px，弹窗圆角 10px，菜单圆角 8px。保留以下局部差异，不新增全局手机控件高度规则：任务头部 <=600px 的主按钮与图标按钮 40px，小号 Save schedule 仍是 24px；设置卡片 8px；开关 44×22px；分享链接使用 12.5px 等宽字体。完整来源为 [P0.2](../../../../../docs/evidence/base-ui-migration/p0.2/README.md) 和 [P1.1 证据](../../../../../docs/evidence/base-ui-migration/p1.1/README.md)。

## 新旧组件共存

AntD `ConfigProvider` / `AntApp`、`theme.ts` 算法和 reset 保留到 P6。当前 AntD 是 6.6.5，无需 v5 React 19 patch。新控件直接继承根 CSS 变量，body portal 同样继承 html 主题，不需要复制主题 class。

保持现有页面层叠关系；不要直接给整个 `#root` 添加 `isolation`（会改变旧 toast/portal 的关系）。Foundation 的历史样例只验证一个嵌套方向；P2.1 的真实公共弹层及双向组合按上节约定使用。尚未迁移的其它浮层由后续批次按实际组合验证，不能把这些组合推广为全站均已兼容。

## 菜单、浮层与选择控件

P2.2 提供 `Menu`、`Popover`、`Tooltip`、`Select`、`Combobox` 和 `MultiSelect`。业务从具体文件导入；Base UI 的部件和事件类型不外泄。共同的 `open/onOpenChange` 可受控，也可省略；`side/align`、`popupClassName/popupStyle` 是公开定位/外观入口。默认 portal 归属当前 OverlayScope；在旧 Modal/Drawer 正文中包一层 Scope，沿用 P2.1 的共存约定。

- `Menu` 接收可承接 ref 的按钮 `trigger` 和 `items`。动作含 key/label/icon、disabled/danger/selected/onSelect；separator/group/children 覆盖现有分隔、分组与子菜单。`checked/onCheckedChange` 提供 checkbox 语义，默认选中后保持打开；普通动作默认关闭，`closeOnSelect` 可覆盖。复杂 label 可给 `textValue` 支持文字导航。`variant="attachment"` 仅在 <=600px 使用42.4px行高、17px字号、26px圆角。菜单触发器和弹出内容拦截点击冒泡，避免触发行导航。菜单动作打开 Dialog 时给 Dialog `returnFocus` 指向稳定菜单按钮。
- `Popover` 用 `trigger/title/children`；无标题传 null。默认点击打开，可设 `openOnHover`；`initialFocus/returnFocus` 遵循弹层约定。内容内可直接放 Select/Combobox，Esc 逐层关闭。`Tooltip` 用 `children/content`，保留触发器原有 aria-describedby；disabled 原生按钮需用可聚焦 span 包裹，让提示可由键盘获得。
- `Select` 与 `Combobox` 共用字符串 `value | null`、`options` 和 `onValueChange`。空字符串是有效选择（账号 Automatic）；null 表示未选择/显式清除。options 为 `{value,label,disabled?}` 或 `{label,options}` 分组；label 为搜索/无障碍文本，复杂展示使用 `renderOption/renderValue`。支持 small/middle、outlined/borderless、disabled/loading、placeholder/clearable、emptyContent、showArrow 和 matchTriggerWidth。
- 需要文本检索时使用 `Combobox`；默认按 label 忽略大小写匹配。修改查询和 Esc 不清掉已选值；显式清除才回调 null。远端搜索设置 `filter={false}` 与 `onSearch`，由业务处理请求/过期响应；`value={null}` 可用于选择后重置的动作入口。已选标签通过 aria-describedby 暴露给辅助技术。ref 分别指向 Select 按钮和 Combobox 输入框，name 支持原生表单值。

P3.2 试点据真实页面补齐：Select 家族根类名为 `.orbit-select`（原 `.orbit-choice` 与 Checkbox/Radio 的标签类同名，两份样式同时加载时互相套用边框与内边距）；loading 时在箭头位置显示旋转弧形图标，可搜索的 Combobox 打开时显示放大镜，与被替换的选择器一致；Combobox 的占位文字画在输入框旁（按文字宽度裁切），输入框在 ≤960px 提为 16px 时占位仍保持字段字号；Select 只在值真正改变时回调 `onValueChange`，重选当前项只关闭列表。

Combobox 的值、占位与搜索输入框放在同一个行盒 `.orbit-combobox-field` 中（与被替换选择器的 content 盒相同）：行高来自隐藏的不换行空格，同时给控件提供文字基线；输入框由 inset 撑满而非百分比高度（后者使输入文字低1px）；打开且有值时整个行盒（含业务的悬停底色）一起淡化到 .25。未选值时打开即高亮第一项，Enter 选它（旧选择器的 defaultActiveFirstOption）。

浮层位置按被替换的 rc-trigger 计算：其每个 inset 向下取整（顶/左边缘 floor(锚点边+间距)，以底/右边缘定位的——在锚点上方/左侧或与锚点末端对齐——取对应 ceil），Floating UI 则四舍五入，小数部分≥.5 时会差1px，`useWholePixelOffsets` 用 Base UI 公开的 sideOffset/alignOffset 函数补齐。Menu、Select、Combobox、MultiSelect 的列表另用 `useDropdownPlacement`：与触发器起/止边对齐，超出视口时若另一边能显示更多则改对另一边，不沿触发器平移，并收窄到对齐一侧的剩余宽度（`--orbit-dropdown-room`）；与 rc-trigger 先按不受限宽度测量一样，列表在第一次越界前保持自然宽度，由那次越界决定本次打开的对齐边；`align="center"` 的菜单仍用 Base UI 平移。Tooltip、Popover、Popconfirm 越界时按各自避让留白滑回视口后再向下取整，箭头指向旧组件所指之处（未取整位置下所覆盖锚点段的中点，`--orbit-arrow-nudge`）。Popconfirm 与旧确认浮层一样贴视口边缘（无避让留白），最宽 100vw。与末端对齐的列表由旧组件的 right 定位，左缘保留列表宽度的小数部分；Base UI 取整后的余数以相对定位交还（`--orbit-dropdown-subpixel`），不改变定位层尺寸。

`MultiSelect` 使用字符串数组 value/onValueChange；搜索选项后保持列表打开，支持逐项移除、全清、分组和 maxTagCount。`mode="tags"`、`open={false}`、`searchValue/onSearch`、`tokenSeparators={[',', ' ']}` 对应现有邮件输入：Enter 或失焦提交尾项，输入法组合期间不提交，值去重；格式校验和分享请求仍由业务负责。Backspace 删除数组末项，即使它在折叠计数内。

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
