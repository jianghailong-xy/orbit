# Orbit 公共组件基础

本目录是 Base UI 与业务之间的唯一实现边界。P1.1 接入依赖与主题，P1.2 提供基础控件，P2.1 提供 Dialog/Drawer/ConfirmDialog。公共 API 按实际调用需求定义，不导出私有验证样例。

## 导入与公共 API

- 业务按组件导入 `components/ui/<Component>`；组件内部按需导入 `@base-ui/react/<component>`，不把 Base UI 的 Root/Portal/状态对象直接重导出给业务。
- 公共 props 只覆盖当前业务需要；优先原生 DOM 属性、可访问名称与原生 ref。不要复制 AntD 全部 props，不读取第三方内部 class/DOM。
- `__fixtures__` 仅供 `ui-migration/foundation.html`、`controls.html` 和 `overlays.html` 使用，没有业务路由、生产入口或公共导出。Foundation 的临时按钮/弹窗仍为私有；Controls/Overlays 使用真实公共组件与旧控件对照。
- `boundary.test.ts` 检查实际源码的导入、重导出、动态导入及类型引用：Base UI 只能在本目录内；业务不能引用私有 fixture；公共 ui 不能依赖 antd。共存 fixture 中的 AntD 对照在 P6 删除。

## 基础控件

| 导入 | 最小约定 |
| --- | --- |
| `Button` | `variant="default/primary/text/link"`，`size="small/middle/large"`，`danger`、`icon`、`loading`；其余为原生 button 属性，**`type` 是 button/submit/reset**，默认 button。ref 为 HTMLButtonElement。纯图标必须给可访问名称。loading 阻止再次激活，保留焦点并暴露 aria-busy；disabled 按原生规则退出 Tab 顺序。 |
| `LinkButton`（同 Button 文件） | 同一外观的原生 anchor，使用 href/target/rel/download 等原生属性和 HTMLAnchorElement ref；链接与操作按钮分别保持导航和提交语义。 |
| `Input` | 原生 input 属性/ref，`size="small/middle/large"`、`invalid`、`prefix/suffix`。有装饰时 className/style 指向外壳，其他原生属性与 ref 仍指向 input；装饰区点击聚焦。标签和错误说明由调用方使用 label/aria-describedby 关联。 |
| `Textarea` | 原生 textarea 属性/ref、`invalid`、rows。保留选区、输入与拖拽调整尺寸；自动增高和会话输入行为由 P3.1 实现。 |
| `Checkbox` | 必填 checked，onCheckedChange(boolean)、indeterminate、disabled、invalid；支持 name/value/form 和原生 input ref。文字作为 children，点击标签与 Space 切换。 |
| `Radio` / `RadioGroup` | 组提供必填 value、onValueChange(value)、name、disabled；子项提供 value/children/disabled。组使用 aria-label 或 aria-labelledby 命名；箭头键跳过禁用项。variant="default/button"，size="small/middle"。 |
| `Switch` | 必填 checked、onCheckedChange(boolean)，size="small/middle"、disabled、loading；使用 aria-label 或 aria-labelledby 命名，支持 name/value/form 和原生 input ref。 |
| `Badge` | 原生 span 状态标签（替代 Tag），tone="default/info/success/warning/error/blue"、icon、children。使用可读文字表达状态。 |
| `Spinner` | 原生 span，size="small/middle"（14/20px），role=status、默认 aria-label="Loading"；嵌入已有加载状态时可设 aria-hidden，避免重复播报。 |

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

通知继续使用 `useToast` / `toastFeed` / `toastStore` 和唯一的 `ToastViewport`。打开的 Orbit 弹层通过自有 ref 登记反馈挂载点，最上层接收通知，使已有通知与后到通知都留在可访问树和 Tab 范围内；关闭后回到父层或 body，keepMounted 的关闭层不接收通知。通知不会因移动挂载点而重建队列或重置计时。通知容器保留原 body 字体规则；弹层内用 body 下不可见的固定定位测量节点保持原布局视口宽度，避免 WebKit 抽屉中丢失滚动条预留宽度。测量节点随弹层关闭清理，不读取库的内部 DOM。短通知仍穿透点击，通知动作不关闭拥有它的弹层。

