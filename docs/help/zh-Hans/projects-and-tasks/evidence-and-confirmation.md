---
title: 证据与确认
summary: Agent 如何证明任务已完成，以及你如何确认或退回。
---

当 Agent 说一个任务完成时，它会附上证据：运行过的命令、它们的输出、截图、提交。任务不会因为 Agent 说完成就算完成；只有当它的完成定义被证明成立时才算完成。

## 在哪里看到

确认卡片出现在任务的会话里，会话列表中那一行会出现琥珀色圆点并显示 **Confirm for you**。通知或链接会直接打开到卡片所在的会话。在带协调者的项目里，协调者通常先做判断，只把需要人的那些交给你。

## 确认或退回

确认卡片会问 **Confirm this task is done?**。它显示 **WHAT COUNTS AS DONE** 和 **WHAT THE AGENT SAID**。

- 当证据表明任务要求的内容已经做到时，选 **Confirm done**。卡片随后显示 **Confirmed done**。
- 如果有缺失，选 **Chat about this**。在 **What's missing?** 框里写下缺什么。你的消息会发给 Agent，任务保持打开；卡片显示 **Asked for more**。

证据卡片会问 **Does this evidence settle the task?**，并列出 **WHAT IT HAS TO SATISFY**。它的按钮行为相同。你退回时，你的消息就是下一次尝试要瞄准的原因，所以请准确说明它必须展示什么。

## 为什么重要

确认任务可以解除等待它的任务的阻塞，并启动它的合入。如果你不确定，就退回：Agent 会再试一次，下游什么都不会开始。

完整指南：[Onboarding, step 5](../../onboarding.md#5-organize-work-as-a-project-and-read-its-task-graph)。
