# P0 漂移登记（第 3 批）：资料页新请求 /api/auth/methods

本目录服务于任务 [P0 漂移登记（第 3 批）：资料页新请求 /api/auth/methods](orbit-task:34bkiemVmb1y5O0G52K6m)，对应项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。** 按 [p0-drift README](../p0-drift/README.md)「维护规则」main 漂移参考第 3 条，这是协调者另建的「P0 漂移登记」任务。规则、两个登记层和维护清单都在 p0-drift 目录；本目录是这一批的失败清单、归因、截图对照、验证和原始记录。

## 结论

| 项目 | 结果 |
| --- | --- |
| 开工时的失败 | 项目 tip `7732f14f8` 上完整 P0（作业 `bgj_982b5dfb30df`）：112 个测试 93 通过、11 个已记录的跳过、**8 失败**，与 P3.3 报告的一致。8 个失败都是 profile，每个项目一个，都停在用例结束后的固定数据校验「Every API call must have an explicit browser fixture」，`unhandled` 只有 `GET /api/auth/methods`。没有别的失败，也没有开工后新带进的 main 提交（`origin/main` 一直是 `216cc204f`）。 |
| 完整失败面 | 失败的 8 个用例都已截到 profile 和 profile-validation 两张图并比较通过，所以没有被挡住的截图。用 update 模式把 tip 的 252 张截全后对照当前期望（88 张 P0.2 原图、152 张 main 漂移参考、12 张已接受差异）：**252 张全部通过 P0 比较器**。按归因规则低于阈值的 17 张，都是第 2 批和 P3.2 登记时已记录的（P3.2 11 张、`d233a6cd0` 的 WebKit 滚动条 6 张）。 |
| 归因 | 新请求归因到 main **`558a8ba1f`** feat(auth): link and unlink Google from the profile page, admin unlink, signInMethods, Sign-in settings (S4)。逐层同环境运行（见「归因」）：项目线 `fc58e5713` → `09cc5760d`，main 线 `422627ef7` → `eee179f5d`，Google 登录项目线 `106c25fc2` → `98cdd37d0`，S4 分支 `463bb277a` → `558a8ba1f`。每一层前驱 8/8 没有这个请求，变化的提交 8/8 只有这个请求没有建模，区间终点的 `src/web`、`src/shared` 与变化的提交相同。 |
| 固定数据维护 | `5d7801e47`：只在 `fixtures.mjs` 加一条精确路由 `GET /api/auth/methods` → `{ password: true, google: false, googleSignup: false }`，注释和提交说明引用 `558a8ba1f`。取值是服务端在管理员打开 Google 登录之前的默认回答，与已有的 `/users/me`（只有密码、没有 `signInMethods`）一致；依据写进 p0-drift README。规则以单独提交 `0efaf2234` 把「场景维护」扩展为「场景与固定数据维护」。 |
| 截图变化与登记 | **没有截图变化，没有登记。** 同环境逐张比较：吸收 main 前后、每一层下钻、补固定响应前后，252 张都是 **0 张变化**，WebKit 126 张全部逐字节相同，Chromium 只有噪声；资料页 profile 8 张在每组对照里都逐字节相同。Sign-in methods 卡片对 P0 账号不画出，所以 `558a8ba1f` 没有改变任何 P0 截图。`reference/`（164 条）、`accepted/`（12 条）都没改，没有失效的已接受条目，没有归因不到 main 的变化。 |
| 两轮完整 P0 | 在 `0efaf2234`（tip 加本批两个提交）上连续两轮 P0 原命令（作业 `bgj_35ed9d133430`）：每轮 112 个测试，**101 通过、11 个已记录的跳过、0 失败、0 flaky**，退出码 0，两轮逐项一致。profile 8/8 通过，每个用例正好 1 次 `GET /api/auth/methods`，`unhandled` 为空。 |
| 负对照 | 两组负对照都在 `0efaf2234` 上以临时提交运行 P0 原命令，结果都是失败：资料页加 1px，profile.png 8/8 对照第 2 批的 A6 参考失败（1528–2537 像素）；资料页多读一个没有建模的请求，profile 8/8 停在固定数据校验，`unhandled` 只有那个请求。两次的其余测试都与正式回归相同。本批没有新登记的截图，所以 1px 加在本批维护的页面上（见「缺口与边界」）。 |
| 合并检查 | 在 `0efaf2234` 上运行 `npm run build -w @orbit/web && npm run test -w @orbit/web`（作业 `bgj_1ab88e22c258`），退出码 0：构建成功，保留原有的大 chunk 提示；Vitest **344 个文件、4379 个用例全部通过**。 |
| 不变的部分 | P0.2 的 252 张原图、原断言、known-failures、截图比对选项和容差，main 漂移参考层和已接受层，产品代码，`fixtures.mjs` 已有的路由，都没有改（核对命令见「不变的部分」）。 |

