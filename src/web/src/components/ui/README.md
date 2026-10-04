# Orbit 公共组件基础

本目录是 Base UI 与业务之间的唯一实现边界。P1.1 接入依赖、主题变量和私有验证样例；Button/Input 等公共控件由 P1.2 按实际调用需求实现，Dialog 等由 P2 实现。当前不导出临时样例，也不预设整套兼容 API。

## 导入与公共 API

- 业务按组件导入 `components/ui/<Component>`；组件内部按需导入 `@base-ui/react/<component>`，不把 Base UI 的 Root/Portal/状态对象直接重导出给业务。
- 公共 props 只覆盖当前业务需要；优先原生 DOM 属性、可访问名称与原生 ref。不要复制 AntD 全部 props，不读取第三方内部 class/DOM。
- `__fixtures__` 仅供 `ui-migration/foundation.html` 使用，没有业务路由、生产入口或公共导出。它对照旧组件的有限样式与焦点行为，不是将来 Button/Dialog 的 API 或完整实现。
- `boundary.test.ts` 检查实际源码的导入、重导出、动态导入及类型引用：Base UI 只能在本目录内；业务不能引用私有 fixture；公共 ui 不能依赖 antd。共存 fixture 中的 AntD 对照在 P6 删除。

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
npm run test:ui-foundation -w @orbit/web
npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web
```

Foundation 使用独立 Vite 开发入口，运行 Chromium/WebKit × light/dark × desktop/phone；P0 回归使用正式生产构建。两者都校验 P0 固定浏览器/OS/字体环境。新样例截图作为运行附件保存；旧页面仍按原 252 张截图零像素差异比较，不覆盖基线。主题首屏检查暂停真实 main.tsx 加载，观察原 HTML boot 再放行应用；账号接口采用合成 fixture，不代表真实服务端跨设备验证。
