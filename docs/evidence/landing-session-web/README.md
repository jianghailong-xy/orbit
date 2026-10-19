# 落地会话页：真实控制台截图与测试

任务 34a140SNCzzuYh9InlvnA（web：落地会话页）。界面依据是 owner 2026-10-19 批准的 v4 效果图
`docs/mocks/landing-session/v4/05-landing-session-page.html`。左列与各入口（Landing 卡、作业清单、
合入卡、回执、任务页、待办卡、Landings 组、源会话标签）归 34bVVGk4SrMknliGplqbJ；本任务只交付
落地会话页本身，所以下面的对照只看主区。

## 截图怎么来的

不是手画的：`vite build` 出真实前端，按 `src/web/ui-migration/fixtures.mjs` 登录与铺底，再用
`page.route('**/api/**')` 只覆盖落地会话与它读的几条项目接口（`/sessions/:id`、
`/projects/:id/integration`、`/projects/:id/coordinator/status`、`/projects/:id/promotions/current`、
`/projects/:id/promotions/merged`、`/sessions/:id/landing/log`），其余 `route.fallback()`。时钟冻结在
2026-09-25 14:58:30 Asia/Shanghai，浏览器时区也是 Asia/Shanghai；1440×980 @2x。

```
mkdir -p /var/tmp/ls-shots && cp docs/evidence/landing-session-web/kit/capture.mjs /var/tmp/ls-shots/
cd <worktree>/src/web && npx vite build --outDir /var/tmp/ls-shots/dist --emptyOutDir
FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
  'ip link set lo up && cd /var/tmp/ls-shots && node capture.mjs'
```

`kit/capture.mjs` 是这次用的同一份脚本（它从 `WT` 指的工作树里取 `ui-migration` 的 fixtures 与
Playwright，产物写 `/var/tmp/ls-shots/out`）；`capture-report.json` 是它逐帧读回的 DOM 文本与
`fixtures.unhandled`（10 帧全部为空，没有一条请求落到未建模的兜底上）。

## 帧

| 文件 | 画的是 | 对照 v4 05 |
|---|---|---|
| `light-i-timeout-menu.png` / `dark-…` | 任务段超时，⋯ 菜单打开 | 唯一的 web 帧：三角与 `Timed out`、`No report for 23m · limit 10m`、谁在何时领的、停在哪一步、`Nothing was pushed — …`、卡上 Retry + Abandon、菜单 Open Task / Open Source Session / Open Coordinator / Abandon（后果一行）/ Retry、只读页脚 |
| `light-a-live.png` | 任务段运行中，检查在跑 | 05 a：头 28px、右边步骤时钟、预算条与 usually 刻度、绿色新鲜点、`Output 3s ago · Updated just now`、时间线里 `Merge check · live 2m 40s` 与深色输出尾（同一条 `landing/log` 读） |
| `light-e-check-timeout.png` | 检查作业超时 | 05 e：`A check pushes nothing — main is as it was.`、Re-run the check + Abandon、按钮下一行解释 |
| `light-d-merge-menu.png` | 合入轮、检查中，⋯ 菜单 | 05 d：Review Card、Open Coordinator、Cancel Merge（`Before the push only · stops at the runner’s next report`），没有 Open Task / Open Source Session |
| `light-c-merged.png` | 结案的一轮 | 05 c：`Merged into main`、提交、现在在 main 上的任务、`✓ Passed on the combined tree · 17m 41s`、`Landed exactly the tested tree 5e5bfca · as a merge commit`、`This landing is complete — nothing to type here.` |

每帧都有板与实拍（light + dark）并排：`compare-05-web.png`（05 的 web 帧）、
`compare-05-a.png`（05 a，检查在跑与实时输出尾）、`compare-05-e.png`（05 e，检查超时）、
`compare-05-i.png`（05 i，任务段超时与 ⋯ 菜单）。板在左，实拍在右；电话帧只对主区。

两处**不在本任务范围**的差异，对照时看主区而不是整页：

1. 左列：板上是项目 sessions 页（Landing 卡、Coordinator、Today），实拍是会话列表。两处入口都归
   34bVVGk4SrMknliGplqbJ。
2. 板上标题行上面还有一行项目面包屑（`‹ Wiki 服务端执行与 System model`），它属于从项目页进来的
   外壳；落地会话页只规定标题与 `Run by Orbit · runner <name>` 副标题。

## 测试

三个新文件（均在 `src/web`）：

