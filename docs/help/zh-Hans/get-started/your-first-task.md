---
title: 你的第一个任务：从开始到合并
summary: 从一个请求到 main 上的一处改动，以及途中会问你什么。
---

任务是一件有完成定义的工作。下面把整条路径走一遍。

## 1. 提出任务

最快的方式是在工作区里启动会话并描述改动。对于需要跟踪的工作，让 Agent 把它登记为任务，或者打开项目按 **New task**。创建任务时会先给你看一张卡片；你批准之前不会创建任何东西。

## 2. 让它运行

任务作为会话在工作区的机器上运行。从 **Tasks** 或它所在项目的 **Run queue** 打开来观看。如果 Agent 想运行需要你批准的命令，会出现审批卡片：**Approve**（回车）或 **Reject**。

## 3. 查看证据

当 Agent 说完成时，它会附上证据：运行过的命令、测试输出、截图。需要你确认的任务会在该任务的会话里显示卡片，会话列表中那一行会显示 **Confirm for you**。参见 [找到需要你处理的事](orbit:/help/projects-and-tasks/find-what-needs-you)。

- 当证据表明任务要求的内容已经做到时，选 **Confirm done**。
- 如果缺少什么，选 **Chat about this**。你的下一条消息会发给 Agent，任务保持打开。

## 4. 合入

任务完成后，Orbit 会合入它的分支：合并这些工作，并在合并后的代码树上运行合并检查。任务会显示 **Landing**，然后是 **Landed**，最后是 **On main**。在项目里，合并到 main 可能会在 **Merge to main** 卡片上等你。

如果合入失败，参见 [合并失败时](orbit:/help/projects-and-tasks/when-a-merge-fails)。

完整指南：[Clean-machine first-run checklist, step 5](../../../first-run.md#5-complete-a-small-task)。
