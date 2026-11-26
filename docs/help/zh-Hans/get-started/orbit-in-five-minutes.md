---
title: 五分钟了解 Orbit
summary: 机器、工作区、会话和任务，以及它们如何配合。
---

Orbit 给编码 Agent 一台电脑和一个任务，并把对话及其结果保存在一个地方，在 Web 和手机上都能看。

## 你会用到的四样东西

- **机器。** 运行 Agent 的电脑：你的笔记本、Linux 主机或服务器。它运行一个小程序 Runner，以及安装在它上面的引擎（Claude Code、Codex、Cursor 等）。机器列在 **Settings → Machines** 下。[Runner 与服务器如何协同工作](orbit:/help/machines-and-engines/how-runners-and-the-server-work) 说明了它们如何连接。
- **工作区。** 一台机器上的一个文件夹，通常是 Git 仓库。每一次 Agent 对话都发生在某个工作区内。
- **会话。** 在工作区里与 Agent 的一次对话。你写一条消息，Agent 开始工作，对话记录保留每条消息、每次工具调用和结果。
- **任务。** 一件有完成定义的工作。任务可以单独存在，也可以属于一个**项目**：项目是一个目标，带有一张任务图，由协调者推进，直到结果合并。

## 第一个小时怎么过

1. [添加机器](orbit:/settings/machines/new)：在那台机器上运行一条命令。
2. 连接模型：用 Claude 或 ChatGPT 订阅登录，或者添加 API 密钥。
3. 创建一个指向那台机器上某个文件夹的工作区。
4. 启动会话，描述你想要什么。
5. Agent 请求时处理审批，然后查看结果。

## 需要你的东西出现在哪里

- 问题、确认和审批卡片出现在提出它们的会话里。会话列表中对应那一行会出现琥珀色圆点并说明它要什么，例如 **Decision for you**。
- 要求登录的终端会在 **Settings → Machines** 下它所属机器的页面等待；需要你处理的定时运行会在 **Scheduled** 页面等待。
- [找到需要你处理的事](orbit:/help/projects-and-tasks/find-what-needs-you) 列出了所有类型。
- 手机可以通知你；参见通知那篇文章。

完整指南：[Onboarding, step by step](../../../onboarding.md)。
