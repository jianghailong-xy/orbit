---
title: 后台作业
summary: Agent 在后台启动的长时间构建和测试运行，以及在哪里查看它们。
---

Agent 可以把长时间命令作为后台作业启动，例如构建、测试套件或开发服务器。作业由机器的 Runner 运行，而不是由 Agent 自己的进程运行，所以它能在回合之间继续，结束时 Agent 会被唤醒。

## 在哪里查看

- 输入框上方的 **Background processes** 托盘显示有多少个在运行，例如 `1 running · 3 total`。按 **Show processes** 列出它们及其状态：运行中、已完成、失败或已终止。
- 会话列表中，有作业在运行的会话会显示 **Background process running**。
- 作业结束时，对话记录会显示一张卡片，例如 **Background job finished** 或 **Background job failed**，Agent 会从那里继续。
- 闲置但仍有作业在运行的会话显示 **Running in background**，而不是“Waiting for your reply”。

## 作业遵循权限模式

作业以 Runner 的账户运行，位于引擎沙箱之外，所以 Runner 启动前会按会话的权限模式检查它：

- **Auto** 和 **Bypass** 会直接启动。
- **Default** 和 **Accept Edits** 会给你一张带命令的卡片：允许一次、始终允许或拒绝。你可以随时回答；你说同意时作业才会开始。
- **Plan** 和 **Don't Ask** 会拒绝，并说明可以改做什么。

## 停止作业

让 Agent 停止它。结束会话也会停止它的作业。

完整指南：[Runner CLI: permission modes, shell commands and background jobs](../../runner-cli.md#permission-modes-shell-commands-and-background-jobs)。
