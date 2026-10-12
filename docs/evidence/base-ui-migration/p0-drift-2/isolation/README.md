# profile-validation 的有界例外：隔离证明

这里是 [p0-drift README](../../p0-drift/README.md) main 漂移参考第 7 条要求的两项隔离证明，对象是 profile-validation 的 6 张截图：Chromium 4 个项目，以及 WebKit 明暗两个手机项目。registry 里这 6 条登记的 `migrationFix.isolation` 都指向 [profile-validation-b1-fix.json](profile-validation-b1-fix.json)。

## 前提

数据见 json 的 `premises`。

- **X**：main `d233a6cd0`（feat(auth): add access token management and /pat/self introspection）。它是 origin/main 上的单个提交，不是晋升合并。
- **R = B1**：P2.3 的 `57f792135`，经晋升合并 `90e749e72` 进入 main。`57f792135` 是 X 的祖先，所以含 X 的每一棵 main 树都带着未修的 B1。
- **F**：B1 修复 `3ec9cf83d`，即交付时的 `86db4c886`（patch-id 都是 `a0288137…`）。协调者对它的证据作出了 CONFIRM 判定：任务 34bQk0jlytjFYyi4OgLMK，第 1 版，摘要 `f20eee2a…0554`。核对时 F 还不在 origin/main 上。
- **授权**：协调者 2026-10-07 授权这次一次性例外（请求 34bWpmojjlLPL0Exs1kSw，裁定记在本任务评论里）。

## 树和运行

- **X+F**：`dcb5fd1bd`，本地分支 `p0d2/d233a6cd0-plus-b1-fix`，不交付。由 `git merge-tree --merge-base 3ec9cf83d^ d233a6cd0 3ec9cf83d` 得到，干净合并，与 X 的差异的 patch-id 等于 F 的。
- **X^1+F**：`16e0188ae`，本地分支 `p0d2/e6786d077-plus-b1-fix`，做法相同。
- **运行**：都用项目 tip 的 P0 测试（含场景维护 `d2479173b`）和固定数据，在 P0.2 环境中跑完整矩阵，截图写入临时目录（`--update-snapshots=all`）。记录见 [../attribution/runs/](../attribution/runs/)：
  - full-maint-d233a6cd0、full-maint-xfix-d233a6cd0、full-maint-xfix-e6786d077：这三次运行中 wiki 用例都失败，原因是这些树早于 `2f9cc095f`，还没有话题行；不影响资料页截图；
  - full-maint-fffcdb532：开工 tip。
- **通知几何**：用 B1 任务的诊断用例 [b1-state.diag.mjs](../../p2.3-b1/tools/b1-state.diag.mjs) 在截图后立刻记录（diag-* 三次运行），结果在 [geometry/](geometry/)。

## (i) X 与 X+F

「通知框」沿用 p2.3-b1 的定义：两棵树里通知卡片和通知列矩形的并集，四周外扩 34px，覆盖 `0 8px 22px` 的阴影。

| 截图 | 差异像素（框内 / 框外） | 单通道最大差 | B1 特征：p2.3-b1 测得的 tip `77233e226` → 修复（框内） | 框外差异与同树重跑对比 |
| --- | --- | ---: | --- | --- |
| chromium-dark-desktop | 490（490 / 0） | 88 | 490，一块 x 1165、y 28、82×11 | 0 px；同一棵 X 树两次重跑 0–124 px，差 ≤2 |
| chromium-light-desktop | 504（495 / 9） | 113 | 495，同一块 | 9 px，差 1；X 树重跑 12 px，差 1 |
| chromium-dark-phone | 315（303 / 12） | 48 | 303，一块 x 164、y 69、66×10 | 12 px，差 1；X 树重跑 3 px，X+F 树重跑 18 px |
| chromium-light-phone | 335（306 / 29） | 60 | 306，同一块 | 29 px，差 2；X 树重跑 22–40 px，差 2 |
| webkit-dark-phone | 4239（4239 / 0） | 167 | 4239，胶囊和阴影整体右移 4px | 0；WebKit 重跑处处为 0 |
| webkit-light-phone | 4861（4861 / 0） | 224 | 4861，同上 | 0 |

- **框内**：6 张的差异像素数都与 B1 修复任务在同一页面上测得的值逐个相等。那次测量的 tip `77233e226` 已经包含 `d233a6cd0`。
- **几何**：
  - X 上卡片是 `will-change: transform`，WebKit 手机通知列被内联宽度钉成 358px，胶囊 x=127.141；
  - X+F 上卡片回到 `auto`，WebKit 手机通知列是 CSS 的 350px，胶囊 x=123.141，与 P0.2 相同。
- **框外**：只有 Chromium 有零散像素，单通道差 ≤2，与同一棵树两次重跑之间的噪声同量级。WebKit 框外逐字节相同。
- **其余截图**：这几次运行都没有 wiki 场景的 20 张（见上），其余 226 张中，X 与 X+F 之间 203 张相同、19 张 Chromium 噪声。超出噪声的只有 Chromium 的 settings-saved 4 张，那是同一修复在设置页胶囊上的效果；它们由第 1 批的 A4 在 B1 之前的树上登记，不在本例外内。

## (ii) X^1+F 与 P0.2

| 截图 | 结果 |
| --- | --- |
| chromium-dark-desktop、webkit-dark-phone、webkit-light-phone | 逐字节相同 |
| chromium-light-desktop | 89 px，单通道差 2，在记录的噪声范围内 |
| chromium-dark-phone | 86 px，差 2，噪声 |
| chromium-light-phone | 74 px，差 2，噪声 |

噪声范围采用 p0-drift README「Chromium 渲染噪声」：P0 比较器通过、单通道差 ≤4、≤200 像素，只在 Chromium 出现。修复只把胶囊恢复成 P0.2 的样子，没有带进别的变化。

## 文件

- [profile-validation-b1-fix.json](profile-validation-b1-fix.json)：前提、树、运行、(i)、(ii) 的全部数据，由 [isolation-summary.py](../tools/isolation-summary.py) 生成；
- [outside-noise.json](outside-noise.json)：框外像素与同树重跑的对比，由 [outside-noise.cjs](../tools/outside-noise.cjs) 生成；
- [geometry/](geometry/)：通知几何，由 [toast-geometry.py](../tools/toast-geometry.py) 从诊断运行的报告里取出；
- [crops/](crops/)：每张截图通知框的放大并排图，从左到右依次是 P0.2、X^1+F、X、X+F、项目 tip，由 [isolation-crops.py](../tools/isolation-crops.py) 生成。只作目视参考，判定以像素数据为准。
