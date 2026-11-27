---
title: 打开工作区
summary: 让 Orbit 指向你某台机器上的文件夹，这样 Agent 就有地方工作。
---

工作区是一台机器上的一个文件夹：Agent 在其中工作的目录。它通常是一个 Git 仓库。

## 创建

1. 打开 **Settings**。在 **Workspaces** 下按 **New workspace**（**+** 按钮）。
2. 选择机器。只有 **Online** 的机器才能创建新工作区。还没有机器时，你会看到 **No machines yet** 和一个 **Register a machine** 按钮。
3. 填写 **Location**：
   - **Name**：列表里显示的短名称，例如 `tea-cli builder`。
   - **Working directory**：那台机器上的绝对路径，例如 `/home/mia/code/site`。它必须存在，并且 Runner 使用的用户账户必须能写入。
   - **Repository URL**（可选）：留空时，Orbit 会从该文件夹的 `origin` 远程地址识别。它用于项目集成。
4. 按 **Create**。Orbit 会打开新工作区的设置页。

如果 Orbit 找到该文件夹的 Claude Code 历史，会出现 **Claude Code history** 区域，询问是否导入。

## 开始工作

工作区会出现在侧边栏的 **Workspaces** 下。打开它并按 **New session**。参见 [启动会话](orbit:/help/workspaces-and-sessions/start-a-session)。

## 须知

- Agent 以机器上 Runner 账户的权限运行，所以只给那个账户它应该接触的文件。
- 一个工作区位于一台机器上。要换机器，参见 [移动工作区](orbit:/help/machines-and-engines/move-a-workspace)。

完整指南：[Onboarding, step 3](../../../onboarding.md#3-create-the-first-workspace)。