## 执行经过

- **起点**：项目分支 tip `7732f14f8`（`refs/heads/project/34ZZeq0e3IR65GVm2kAs7`），本会话期间没有变动。
  - 它的 first-parent 历史上，P3.2 差异登记之前的 tip 是 `fc58e5713`；之后依次是吸收 main 的 `09cc5760d`（第二父 main `216cc204f`）和合入 P3.2 差异登记的 `7732f14f8`。
  - 本机 `origin/main` 开工时和交证据前都是 `216cc204f`，项目线已吸收全部 main，没有另外带进的 main 提交。
- **依赖与环境**：
  - 用 `bash scripts/worktree-overlay.sh` 按锁文件隔离安装（作业 `bgj_a5c6f2d3d149`）；
  - 每次浏览器运行都由 P0 的 `environment.mjs` 与 [P0.2 environment.json](../p0.2/environment.json) 逐字段比较并通过：Debian 13.7、Node v26.10.0、Playwright 1.63.0（Chromium 1243 / WebKit 2359）和字体文件哈希；
  - 每次运行写出的 environment.json 都与 P0.2 记录逐字节相同，SHA-256 `fe69e824…`（[attribution/environments/](attribution/environments/)）。
- **磁盘**：开工时根分区只剩 23 GB，低于作业指导的 30 GB。本会话在 /var/tmp 没有可清理的目录，已报告协调者；协调者答复照常进行，用精简树、共享依赖并及时清理，剩余低于 10 GB 时停下耗空间的运行。全程最低 19 GB，没有低于 10 GB。
- 本机 24 核、15 GB 内存，有其他会话占用，1 分钟负载在 12–47 之间。
- 由 Claude Opus 5.5 执行。没有推送 main 或项目分支，没有部署或发布。

## 环境与方法

- **精简构建树**：沿用第 2 批的做法（[prepare-tree.sh](tools/prepare-tree.sh)）。
  - 每个候选提交用 `git archive` 取出 Web 构建会读的文件：根 manifest、`tsconfig.base.json`、`src/shared`、`src/web`，以及 apiserver 的 manifest。
  - 7 个候选提交的 package-lock.json 都相同（blob `f03a6e32…`），依赖共用本工作树由 `worktree-overlay.sh` 隔离安装的那一份，安装命令与第 2 批的共享安装相同（`npm ci --ignore-scripts --include=dev --include=optional`）。脚本对锁文件不同的提交拒绝构建。
  - `@orbit/shared` 链接到这棵树自己的 `src/shared`，之后按 `pretest:ui-migration` 构建 shared 和 Web，`PUBLIC_ORIGIN` 不设。
  - 核对：用这种方式构建 tip `7732f14f8`，产物 22 个文件与本工作树里 pretest 构建的逐字节相同。各提交的产物哈希在 [attribution/dists/](attribution/dists/)。
- **运行器**：P0 测试从运行器目录运行，被测树只提供生产构建和 `npm run preview`（[p0d3.config.mjs](tools/p0d3.config.mjs)，与第 2 批的 p0d2.config.mjs 相同）。两个运行器：
  - `orig`：tip `7732f14f8` 的 P0 测试，即没有新固定响应的原测试；
  - `fix`：`5d7801e47` 的 P0 测试，与 `orig` 只差那一条固定响应。
- **运行方式**：
  - 完整矩阵就是 pages、states、breakpoints 三个文件，共 80 个测试、252 张截图。截图写入空的临时目录（`--update-snapshots=all`），每张都能截到，再逐张比较；固定数据校验、定位和页面异常照常判定；
  - 每次运行都放在独立网络命名空间里（`unshare -n`），保持 P0 的 `http://127.0.0.1:4173`（[run.sh](tools/run.sh)）。
- **请求记录**：harness 在每个测试结束时（失败也写）把 `requests`、`unhandled`、`captures` 和 `pageErrors` 写进 `evidence.json`。每次运行的 8 个 profile 测试，这几项按项目摘在 `profile-requests.json`（[profile-requests.py](tools/profile-requests.py)；只去掉计算样式和计时），[fixture-chain.py](tools/fixture-chain.py) 再汇总成 [attribution/fixture-chain.json](attribution/fixture-chain.json)。
- **比较与噪声**（[compare.cjs](tools/compare.cjs)，与第 2 批相同）：逐像素差异，加上 P0 比较器在 `maxDiffPixels: 0`、默认 threshold 下的结论。按 p0-drift README「Chromium 渲染噪声」判定「变化」：比较器不通过，或 WebKit 有任一像素不同，或 Chromium 单通道差超过 4 或超过 200 像素。其余记为噪声。
- **记录**：每次运行的树提交、运行器提交、参数、起止时间、退出码、环境核对、每张截图的 SHA-256、输出，以及去掉附件正文的 Playwright 报告 `report.summary.json`，都在 [attribution/runs/](attribution/runs/)。体积规则见「证据体积」。

