# Runner 引擎行：把 “Unknown” 改成 “Couldn’t check”

2026-11-06。起因：用户 2014paulfrank@gmail.com 的截图里 Claude Code 四个账号全是 **Unknown**、顶上 `0 of 4 accounts available`、每行一个蓝色主按钮 Sign in，被读成“Claude 未登录”。实际是 runner 那一轮 **sign-in 探测没拿到答案**（10s 预算内 `claude auth status` 没回话 / Keychain 读不到），不是账号被登出。

- 那台机器 08:00:39Z 重启过 runner，重启后第一轮探测全部 Unknown，下一轮（≈08:05）就恢复 `auth=yes`；08:24 的用量读取也正常。
- 三态探针本来就是“拿不到答案不冒充已登录”，所以 Unknown 本身是设计内行为；问题在**文案和呈现**让它看起来像掉登录。

## 效果图

- `01-before-after.png`：今天 vs 改后（全部账号未应答）
- `02-mixed-folded.png`：部分账号未知、折叠态，以及“真正 Signed out”的对照
- `03-phone.png`：390px 手机宽度
- 源码 `mock.html` / `states.html` / `phone.html`，直接引用 `src/web/src/index.css` 与 UI 组件 CSS，按真实 DOM 结构摆版。

## 改法

| | 今天 | 改后 |
|---|---|---|
| 头部计数 | `0 of 4 accounts available` | 全未知：`couldn’t check 4 accounts`；部分未知：`2 of 4 accounts available · 2 couldn’t be checked` |
| 账号 badge | `Unknown` | `Couldn’t check` |
| 额度列 | `—` | `No reading` |
| Sign in 按钮 | 蓝色主按钮 | **行上不显示**；兜底入口放进 `⋯` 菜单（真正 Signed out 的行仍保留主按钮） |
| 行下说明 | 无 | `The runner didn’t answer the sign-in check this time. It tries again every 5 minutes; sessions can still start.` |
| 折叠头 | 可能只显示 `0 signed out` 或 next 账号的 Unknown | 有未知账号时 badge 说 `Couldn’t check`，计数行同样用具名句子 |

Tooltip：

- badge：`The runner didn’t get an answer from Claude Code’s sign-in check. The account may still be signed in.`
- `No reading`：`No quota reading — the sign-in check didn’t answer.`

### 为什么行上不再放 Sign in

“Couldn’t check” 不是“去登录”的信号；行上再放一个 Sign in，用户还是会把它读成掉登录（第一版效果图就是这个问题，owner 指出后去掉了）。

- 产品里没有“重新探测”的入口，Sign in 确实是唯一能触发一次重探测的动作（relay 结束时的兜底探测会刷新行），但那是兜底，不该摆在行上。
- 落地时把它放进该账号的 `⋯` 菜单（现在 `kind === 'in'` 才给 `onSignIn`，Unknown 行也要给），给“其实真掉登录了、但这一轮探测没答”的情况留一条路。
- 真正 `Signed out` 的行完全不变：橙色 badge、蓝色主 Sign in、`Sign in to see quota`、行下提示。

### 为什么不做“显示上次已知状态”

那需要在服务端保留上一轮 `auth`/quota 并在本轮未知时标注“上次看到的是 X”。数据模型和语义都要动（读到的状态不是当轮上报的），这轮先把“未应答”本身说清楚。

## 落地位置（web）

- `src/web/src/components/RunnerEngines.tsx`
  - `STATUS_TAG.unknown`：`Unknown` → `Couldn’t check`
  - `EngineRow` 的 meta 计数（约 L785）：未知账号数 > 0 时改走上面的两种句子
  - `AccountRow` 的 Sign in（约 L1300）与 `EngineRow.action()` 的 default 分支（约 L748）：`kind === 'unknown'` 时不渲染 Sign in，只留 `⋯`；`RunnerAccountMenu` 的 `onSignIn` 条件从 `kind === 'in'` 放宽到 `in || unknown`，兜底项进 `⋯`
  - `QuotaCell`（约 L455）：`kind === 'unknown'` → `No reading`；`statusOf` / `metaFor` / `QuotaCell` 都带一个 `signIn` 参数，OpenCode（`loginEngine === null`）保持原样
  - `FoldedAccounts`（约 L533）：未知账号 badge
  - 组头下新增一条 `.re-dup` 说明；`foldFromAnywhere` 的排除列表加上它（同 `.re-panel, .re-login-note`）
- `src/web/src/lib/runnerCopy.ts`：新增 `RUNNER_ENGINE_COULDNT_CHECK`、计数句、说明句，便于 Apple 端对齐。

Apple 端（`RunnerPageFormat.authStatus` / `RunnerPageCopy`）目前对 unknown 不画状态字；要不要同步这套文案单独决定，web 先按图落地。

## 没有动的

- OpenCode：Orbit 没有它的 sign-in 可接管，unknown 保持原来的 `Unknown` / `version · the CLI wouldn't say` / `—`，不套 “Couldn’t check”（web、Apple 都按 `loginEngine !== nil` 区分）。
- 已登录且额度耗尽的账号还是 `0 of 4 accounts available` + `Spent · resets …` —— 那是真话，不动。
- 真正 Signed out 的行：橙色 badge、蓝色主 Sign in、`Sign in to see quota`、行下“sessions can’t use …” —— 不动（见 `02` 最后一段）。
- `checked 29m ago` 仍是引擎更新检查的时间，不是登录探测时间；这轮不改。
