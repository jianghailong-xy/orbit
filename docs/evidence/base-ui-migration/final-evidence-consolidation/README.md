# 收尾并入：P7.1/P7.2 证据目录进项目线

服务于任务 [收尾并入：P7.1/P7.2 证据目录进项目线；P3.3 报告与 P1.1/P1.2 提交号补齐](orbit-task:34drbkA2TPuREKzGS0FUh)，项目「Orbit Web 组件迁移：Base UI + Orbit 自有组件」（[34ZZeq0e3IR65GVm2kAs7](orbit-project:34ZZeq0e3IR65GVm2kAs7)）。

**背景**：[P7.2 复核](orbit-task:34Za39UxopXFSlSSCGBZG) 的证据在其「缺口与遗留」（第 2–4 条）里列出三件只在分支或评论里的记录：P7.1 的证据目录只在分支 `orbit/task-p7-1-41e8e5` 上、P3.3 的报告没有独立证据目录、P1.1/P1.2 的交付提交 SHA 没写进各自 README。本任务做一次只改 `docs/` 的收尾并入，让最终记录在项目线与 main 上可读；不改 P0.2、登记层与产品代码，不推送。

## 并入清单

| # | 目标路径 | 来源 | 来源提交 / 记录 | 体积 | 核对 |
| --- | --- | --- | --- | --- | --- |
| 1 | `docs/evidence/base-ui-migration/p7.1/` | 分支 `orbit/task-p7-1-41e8e5` | `f43d6e1a3`（最终证据提交；目录创建于 `e065ef2f1`） | 15 个文件、226,861 字节 | `git diff f43d6e1a3 -- docs/evidence/base-ui-migration/p7.1/` 为空（逐字节相同）；内容与 P7.1 任务记录逐项一致（见下） |
| 2 | `docs/evidence/base-ui-migration/p7.2/` | 分支 `orbit/task-p7-2-ab7883` | `1d4f92f88`（最终证据提交） | 24 个文件、680,675 字节 | `git diff 1d4f92f88 -- docs/evidence/base-ui-migration/p7.2/` 为空（逐字节相同） |
| 3 | `docs/evidence/base-ui-migration/p3.3/README.md`（新建） | 任务 `34Za39Br6OaoCg0nc1ipA` 的两条报告评论 | 评论 `34blLXmYE2ulikB82mAkt`、`34blLmYHN4zWCnqsAI0YS`（2026-10-07） | 27,236 字节 | 正文逐字转发；原件归档不可读，如实记为缺口（见下） |
| 4 | `docs/evidence/base-ui-migration/p1.1/README.md`、`p1.2/README.md` | 各加一节「交付提交（2026-10-11 补记）」 | 分支历史：任务分支 tip 与项目线落地提交 | 各一节 | SHA 与依据写在各 README 的补记一节 |

### 1. P7.1：并入内容与任务记录的一致性核对

并入的 `p7.1/` 与 [P7.1 任务](orbit-task:34Za39TCy7xMbhT6VYEyv) 的记录逐项核对：

- 交付提交 `09d94a12f4bb969d69edf75c208d8ab0f9777423`（tree `74bc29723…`）——`checks/commands.json` 的 `head`/`tree` 与任务记录一致；
- 三项命令退出码 0（build 2.14 s、test 196.6 s、ui-migration 169.4 s）——与任务记录一致；
- Vitest 402 文件 / 5,247 用例；`test:ui-migration` 101 通过、11 跳过、0 意外失败、0 flaky、0 重试；期望层 44 P0.2 + 165 main 漂移 + 43 已接受，252/252 张截图被断言——与任务记录一致；
- `checks/run2-commands.json` 是证据提交 `e065ef2f1` 上的第二遍运行（三项仍 0），与任务记录「在最终提交上又跑了一遍」一致；
- `choices` 757/760 的三条失败分类（2 条既有红 + 1 条 `net::ERR_NETWORK_CHANGED` 抖动，同提交重跑 3 次各 12/12）见 `checks/choices-failures.json` 与 `checks/choices-first-option-*`，与任务记录一致；
- `checks/main-dryrun.txt` 与任务记录「跟 main」一节一致。

本次是逐项阅读核对，没有重跑 P7.1 的命令——两次运行的原件按其 README 在 `/mnt/data/tmp/34Za39TCy7xMbhT6VYEyv/`，不在本目录。

### 2. P7.2：并入内容

并入的 `p7.2/` 与 [P7.2 任务](orbit-task:34Za39UxopXFSlSSCGBZG) 的记录一致：`checks/commands.json` 的 head `09d94a12f…` 与五步结果（build 0；vitest 0：402 文件/5,247 用例；ui-migration 0：101/11/0；choices 有界复核 46/2；foundation 48/48）、`checks/delivery-identity.txt` 的 tree 身份、README 里的保真复核/同条件收益/回退说明。这份 README 的「缺口与遗留」就是本任务要关的第 2–4 条。