## 失败清单

开工时在 tip `7732f14f8` 上运行 P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，放在独立网络命名空间里（[netns-regression.sh](tools/netns-regression.sh)，作业 `bgj_982b5dfb30df`，[checks/tip-start](checks/tip-start/summary.json)）：
- 共 112 个测试：93 通过、11 个已记录的跳过、**8 失败**、0 flaky，退出码 1。与 P3.3 在同一提交上的结果（作业 `bgj_f21bc02377fe`）一致。
- 期望组装输出 `P0 expected screenshots: 88 P0.2 originals, 152 main drift references, 12 accepted migration differences.`，环境记录与 P0.2 逐字节相同。

| 用例 | 项目 | 停在 | 报告的 `unhandled` | 截到并通过比较的截图 | 页面异常 |
| --- | --- | --- | --- | --- | --- |
| profile | 8 个项目各 1 个 | 用例结束后的固定数据校验 `api.assertHandled()`：「Every API call must have an explicit browser fixture」 | `['GET /api/auth/methods']`，每个用例 1 次请求 | profile、profile-validation（两张都已截到并比较通过） | 无（`pageErrors` 为空） |

- **请求次数**：这次运行每个用例请求 1 次。`main.tsx` 给 React Query 设了 `retry: 1`，501 的回答会在约 1 秒后重试一次，所以较慢的归因运行里有的用例记录到 2 次，`unhandled` 里也是两条相同的 `GET /api/auth/methods`，没有别的请求。补了固定响应后回答是 200，不再重试，每个用例正好 1 次。

- **其余 93 个通过**：pages 48（profile 以外的 6 个场景）、states 16、断点 4、P2.3 生产通知 8、P0.2-FOCUS-1/2 16（P3.2 修好后作为普通测试）、性能 1。
- **11 个跳过**：7 个非参考项目的性能采样、4 个手机项目的桌面断点巡检，与第 2 批和 P3.2 登记相同。
- **定位的依据**：harness 在场景跑完之后才做固定数据校验，再检查页面异常（[harness.mjs](../../../../src/web/ui-migration/harness.mjs)）。8 个用例的 evidence.json 都记录了 `captures: ['profile', 'profile-validation']`，所以资料页的两张截图都已截到，并按当前期望比较通过；失败只在固定数据校验（[checks/tip-start/profile-requests.json](checks/tip-start/profile-requests.json)；原始 evidence.json 留一份作样例：[chromium-light-desktop](checks/tip-start/profile-evidence/pages.browser.mjs-profile-chromium-light-desktop.json)）。
- **页面异常这一步没有执行到**：校验失败后，`pageErrors` 的断言没有执行，但 8 个 evidence.json 里 `pageErrors` 都为空。补了固定数据后，这一步在正式回归里执行并通过。

## 归因：新请求来自 main `558a8ba1f`

固定数据校验的失败按 main 漂移参考第 4 条 (a)–(c) 的办法逐层下钻，每一层都用同环境运行证明「前驱没有这个请求、该提交有、区间终点与该提交相同」。判定依据是每次运行 8 个 profile 测试的 evidence.json（汇总见 [attribution/fixture-chain.json](attribution/fixture-chain.json)）。

| 层级 | 前驱（无请求） | 运行 | 改变的提交（有请求） | 运行 | 区间终点 |
| --- | --- | --- | --- | --- | --- |
| 项目线 first-parent | `fc58e5713`：8/8 通过，没有这个请求 | full-orig-fc58e5713 | `09cc5760d`（吸收 main `216cc204f`）：8/8 失败，`unhandled` 只有这个请求 | full-orig-tip（`src/web`、`src/shared` 与 `09cc5760d` 相同） | tip `7732f14f8`，同左 |
| main first-parent（`09cc5760d` 第二父） | `422627ef7`：8/8 通过，没有这个请求 | full-orig-422627ef7 | `eee179f5d` Merge refs/heads/project/34b9KDmnRzopeuF1enIN6 into main：同 tip | full-orig-tip（`src/web`、`src/shared` 相同） | `216cc204f`，`src/web`、`src/shared` 与 `eee179f5d` 相同 |
| Google 登录项目 first-parent（`eee179f5d` 第二父） | `106c25fc2`：两次运行都 8/8 通过，没有这个请求 | full-orig-106c25fc2、full-orig-106c25fc2-r2 | `98cdd37d0` Merge refs/heads/orbit/s4-web-sign-in-818c25：8/8 失败，`unhandled` 只有这个请求 | full-orig-98cdd37d0 | `359876433`，`src/web`、`src/shared` 与 tip 相同 |
| S4 分支 first-parent（`98cdd37d0` 第二父） | `463bb277a`：8/8 通过，没有这个请求 | full-orig-463bb277a | **`558a8ba1f`**：8/8 失败，`unhandled` 只有这个请求，`pageErrors` 为空 | full-orig-558a8ba1f | `407dfd7bb`，`src/web`、`src/shared` 与 `558a8ba1f` 相同 |

