# Orbit Web AntD 迁移清单与依赖审计

本目录交付 [P0.1 建立 AntD 迁移清单与依赖审计](orbit-task:34Za38sqai2AMSfN0oWkz)，服务于 [Orbit Web 组件迁移项目](orbit-project:34ZZeq0e3IR65GVm2kAs7)。仅新增审计脚本和证据文档，生产源码、样式、依赖声明和锁文件均未修改。清单以源码事实为准；替代方案和阶段是后续实施责任，不表示迁移已完成。

实施基线：`1068a14b899911838526111b6814394e99762aaf`，开始时工作区干净。规划快照：`9172a78368eaffbf024b549e9f9bfb553ff99e4c`。读取过本任务（无历史评论、无前置任务）、项目目标、作业指导、8 项验收及下游任务范围。项目 P0 原文为：**P0：迁移清单和现有视觉、行为基线可复现，所有 AntD 使用点均有迁移归属。**

本次负责依赖清单子范围；固定数据、真实浏览器截图/交互、首次 Web 构建/测试及包体积/性能基线由 [P0.2 固化视觉、行为与性能基线](orbit-task:34Za38vNhaO1g44eCoRzl) 建立，不能用本次静态审计代替。没有部署或发布。

## 实际计数

| 文件口径 | 规划快照 | 实施基线 |
| --- | ---: | ---: |
| 直接引用 antd 的生产文件 | 91 | 93 |
| 直接引用 antd 的测试文件 | 62 | 64 |
| 含 `.ant-*` 的测试文件 | 54 | 54 |
| 引用独立图标包的生产文件 | 78 | 80 |
| 生产 antd 与图标文件并集 | 117 | 120 |
| index.css 行数 | 20338 | 20636 |

扫描 `src/web/src/**`、`src/web/package.json`、根 `package-lock.json` 共 554 个文件：265 个非测试源文件、287 个测试、2 个依赖清单。文件名/目录判定测试；`SharedSessionPage.fixtures.ts` 在非测试计数内，实际只是测试数据，已明确收录。额外有 **60 个**测试包含裸 `ant-*` 字符串（例如 `ant-spin`），不能只查 `.ant-`。计数是文件数，不是组件实例数；注释、测试 mock、源码断言也收录。

实际锁定版本：`antd@6.6.5`、`@ant-design/icons@6.3.4`、`@ant-design/icons-svg@4.6.0`。图标包及 `.anticon` 允许保留，不能删除整个 `@ant-design/*` 命名空间。规划与实施的增减文件集合见[路由和测试索引](routes-and-tests.md)。

## 清单如何阅读

| 产物 | 用途与归属规则 |
| --- | --- |
| [audit-baseline.json](audit-baseline.json) | 机器原始清单：每文件 SHA-256、导入模块/原名/别名/typeOnly/行号、逐行命中类别和原文、manifest/lockfile 依赖及传递关系。保留所有扫描文件以便复核范围。 |
| [ownership.json](ownership.json) | 149 个源文件的实际切换阶段、公共能力准备阶段、替代方式及保留行为；包括22个页面 TSX、118个共享组件源文件、1个共享测试数据文件及8个根入口/主题/通知支持文件。KEEP 项同时有集成复核阶段。 |
| [component-contracts.md](component-contracts.md) | 全部37种 antd 导入原名（组件、服务、类型）的替代与行为契约；包含 reset、内部 ref、已有自有通知及图标边界。 |
| [css-ownership.json](css-ownership.json) | index.css 的26个基线区段，覆盖182行的187个 antd/ant-class 命中；逐区段给实际页面阶段、替代和保留行为。行号只对钉住的基线有效。 |
| [routes-and-tests.md](routes-and-tests.md) | 48个带path路由、index与无path布局、22个页面模块入口链；287个测试全部按阶段分组，并标记直接 antd/选择器依赖；人工复核 ref/焦点/命令式 API 热点。 |

一次依赖的完整记录是 **机器命中位置 + 文件归属 + 导入原名契约**；index.css 使用更细的 CSS 区段覆盖文件级归属；测试使用逐文件测试索引。每条命中保留原文和行号，能直接定位复查。未命中 antd 的共享组件仍列出，避免 reset、Provider 或子组件迁移影响入口而漏测。

`phase` 是负责切换的阶段，`foundationPhases` 是先要具备的公共能力；例如 P2 准备 Dialog，不代表所有引用 Modal 的页面都应在 P2 改完。跨阶段共享项在 `notes`、`reviewPhase` 和 CSS 区段注明。`src/web/package.json` 的 antd 声明及 `package-lock.json` 的 antd 可达子树归 **P6**：正常更新依赖和锁文件，保留图标仍需的支持包。

## 复现与复查命令

从仓库根目录运行；只需 Node，脚本仅使用内建模块，不需 npm install、网络或已装的 antd。此次实际环境为 Linux、Node `v26.10.0`。脚本定位仓库根不依赖调用时 cwd。

