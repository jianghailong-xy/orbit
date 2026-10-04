# Orbit 公共组件基础

本目录是 Base UI 与业务之间的唯一实现边界。P1.1 接入依赖与主题，P1.2 提供下列基础控件；Dialog 等由 P2 实现。公共 API 按实际调用需求定义，不导出私有验证样例。

## 导入与公共 API

- 业务按组件导入 `components/ui/<Component>`；组件内部按需导入 `@base-ui/react/<component>`，不把 Base UI 的 Root/Portal/状态对象直接重导出给业务。
- 公共 props 只覆盖当前业务需要；优先原生 DOM 属性、可访问名称与原生 ref。不要复制 AntD 全部 props，不读取第三方内部 class/DOM。
- `__fixtures__` 仅供 `ui-migration/foundation.html` 和 `controls.html` 使用，没有业务路由、生产入口或公共导出。Foundation 的临时按钮/弹窗仍为私有；Controls 使用真实公共组件与旧控件并排对照。
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

## 主题和样式

复用 `lib/theme.tsx` 的 `ThemeProvider` / `useThemeMode`。唯一主题状态仍是 `system/light/dark`，解析结果写到 `<html data-theme>`；账号偏好为来源，localStorage 为首屏缓存。保留 `index.html` 的同步首屏脚本、theme-color 和原有 boot 样式。不创建第二套主题状态或把 Provider 包在每个控件外。

`main.tsx` 按 `antd/dist/reset.css` → `index.css` → `ui/foundation.css` 加载。`foundation.css` 只声明变量，不引入 reset、全局 button/input 样式、CSS layer 或新的 stacking context；控件样式限定自己的 `.orbit-*` 类或 CSS module。图标继续使用 `@ant-design/icons`。

颜色优先直接用现有 `--bg-base/raised`、`--text-1/2/3`、`--border`、`--brand` 和状态变量。新增 `--orbit-*` 仅补足控件真实角色；**品牌色与主控件填充不是同一值**：暗色 `--brand=#5b8cff`，主控件实测为 `#2e62dc`，hover 为 `#5585e8`。禁用色和焦点轮廓也来自计算样式，不能从 seed 推测。

基础尺寸为 32px、圆角 6px，文字 14px/22px，按钮水平 padding 15px、gap 8px；小号为 24px/4px/7px，弹窗圆角 10px，菜单圆角 8px。保留以下局部差异，不新增全局手机控件高度规则：任务头部 <=600px 的主按钮与图标按钮 40px，小号 Save schedule 仍是 24px；设置卡片 8px；开关 44×22px；分享链接使用 12.5px 等宽字体。完整来源为 [P0.2](../../../../../docs/evidence/base-ui-migration/p0.2/README.md) 和 [P1.1 证据](../../../../../docs/evidence/base-ui-migration/p1.1/README.md)。

## 新旧组件共存

AntD `ConfigProvider` / `AntApp`、`theme.ts` 算法和 reset 保留到 P6。当前 AntD 是 6.6.5，无需 v5 React 19 patch。新控件直接继承根 CSS 变量，body portal 同样继承 html 主题，不需要复制主题 class。

保持现有页面层叠关系；不要直接给整个 `#root` 添加 `isolation`（会改变旧 toast/portal 的关系）。私有 dialog 样例使用当前 modal 层级 1000；现有 toast 为 2050。真正的统一层级、滚动锁、外部关闭和各种嵌套组合在 P2 定义。样例验证 Base dialog 放在 AntD Modal 内时，将 portal 容器留在外层焦点范围中，Tab/Escape/焦点恢复由真实浏览器检查。不能把这一个组合推广为所有新旧弹层都已兼容。

## 验证入口

从仓库根执行：

```sh
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts
node node_modules/typescript/bin/tsc -p src/web/ui-migration/foundation.tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p src/web/ui-migration/controls.tsconfig.json --noEmit
npm run test:ui-controls -w @orbit/web
npm run test:ui-foundation -w @orbit/web
npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web
```

Foundation 使用独立 Vite 开发入口，运行 Chromium/WebKit × light/dark × desktop/phone；P0 回归使用正式生产构建。两者都校验 P0 固定浏览器/OS/字体环境。新样例截图作为运行附件保存；旧页面仍按原 252 张截图零像素差异比较，不覆盖基线。主题首屏检查暂停真实 main.tsx 加载，观察原 HTML boot 再放行应用；账号接口采用合成 fixture，不代表真实服务端跨设备验证。

Controls 使用相同环境矩阵；检查尺寸、字体、颜色、轮廓、图标与文本对齐、选择标记、hover/focus、键盘/标签/表单值及 disabled/loading。固定样例直接展示实际组件，测量附件与真实 PNG 见 [P1.2 证据](../../../../../docs/evidence/base-ui-migration/p1.2/README.md)。当前手机普通 input/textarea 按原 CSS 使用 16px，带前后缀输入保持实测 14px；这不代表已验证真机软键盘或自动增高。