- 所有运行都用同一个运行器 `orig`（tip 的 P0 原测试），环境与 P0.2 逐字节相同。每次运行都是完整矩阵 80 个测试；没有这个请求的 4 棵树（5 次运行）都是 76 通过、4 跳过、0 失败；有这个请求的树只有 8 个 profile 测试失败，别的测试都通过，`unhandled` 在全部测试里只出现 `GET /api/auth/methods`。
- 8 个 profile 测试在每棵树上都截到了 profile 和 profile-validation 两张图（`captures`），失败只在固定数据校验。
- 补了固定响应的运行器 `fix` 在 tip 上（full-fix-tip）：80 个测试 76 通过、4 跳过、0 失败，8 个 profile 测试每个正好请求 1 次 `GET /api/auth/methods`，`unhandled` 为空，`pageErrors` 为空。

- **下钻路径**：
  - **项目线**（(a)）：`fc58e5713` → `09cc5760d`。`09cc5760d` 吸收 main `216cc204f`，`7732f14f8` 在其上只合入了 P3.2 差异登记（只改 `docs/`），两者的 `src/web`、`src/shared` 树相同（`f644475b…`、`67c7868c…`），所以 tip 的运行代表 `09cc5760d`。
  - **main first-parent 线**（(b)，`09cc5760d` 的第二父 `216cc204f`）：`fc58e5713` 之后有 9 个提交：`49282bae8`、`decda058b`、`4c87acc96`（本项目晋升 `77233e226`）、`9b5f02d9b`、`1a5f7b720`（本项目晋升 `fc58e5713`）、`d6999a710`、`422627ef7`、`eee179f5d`、`216cc204f`。请求出现在 `eee179f5d`（Merge refs/heads/project/34b9KDmnRzopeuF1enIN6 into main，Google 登录项目）。区间终点 `216cc204f` 只改 apiserver，`src/web`、`src/shared` 与 `eee179f5d` 和 tip 相同。
  - **Google 登录项目的 first-parent 线**（`eee179f5d` 的第二父 `359876433`）：不在 `422627ef7` 里的有 11 个提交，最早的是 `106c25fc2`。请求出现在 `98cdd37d0`（Merge refs/heads/orbit/s4-web-sign-in-818c25 into project/34b9KDmnRzopeuF1enIN6）。区间终点 `359876433` 的 `src/web`、`src/shared` 与 tip 相同。
  - **S4 分支的 first-parent 线**（`98cdd37d0` 的第二父 `407dfd7bb`）：`558a8ba1f` → `92190c14b`（把 Google 项目合入 S4 分支）→ `407dfd7bb`。请求出现在 `558a8ba1f`，它的 first-parent 前驱是 `463bb277a`。`92190c14b`、`407dfd7bb` 的 `src/web`、`src/shared` 与 `558a8ba1f` 相同（`681c22ec…`、`9990fc06…`）。
- **(c) X 在 main 上，不是晋升合并**：
  - `558a8ba1f` 是 `origin/main`（`216cc204f`）上的单个非合并提交，属于 Google 登录项目（34b9KDmnRzopeuF1enIN6），不是 `Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main`。
  - 请求来自产品代码：它新增的 `components/SignInMethodsCard.tsx` 用 `lib/googleLink.ts` 的 `authMethodsQuery()` 读 `GET /auth/methods`，`pages/ProfilePage.tsx` 在资料页挂载这张卡片。卡片在挂载时就发请求，与是否画出无关。
  - `422627ef7` 不含 `558a8ba1f`，它的历史里也没有 `SignInMethodsCard.tsx` 和 `googleLink.ts`。

## 固定数据维护

**问题**：main `558a8ba1f` 让资料页读 `GET /api/auth/methods`。P0 固定数据没有这条路由，按 P0.2 的设计，没有建模的请求返回 501，并让用例在固定数据校验处失败。

**改动**：只有 [5d7801e47](../../../../src/web/ui-migration/fixtures.mjs) 一处，单独提交，只改 `fixtures.mjs`：

```diff
     if (method === 'GET' && path === '/api/auth/setup-status') return json({ needsSetup: false });
+    // main 558a8ba1f (feat(auth): link and unlink Google from the profile page, ... (S4)) made the profile
+    // page read GET /auth/methods. The server's default answer: Google sign-in is off until an
+    // administrator turns it on, so the password alone (SignInProvidersService.methods()).
+    if (method === 'GET' && path === '/api/auth/methods') return json({ password: true, google: false, googleSignup: false });
```