通知行为与集成矩阵：`npm run test:ui-toasts -w @orbit/web`；固定端口14377，沿用 P0 浏览器/字体环境。正常动画检查针对完成入场/退场后的几何；可访问检查证明 live region 的优先级、内容和可见性，不代替真实读屏软件听测。P0 生产通知链路的单独复跑为 `npm run test:ui-migration -w @orbit/web -- feedback-production.browser.mjs`，原 P0 截图断言保持不变。

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

颜色优先直接用现有 `--bg-base/raised`、`--text-1/2/3`、`--border`、`--brand` 和状态变量。新增 `--orbit-*` 仅补足控件真实角色；**品牌色与主控件填充不是同一值**：暗色 `--brand=#5b8cff`，主控件实测为 `#2e62dc`，hover 为 `#5585e8`。禁用色和焦点轮廓也来自计算样式，不能从 seed 推测。

`--orbit-border-split` 保留旧 Drawer 的半透明分隔线计算值：light 为 `rgba(17, 42, 80, 0.08)`，dark 为 `rgba(223, 223, 226, 0.05)`。标题底边和 footer 顶边均为1px solid；透明色在 elevated 表面上的合成结果也纳入真实截图对照。

基础尺寸为 32px、圆角 6px，文字 14px/22px，按钮水平 padding 15px、gap 8px；小号为 24px/4px/7px，弹窗圆角 10px，菜单圆角 8px。保留以下局部差异，不新增全局手机控件高度规则：任务头部 <=600px 的主按钮与图标按钮 40px，小号 Save schedule 仍是 24px；设置卡片 8px；开关 44×22px；分享链接使用 12.5px 等宽字体。完整来源为 [P0.2](../../../../../docs/evidence/base-ui-migration/p0.2/README.md) 和 [P1.1 证据](../../../../../docs/evidence/base-ui-migration/p1.1/README.md)。

## 新旧组件共存

AntD `ConfigProvider` / `AntApp`、`theme.ts` 算法和 reset 保留到 P6。当前 AntD 是 6.6.5，无需 v5 React 19 patch。新控件直接继承根 CSS 变量，body portal 同样继承 html 主题，不需要复制主题 class。

保持现有页面层叠关系；不要直接给整个 `#root` 添加 `isolation`（会改变旧 toast/portal 的关系）。Foundation 的历史样例只验证一个嵌套方向；P2.1 的真实公共弹层及双向组合按上节约定使用。尚未迁移的其它浮层由后续批次按实际组合验证，不能把这些组合推广为全站均已兼容。

## 验证入口

从仓库根执行：

```sh
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts
node node_modules/typescript/bin/tsc -p src/web/ui-migration/foundation.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/controls.tsconfig.json --noEmit
npm run test:ui-controls -w @orbit/web
npm run test:ui-overlays -w @orbit/web
node node_modules/typescript/bin/tsc -p src/web/ui-migration/overlays.tsconfig.json --noEmit
npm run test:ui-foundation -w @orbit/web
npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web
```

Foundation 使用独立 Vite 开发入口，运行 Chromium/WebKit × light/dark × desktop/phone；P0 回归使用正式生产构建。两者都校验 P0 固定浏览器/OS/字体环境。新样例截图作为运行附件保存；旧页面仍按原 252 张截图零像素差异比较，不覆盖基线。主题首屏检查暂停真实 main.tsx 加载，观察原 HTML boot 再放行应用；账号接口采用合成 fixture，不代表真实服务端跨设备验证。

Controls 使用相同环境矩阵；检查尺寸、字体、颜色、轮廓、图标与文本对齐、选择标记、hover/focus、键盘/标签/表单值及 disabled/loading。固定样例直接展示实际组件，测量附件与真实 PNG 见 [P1.2 证据](../../../../../docs/evidence/base-ui-migration/p1.2/README.md)。当前手机普通 input/textarea 按原 CSS 使用 16px，带前后缀输入保持实测 14px；这不代表已验证真机软键盘或自动增高。