- `src/lib/landingSession.test.ts` — 纯模型：按 `sessionKind` 的判别函数；§2.7a 的 4 s / 15 s / 结案停；
  五种活性 × 三种作业；超时的 `No report for Nm · limit Nm`、领取行与段尾 `No report from <runner> since …`；
  J12 的两种推送句与检查作业那句；时间线分节的服务器标题；门的出现与消失（`retryable`、
  `pushBoundaryPassed` 两个服务端事实、租约过期、结案、读不到服务端）；J-T8 叫停后的 `Cancelling`；
  页头与页脚；结案的结局卡。
- `src/components/LandingSessionView.test.tsx` — 渲染：路由后的整页、分节时间线（代、作业、领取、轮次、
  接管、交还）、检查输出展开与再收起、⋯ 菜单各门（Stop 过推送界线消失、合入轮没有 Stop Landing、
  租约过期只有 Abandon + 服务端给的 Retry / Re-run the check、没有 Copy Link）、读失败时
  `Update unavailable` 且不给门、被服务端拒绝时按原话写在卡下（`Retry failed — …`）、结案页。
- `src/components/WorkspaceView.landingSession.test.tsx` — 组合：按 GET 应答的 `sessionKind` 选渲染器
  （不是列表行的 `kind`），新页挂在工作区内、替掉整个会话主体，落地会话不订阅任何会话事件流。

三个文件共 60 个用例；`--reporter=verbose` 的一次运行逐条列出并通过。

门的两个事实由服务端给（`SessionLandingView.currentAttempt` 的 `retryable` 与
`pushBoundaryPassed`：前者就是 `readInFlightJobs` 给作业列表的同一个 `retryable`，后者由
`pushBoundaryPassed`（J-T4）按作业行算出）。网页只读这两个字段，不再自己从 `phase`、时间线或
`timedOut` 推断；`landing-session.pg.spec.ts` 新增一例在真实 PostgreSQL 上核对它们：
窗口内的领取 `retryable=false`、v2 的 PUSH 回报使 `pushBoundaryPassed=true`、静默过期后
`timedOut=true` 且 `retryable=true`。

两个时区都跑（落地的合入检查在 runner 本机时区 Asia/Shanghai 跑、不设 TZ）：

```
cd src/web
TZ=Asia/Shanghai npx vitest run --maxWorkers=2
Test Files  417 passed (417)
     Tests  5445 passed (5445)

TZ=UTC           npx vitest run --maxWorkers=2
Test Files  417 passed (417)
     Tests  5445 passed (5445)
```

服务端（这次为了让门只读服务端事实而改）：`src/shared/src/project-progress.ts` 的
`SessionLandingAttempt` 增加 `retryable` 与 `pushBoundaryPassed`，`landing-view.ts` 用
`readInFlightJobs` 的 `retryable` 与 `pushBoundaryPassed(job)` 填写。套件：

```
cd src/apiserver && npm test
ℹ tests 5353   ℹ pass 5353   ℹ fail 0

scripts/run-pg-spec.sh src/apiserver/src/projects/landing-session.pg.spec.ts \
  src/apiserver/src/runner-api/project-integration-read.pg.spec.ts
==== landing-session.pg.spec.ts tests=8 pass=8 fail=0 skipped=0
==== project-integration-read.pg.spec.ts tests=11 pass=11 fail=0 skipped=0
```

OrbitKit 的文案对照（Swift 6.1 容器，工作树只读挂载）：

```
docker run --rm -v <worktree>:/src:ro -w /src/src/macos/OrbitKit swift:6.1 \
  bash -c 'swift test --scratch-path /tmp/orbitkit-scratch --filter "CopyParityTests"'
Executed 422 tests, with 0 failures
```

clean-main 基线（同一 worktree，未改动时）：

```
TZ=Asia/Shanghai npx vitest run --maxWorkers=2
Test Files  414 passed (414)
     Tests  5385 passed (5385)
```


## 交付时的基线

- `origin/main`：`e7168b246175a18b4af1928aa2c5b2bf4a656297`
- 项目线 `origin/project/34a0e97BOc6shsNLJbIuM`：`2591ee394fc738486fcd9c1957fd29fc8a256e59`（评审期间从
  `6bafd23f624fd426e28be66f889c5b2dab77a425` 前进了一次——X-E5 的交付；本分支已把它 `merge --no-ff`
  进来并在合并后的树上重跑测试，交付前再在它之上做一个 `merge --no-ff`）
- 两者都无冲突：`git merge-tree --write-tree origin/main HEAD` 与
  `git merge-tree --write-tree origin/project/34a0e97BOc6shsNLJbIuM HEAD` 都以 0 退出并写出 tree。

原生的 iOS/macOS 页与入口不在这份证据里：本任务只交付 web 页，iOS/macOS 是
34a140U25oC0MeGvcIhY3，入口是 34bVVGk4SrMknliGplqbJ。