- **只补这一条**：方法和路径完全相同才命中；已有的固定数据、断言、截图比对、容差和期望图都没改；其余没有建模的请求照旧返回 501 并使校验失败（负对照 2 证明）。
- **取值依据**（也写在 p0-drift README「固定数据维护」的清单里）：
  - **服务端的默认回答**：`GET /auth/methods` 由 `SignInProvidersService.methods()`（`src/apiserver/src/auth/sign-in-providers.service.ts`）回答。没有 `sign_in_provider` 记录，或记录没开启、缺 client ID 或密钥时，回答就是 `{ password: true, google: false, googleSignup: false }`；Google 登录要管理员在 Admin → Sign-in 里打开才有（`7bb096cad` feat(auth): store Google sign-in settings, off until an administrator turns it on）。`googleSignup` 只在 Google 登录开着且注册策略为 OPEN 时为 true。
  - **与已有固定数据一致**：P0 账号（`/users/me` 的固定数据）是普通成员，没有 `signInMethods` 字段；按 `lib/queries.ts` 的说明，这表示早于 Google 登录的服务端，账号只有密码。只能用密码登录、没有绑定 Google，与服务端没开 Google 登录相符。
  - **页面因此显示什么**：`SignInMethodsCard` 只在账号有 `signInMethods`，并且 Google 登录开着、已绑定 Google 或没有密码时才画出（`SignInMethodsCard.tsx` 第 88 行）。真实产品里，一个只有密码的账号在没开 Google 的服务端上看不到这张卡片，资料页与 `558a8ba1f` 之前相同，Change password 卡片照常显示。P0 账号没有 `signInMethods`，卡片同样不画。如果取 `google: true`，真实产品会给这个账号显示带 Connect Google 的卡片，P0 页面却不会，截图就不是真实产品在这一状态下的样子。所以只有 `google: false` 同时符合服务端默认和已有固定数据。
- **同环境证明**：见上节，`463bb277a` 上 8/8 没有这个请求、校验通过；`558a8ba1f` 上 8/8 校验失败，`unhandled` 只有 `GET /api/auth/methods`。同一棵 `558a8ba1f` 树换用 `fix` 运行器只跑 profile 测试（profile-fix-558a8ba1f）：8/8 通过，每个用例正好 1 次请求，`unhandled` 为空。所以在引入请求的提交上，只补这一条响应就够了。
- **规则**：p0-drift README 的「场景维护」扩展为「场景与固定数据维护」，加入固定数据维护的 6 条规则和已做的维护清单（`0efaf2234`，单独提交，只改 p0-drift README）。

## 截图：吸收 main 与补固定响应都没有改变截图

逐张比较的数据在 [compare/](compare/)，由 [compare.cjs](tools/compare.cjs) 生成。

| 对照 | 运行 | 252 张的结果 | 资料页 16 张 |
| --- | --- | --- | --- |
| 吸收 main 前后（项目线 `fc58e5713` → `09cc5760d`，即 tip） | full-orig-fc58e5713 → full-orig-tip，同为原测试 | 235 张逐字节相同，17 张 Chromium 噪声（≤23 像素，单通道差 ≤4），**0 张变化**；WebKit 126 张全部逐字节相同；比较器全部通过 | profile 8 张逐字节相同；profile-validation 6 张相同，2 张 Chromium 噪声（10、7 像素，差 1） |
| X^1 → X（`463bb277a` → `558a8ba1f`） | full-orig-463bb277a → full-orig-558a8ba1f | 233 张逐字节相同，19 张 Chromium 噪声（≤30 像素，差 ≤2），**0 张变化**；WebKit 126 张全部逐字节相同 | profile 8 张逐字节相同；profile-validation 5 张相同，3 张 Chromium 噪声（30、14、10 像素，差 1） |
| main 线（`422627ef7` → `eee179f5d`，`src/web`、`src/shared` 与 tip 相同） | full-orig-422627ef7 → full-orig-tip | 232 张逐字节相同，20 张 Chromium 噪声（≤50 像素，差 ≤2），**0 张变化**；WebKit 126 张全部逐字节相同 | profile 8 张逐字节相同；profile-validation 4 张相同，4 张 Chromium 噪声（≤29 像素，差 ≤2） |
| 吸收点之前的 main 线（`fc58e5713` → `422627ef7`） | full-orig-fc58e5713 → full-orig-422627ef7 | 223 张逐字节相同，29 张 Chromium 噪声（≤52 像素，差 ≤4），**0 张变化**；WebKit 126 张全部逐字节相同 | profile 8 张逐字节相同；profile-validation 4 张相同，4 张 Chromium 噪声（≤28 像素，差 ≤2） |
| Google 登录项目线（`106c25fc2` → `98cdd37d0`） | full-orig-106c25fc2-r2 → full-orig-98cdd37d0 | 228 张逐字节相同，24 张 Chromium 噪声（≤113 像素，差 ≤4），**0 张变化**；WebKit 126 张全部逐字节相同 | profile 8 张逐字节相同；profile-validation 4 张相同，4 张 Chromium 噪声（≤113 像素，差 ≤2） |
| 补固定响应前后（tip，原测试 → `5d7801e47` 的测试） | full-orig-tip → full-fix-tip | 248 张逐字节相同，4 张 Chromium 噪声（≤90 像素，差 ≤2），**0 张变化**；WebKit 126 张全部逐字节相同 | profile 8 张逐字节相同；profile-validation 6 张相同，2 张 Chromium 噪声（9、90 像素，差 1） |
| 当前期望（P0.2 加两层登记）→ 补固定响应后的 tip | expected-screenshots（tip-start 组装）→ full-fix-tip | 252 张全部通过 P0 比较器：220 张逐字节相同，15 张噪声，17 张低于阈值的变化 | 全部通过，profile 与 profile-validation 都对照第 2 批的 A6 参考 |

