---
title: 合并到 main
summary: 已完成任务的工作如何合入，以及什么时候合并到 main 会等你。
---

任务完成后，Orbit 会合入它的工作：把任务分支与最新代码合并，并在合并后的代码树上运行合并检查。只有通过的代码树才会被推送。

## 跟踪合入

任务会显示合入进行到哪一步：

- **Waiting to land**，检查运行时显示 **Landing**。
- 合并后显示 **Landed**，到达 main 后显示 **On main**。
- 没有新内容可合并时显示 **Already landed** 或 **Nothing to land**。

项目的 **Landings** 窗口列出每一次合入：哪些在进行、哪些在等决定、今天哪些已经合入。Orbit 会运行它们；那里没有需要你输入的东西。

## 把项目合并到 main

在独立分支上工作的项目，完成的分支会通过项目页上的 **Merge to main** 卡片合并到 main。

- **Merge to main** 立即合并。卡片随后显示 **✓ Merged into main**。
- **Not now** 留到以后。

在 **How it runs** 下打开 **Automatic** 时，协调者会在合并检查通过后合并分支，并给你一份可回退的凭证。项目直接合入 main 时，除非你在 Delivery 下选择了 **The agent pushes it**，否则合并仍会问你。

如果合入失败，参见 [合并失败时](orbit:/help/projects-and-tasks/when-a-merge-fails)。

完整指南：[Onboarding, step 5](../../../onboarding.md#5-organize-work-as-a-project-and-read-its-task-graph)。