```sh
# 摘要及完整现状；JSON 输出无时间戳，顺序稳定。
node src/web/scripts/audit-antd.mjs
node src/web/scripts/audit-antd.mjs --json > /tmp/orbit-antd-current.json

# 验证扫描器识别 imports/aliases/types/mocks/选择器/ref，且图标独立存在时不阻塞退役。
node src/web/scripts/audit-antd.test.mjs

# 验证完整归属、37种导入契约、测试全集、CSS逐命中覆盖，并与钉住基线逐字段比较。
# 仅允许 HEAD 因交付提交而改变；scopeHash/files/counts 等必须相同。
node src/web/scripts/verify-antd-inventory.mjs /tmp/orbit-antd-current.json
```

`verify-antd-inventory.mjs` 不传参数只验证已保存的清单覆盖；传新报告才验证源码复现。后续阶段源码改变时，与 P0 基线不相等是预期变化，需审查差异，不要覆盖此历史基线来让检查变绿。在新阶段另存报告，逐项关闭本清单的依赖；新文件、新 import、新 `.ant-*` 及新内部 ref 必须补充归属。文件 hash 和 scopeHash 记录实际读到的字节，不把 HEAD 相同误当作工作区相同。

无需修改当前工作区即可取回历史源码（临时目录保留可供核对）：

```sh
baseline_dir=$(mktemp -d /tmp/orbit-antd-baseline.XXXXXX)
git archive 1068a14b899911838526111b6814394e99762aaf src/web/src src/web/package.json package-lock.json | tar -x -C "$baseline_dir"
git show 1068a14b899911838526111b6814394e99762aaf:src/web/src/main.tsx
```

辅助交叉检查（rg 没有匹配返回1是正常的；多行导入、别名和类型以脚本清单为准）：

```sh
rg -n 'antd|\.ant-|resizableTextArea|RefSelectProps|useApp|useToken' src/web/src src/web/package.json package-lock.json
rg -n '@ant-design/icons|\.anticon' src/web/src src/web/package.json package-lock.json
rg -n 'modal\.(confirm|success)|getPopupContainer|querySelector|closest|classList' src/web/src
```

第一条粗搜仍可能命中注释和非依赖文字，不能用它直接删除代码。第二条单独核对允许保留的图标。通用 DOM 搜索用来人工排查拼接的类名/间接 ref；不是所有 querySelector、focus 或 message.error 都依赖 AntD。

## P6 退役入口

```sh
node src/web/scripts/audit-antd.mjs --check-retired
node src/web/scripts/audit-antd.mjs --json --check-retired > /tmp/orbit-antd-retirement.json
```

当前基线应退出 **1**（203个阻塞文件），证明检测到尚存的组件耦合，不能把这次预期失败当作已完成退役。没有阻塞返回0，未知参数返回2。阻塞范围是 antd 导入/文字、`ant-*` class、已知内部 ref 和 v5 patch；注释和负向测试断言也保守阻塞。历史说明移入证据目录，合法 `.anticon`、图标包及支持包不阻塞。不要为通过扫描删除仍有效的业务断言，应改用角色、标签和可见行为。

静态扫描不能证明计算模块名、间接/跨文件别名、拼接类名和运行时行为已退役。P6 还须人工重读候选 `use-app/use-token/provider/theme/imperative-*/ref-focus`、更新后干净安装、检查 `npm ls antd -w @orbit/web --all` 与 `npm explain` 的可达路径，并检查实际 JS/CSS 构建产物。空依赖树的 npm 命令可能返回非零，应读树而非把退出码当唯一事实。支持包存在与否不能替代“antd 不再可达”的证明。

P6 类型检查/构建和 P7 的完整回归另行执行：

```sh
npm run build -w @orbit/web
npm run test -w @orbit/web
# P0.2 将建立的浏览器入口；本次基线尚未定义此 npm script。
npm run test:ui-migration -w @orbit/web
```

新旧组件共存时，各页面批次按本清单重验主题、层叠、嵌套弹层、焦点恢复与手机触摸；CSS 区段只清当前迁移产生的遗留。不要删除独立图标、全局业务样式，或通过降低断言与覆盖截图掩盖差异。

## 本次验证记录

审计自测、两次 JSON 字节一致性、机器/独立集合计数、149个源文件归属、37种导入契约、287个测试及26个 CSS 区段完整性均通过。退役命令按预期返回1；仅图标 source/manifest/lockfile 的自测通过。`git diff --check` 通过，生产界面文件差异为零。

本次未运行 Web 完整构建/测试或浏览器，也未声称取得视觉或性能证据；这些属于 P0.2 及后续阶段。本清单的静态扫描局限已同时保存于报告 `limitations`，人工热点及复查方法见上述索引。