- **低于阈值的 17 张都是已记录的**：P3.2 的 11 张（深色 task-action-menu 4 张，webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus，WebKit 桌面的 breakpoint-599/601-dialog 4 张，见 [p3.2-accepted](../p3.2-accepted/README.md)），以及 `d233a6cd0` 改变的 WebKit 设置页滚动条 6 张（settings ×4、桌面 settings-saved ×2，见 [p0-drift-2](../p0-drift-2/README.md)「失败清单」）。不补固定响应时（full-orig-tip）也是同样的 17 张，与本批无关。
- **`106c25fc2` 跑了两次**：第一次（full-orig-106c25fc2）在主机负载约 46 时运行，chromium-light-phone 的 profile 用例用了 20.8 秒（其他运行约 1.5 秒），截 profile-validation 时 3 秒的「Name saved」提示已经消失，与其他所有运行相差约 8250 像素，而其他 8 次运行都截到了这个提示；同一次运行的 chromium-light-phone/projects-loading 也截到了不同的加载图标帧（122 像素，差 20），这张在其他 8 次运行中逐字节相同。同一棵树重跑（full-orig-106c25fc2-r2）后这两张与其他运行一致，两次之间只差这两张（[对照](compare/106c25fc2--106c25fc2-r2.json)，[并排图](attribution/images/full-orig-106c25fc2-vs-463bb277a--chromium-light-phone--profile-validation.png)）。所以上表用重跑；第一次运行也保留，它的 profile 用例同样 8/8 没有这个请求。
- **Google 登录项目那一层只用来定位请求**：`98cdd37d0` 的树早于本项目的 B1 修复 `3ec9cf83d` 和 P3.2（`066d3dd30`）进入这条线；它们经 api-key-runner 分支合入的 main `d6999a710`，到区间终点 `359876433` 才进来。所以 `98cdd37d0` 与 tip 之间有 33 张截图不同，全是本项目自己的迁移改动：B1 胶囊（profile-validation 6 张、Chromium settings-saved 4 张），以及 P3.2 的 task 场景（task-share-dialog、task-action-menu 各 8 张，webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus，WebKit 桌面的 breakpoint-599/601-dialog 4 张）。这些已经在 tip 的期望里（B1 修复后对照参考层，P3.2 是已接受层和低于阈值的差异），与新请求无关（[compare/98cdd37d0--tip.json](compare/98cdd37d0--tip.json)）。
- **Sign-in methods 卡片没有画出**：P0 账号没有 `signInMethods`，补固定响应前后资料页都与 `558a8ba1f` 之前相同。所以 `558a8ba1f` 没有改变任何 P0 截图，本批没有可以归因、登记的截图变化。

## 登记清单

**没有登记。** 吸收 main 和补固定响应都没有改变任何 P0 截图（上节），资料页等截图都不需要新的 main 漂移参考：
- `reference/` 仍是 164 条，`accepted/` 仍是 12 条，两层都没有改动；
- 没有因被替换的期望变化而失效的已接受条目，不需要重登（运行的期望组装照旧 `88 P0.2 originals, 152 main drift references, 12 accepted migration differences`，globalSetup 的校验都通过）；
- 没有归因不到 main 的截图变化，缺口为空。

## 验证

### 两轮完整 P0：`0efaf2234`