### 3. P3.3：评论重建与不可读的原件

`p3.3/README.md` 由任务评论重建（正文逐字保留），整理日期 2026-10-11。评论里写的运行原件归档 `/root/.orbit/uploads/78dc8fb5-504a-5f2a-96c9-cacb3f1fc63e/p33/` 在整理时**已不可读**：账号 uploads 在会话结束时由平台删除，该目录现在不存在。`SHA256SUMS` 的逐文件校验、`runs/` 的运行原件与 `tools/` 的脚本因此不可复核——如实记为缺口，不补造。

### 4. P1.1/P1.2 交付提交

| 任务 | 交付提交（任务分支） | 所在分支 | 父提交（= README 写的起点） | 项目线落地提交 |
| --- | --- | --- | --- | --- |
| P1.1 | `703b8f6ce4c75d8975ed867e9808f0f0198716f8` | `orbit/p1-1-base-ui-orbit-8c2c1b`（tip） | `6bbf3ecc3` | `5bea0a3f6`（在 main 历史里） |
| P1.2 | `66cc6cbf0b0884e10c2374a34e6be19b78bbe7b2` | `orbit/p1-2-orbit-e7d654`（tip） | `5bea0a3f6` | `297d33e97`（在 main 历史里） |

依据：两个交付提交都是各自任务分支的 tip（P1.1 的交付 SHA 见其任务评论 `34ZnF2k8ZifrHaPM1UEl3` 与进度 revision 5；P1.2 见进度 revision 5 与集成评论 `34ZrGMI1HooAyKpg2KJBj`）。落地时两者被重写为项目线上的 `5bea0a3f6` / `297d33e97`：提交信息相同，文件清单与增删行数相同（P1.1：369 个文件、+258,964/−1；P1.2：338 个文件、+295,987/−4），对应证据目录 tree 逐字节相同（p1.1 `2b0fdd030…`、p1.2 `9d007e239…`）。任务分支提交本身不在项目分支/main 历史里——完整依据写在两个 README 的补记一节。

## 与 main 的关系（「跟上 main」）

- 开工时项目 tip `a55e9d113` 已是 `origin/main` 的祖先（`git merge-base --is-ancestor origin/project/34ZZeq0e3IR65GVm2kAs7 origin/main` 成立），按作业指导直接 rebase 到 `origin/main` `9f693cf8f`。
- `f43d6e1a3`、`1d4f92f88` 与 P7.1 的交付提交 `09d94a12f` 本身都不在 main 历史里；本次并入的是它们的内容（本目录所在的这一个 docs 提交），不是把旧提交接到项目线上。P7.1 的交付提交只用于确定「被测的 Web 输入」：其 `src/web` tree `31aaca562…` 与项目 tip `c04e79238` 相同，而该 tip 已在 main 上。
- 本次提交只改 `docs/`，无 `src/` 变化。

## 缺口（如实记录）

1. **P3.3 的原件归档不可读**（同第 3 节）：评论正文可读且已并入；`SHA256SUMS`、`runs/`、`tools/` 无法复核。
2. **两个任务的运行原件不在本目录**：P7.2 的完整原件（含带附件的原始报告与逐用例计算样式）按其 README 在 `/mnt/data/tmp/34Za39UxopXFSlSSCGBZG/`（注明「判定后清理」），P7.1 的在 `/mnt/data/tmp/34Za39TCy7xMbhT6VYEyv/`（到证据判定为止）；本次未搬运。
3. **真机验证仍未执行**：P7.2 缺口第 1 条（软键盘、输入法组词、触摸、手机返回的真机记录）按账号所有者决定放在部署之后、由本人在 `p5.3/real-phone-checklist.md` 上执行；本次未改变这一状态。
4. **两个源分支未合并**：`orbit/task-p7-1-41e8e5`、`orbit/task-p7-2-ab7883` 仍存在且未合入项目线（按任务要求不推送、不合并分支；证据内容已并入）。

## 复现与核对命令

```sh
# 逐字节核对并入的两个目录（都应为空输出）
git diff f43d6e1a3 -- docs/evidence/base-ui-migration/p7.1/
git diff 1d4f92f88 -- docs/evidence/base-ui-migration/p7.2/
# 交付 SHA 的分支历史依据
git log -1 703b8f6ce4c75d8975ed867e9808f0f0198716f8   # P1.1 任务分支 tip
git log -1 66cc6cbf0b0884e10c2374a34e6be19b78bbe7b2   # P1.2 任务分支 tip
# 项目线落地版本（证据目录 tree 与任务分支提交相同）
git rev-parse 5bea0a3f6:docs/evidence/base-ui-migration/p1.1
git rev-parse 297d33e97:docs/evidence/base-ui-migration/p1.2
# 本次提交的范围（只改 docs/）
git show --stat <本次提交>
```

本目录所在的提交号记录在任务 [34drbkA2TPuREKzGS0FUh](orbit-task:34drbkA2TPuREKzGS0FUh) 的评论里。
