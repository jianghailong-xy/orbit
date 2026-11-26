---
title: 任务无法合并到 main
summary: 合入冲突或合并检查失败意味着什么，以及如何让工作合入。
---

合入会把任务的工作与最新代码合并，并在合并后的代码树上运行合并检查。任一步失败时，什么都不会被推送，任务保留它的工作。

## 任务会显示什么

| 状态 | 发生了什么 |
| --- | --- |
| **Landing conflict**（“Could not merge · conflict”） | 任务的改动和更新的改动碰到了相同的行。 |
| **Landing checks failed**（“checks failed · exit N after …”） | 合并成功了，但合并检查在合并后的代码树上失败。 |
| **A check timed out on the combined tree** | 检查超过了时间限制。 |
| **Landing error**（“Stopped with an error”） | 其他原因让它停止，例如机器掉线。 |

合入页面还会说明是否有内容被推送。“Nothing was pushed” 表示 main 未被改动。

## 怎么做

1. 从任务或项目的 **Landings** 窗口打开这次合入并阅读失败原因。检查失败时，输出会显示哪个测试坏了。
2. 选择一个操作：
   - **Retry** 重新运行合入，例如在测试偶发失败或机器恢复之后。
   - **Re-run the check** 结束本次检查，并在同一个候选上排队下一次检查。
   - **Abandon** 只是结束它；工作回到你手上。
3. 对于冲突或真正的测试失败，修复方式是新的工作：让任务的会话或项目的协调者 rebase 到最新 main 并修复。用 **Open Task** 或 **Open Coordinator** 过去。

打开 **Automatic** 时，协调者会自己处理冲突和失败的检查；你会看到 **Coordinator is resolving it**。它处理不了时，卡片会显示 **It is yours**。

完整指南：[合并到 main](orbit:/help/projects-and-tasks/merging-to-main) 和 [Onboarding, step 7](../../onboarding.md#7-recovery-when-a-run-stops)。