- **树**：`0efaf2234`，即项目 tip `7732f14f8` 加本批的 `5d7801e47`（固定响应）和 `0efaf2234`（规则）。项目 tip 和 `origin/main` 在两轮期间都没有变。之后的提交只在本目录增加证据文件，不改 `src/`、`reference/`、`accepted/`。
- **命令**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，放在独立网络命名空间里（[round.sh](tools/round.sh) 调用 [netns-regression.sh](tools/netns-regression.sh)），紧接着跑两轮。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（作业 `bgj_35ed9d133430`，11:54–11:59 UTC） | 112 个测试：101 通过、11 个已记录的跳过、**0 失败**、0 flaky，退出码 0 | [checks/final-round-1](checks/final-round-1/summary.json)（含 `report.summary.json`、`command-output.txt`、`sources.json`、`profile-requests.json`） |
| 第 2 轮（同一作业，紧接其后，11:59–12:03 UTC） | 同上，112 个测试逐个状态相同 | [checks/final-round-2](checks/final-round-2/summary.json)、[两轮对照](checks/final-rounds-compare.json) |

- 两轮的期望组装都输出 `P0 expected screenshots: 88 P0.2 originals, 152 main drift references, 12 accepted migration differences.`，环境记录与 P0.2 逐字节相同（`fe69e824…`），工作树干净。
- **101 个通过**：pages 56（含 profile 8 个）、states 16、断点 4、P2.3 生产通知 8、P0.2-FOCUS-1/2 16、性能 1。
- **profile 8/8 通过**：每个用例正好请求 1 次 `GET /api/auth/methods`，`unhandled` 为空，`pageErrors` 为空，profile 和 profile-validation 两张截图都对照第 2 批的 A6 参考通过（[profile-requests.json](checks/final-round-1/profile-requests.json)）。开工时没有执行到的页面异常检查，在这里执行并通过。
- **结果只含已记录的处置**：11 个跳过就是 7 个非参考项目的性能采样和 4 个手机项目的桌面断点巡检；没有预期失败（P0.2-FOCUS-1/2 已由 P3.2 修好，作为普通测试通过）；其余截图对照 P0.2 原图、main 漂移参考或已接受层，全部通过。

### 负对照

两次都在 `0efaf2234` 上，用临时提交改 `src/web/src/pages/ProfilePage.tsx`，跑 P0 原命令（[negative-control.sh](tools/negative-control.sh)），跑完回到原提交。临时提交只留在本地分支 `p0d3/negative-control-*`，不交付。

本批没有新登记的截图（见「登记清单」），所以 1px 负对照加在本批维护的页面上：资料页的两张截图都对照第 2 批登记的 A6 main 漂移参考（`d233a6cd0`）。它证明补了固定响应之后，资料页上超出参考内容的改动仍会失败。另一组证明固定数据校验没有因这条响应放宽。

| 对照 | 改动 | 结果 | 记录 |
| --- | --- | --- | --- |
| 1：资料页 1px | Basic information 卡片的 `marginBottom: 16 → 17`（[patch](checks/negative-control-1px/patch.diff)），其下的 Change password 卡片下移 1px | **profile.png 8/8 失败**，全部对照第 2 批的 A6 参考（`d233a6cd0`），Playwright 报告 1528–2537 像素。用例停在第一张截图，profile-validation 比较不到。其余 104 个测试与两轮正式回归相同：93 通过、11 跳过，没有别的失败。差异图只在 Change password 卡片及其下方（[chromium-light-desktop](checks/negative-control-1px/failures/pages.browser.mjs-profile-chromium-light-desktop/profile-diff.png)、[webkit-light-phone](checks/negative-control-1px/failures/pages.browser.mjs-profile-webkit-light-phone/profile-diff.png)）。临时提交 `814cb7a7a` | [checks/negative-control-1px](checks/negative-control-1px/summary.json) |
| 2：多一个未建模的请求 | 资料页多读一次 `GET /api/auth/methods-negative-control`（[patch](checks/negative-control-request/patch.diff)） | **profile 8/8 失败**，都停在用例结束后的固定数据校验，`unhandled` 正是 `['GET /api/auth/methods-negative-control']`，没有别的；`GET /api/auth/methods` 照常由新路由回答（每个用例 1 次，不在 `unhandled` 里），两张截图都截到并通过，`pageErrors` 为空（[profile-requests.json](checks/negative-control-request/profile-requests.json)）。其余 104 个测试：93 通过、11 跳过，没有别的失败。临时提交 `9102f8065` | [checks/negative-control-request](checks/negative-control-request/summary.json) |

### 合并检查

在 `0efaf2234` 上（工作树干净，负对照之后已回到该提交）运行项目的合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（[merge-check.sh](tools/merge-check.sh)，作业 `bgj_1ab88e22c258`），退出码 0：
- `tsc -b && vite build` 成功，保留原有的大 chunk 提示；
- Vitest **344 个文件、4379 个用例全部通过**，用时 276 秒。

[过滤后的输出](checks/merge-check/output-filtered.txt)保留了构建和 Vitest 的结果、汇总行；完整输出在 `output-full.txt.gz`。之后的提交只在本目录增加证据文件，不改 `src/`。

## 不变的部分

本批在 `7732f14f8` 之上有 3 个线性提交：
- `5d7801e47`：`src/web/ui-migration/fixtures.mjs` 加 4 行（一条路由和 3 行注释）；
- `0efaf2234`：p0-drift README「场景与固定数据维护」；
- 最后一个提交只在本目录增加证据文件。

核对办法：在本分支上 `git diff --stat 7732f14f8 HEAD -- docs/evidence/base-ui-migration/p0.2 docs/evidence/base-ui-migration/p0-drift/reference docs/evidence/base-ui-migration/p0-drift/accepted src/web/src src/web/ui-migration/{known-failures,pages,states,breakpoints}.browser.mjs src/web/ui-migration/{page-scenarios,session-scenarios,session-fixtures,harness,playwright.config,expected-screenshots,environment}.mjs` 输出为空。也就是说：
- P0.2 的 252 张原图、原断言、known-failures、截图比对选项和容差都没改；
- main 漂移参考层（164 条）和已接受层（12 条）都没改；
- 产品代码没改；`fixtures.mjs` 里已有的路由一条没动。

## 证据体积

按协调者 2026-10-07 12:09Z 起的作业指导「证据体积」：
- **Playwright 报告**：不提交 report.json 和 trace.zip，每次运行改交同目录的 `report.summary.json`（[report-summary.py](tools/report-summary.py)）：只删附件正文，用例标题、项目、状态、耗时、重试、错误信息和附件路径都保留。tip-start、两轮正式回归和两组负对照各删掉 32 个附件正文：P2.3 生产通知用例的 16 个观测（notification-appearance、production-notification）和 P0.2-FOCUS 用例的 16 个焦点观测（known-focus-failure）。归因运行没有附件正文。
- **逐用例 JSON 和截图**：只提交本 README 引用到的：
  - profile 用例的 evidence.json，每次运行摘成一份 `profile-requests.json`，原文只留 tip-start 的 chromium-light-desktop 一份作样例；
  - 截图只提交负对照 1 的两张差异图，以及 `106c25fc2` 第一次运行的并排图；
  - 252 张截图的逐张比较结果在 [compare/](compare/) 和 [attribution/per-screenshot.md](attribution/per-screenshot.md)，每次运行的截图哈希在各运行的 `snapshots.sha256`。
- **体积**：本目录 约 5.9 MB、152 个文件（含本 README），不到 30 MB。本批没有登记截图，`reference/` 和 `accepted/` 没有新增文件。
- **完整原始运行**：截图、报告原文、trace 和全部 evidence.json 留在 `/var/tmp/p0d3/runs`、`/var/tmp/p0d3/checks`，到证据判定后再清理。构建用的精简树和运行器目录（`/var/tmp/p0d3/trees`、`runners`）交证据前已删除。

## 缺口与边界

- **本批没有截图登记**：吸收 main 和补固定响应都没有改变 P0 截图，所以没有新的参考图，也就没有「新登记截图」可做 1px 负对照。负对照改为加在资料页（对照第 2 批的 A6 参考），并另做一组固定数据校验的对照。
- **固定响应只覆盖默认状态**：P0 账号的 `/users/me` 没有 `signInMethods`，补的 `/auth/methods` 又是 Google 登录关闭，Sign-in methods 卡片在 P0 里不会画出。卡片本身的外观（Google 开启、已绑定、无密码等状态）不在 P0 覆盖范围内，由 `558a8ba1f` 自己的 `ProfilePage.signInMethods.test.tsx` 等单测覆盖；P4.1 迁移资料页时如需 P0 覆盖这张卡片，要另加场景和固定数据，不属于本批。
- **请求次数随时间变化**：不补固定响应时，501 会被 React Query 重试一次（`retry: 1`），所以同一用例记录到的请求是 1 或 2 次。归因只看「有没有这个请求、`unhandled` 里有没有别的」，不看次数。
- **精简构建树**：候选提交没有建完整工作树，而是用 `git archive` 取出的精简树加共享依赖。用 tip 核对过产物与正常构建逐字节相同，但没有对每个候选提交都和完整工作树比较。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。
- **临时路径**：`tools/` 里的脚本写着 `/var/tmp/p0d3` 和本工作树的路径，复跑时需要按环境调整。完整原始运行在判定前留在 `/var/tmp/p0d3`（见「证据体积」）。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
```

归因复算：
- 构建：`tools/prepare-tree.sh <提交> [标签]`；
- 运行器：`tools/make-runner.sh <提交> <名字> <同 shared 的已构建树>`；
- 单次运行：`tools/run.sh <树> <运行器> <标签> [playwright 参数]`；
- 请求链：`python3 tools/fixture-chain.py <out.json> <运行标签>...`；
- 截图对照：`node tools/compare.cjs <目录A> <目录B> <out.json>`，资料页汇总 `tools/profile-rows.py`。
