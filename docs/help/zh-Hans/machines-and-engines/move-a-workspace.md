---
title: 把工作区移到另一台机器
summary: 一个工作区属于一台机器；下面说明如何在别处继续工作。
---

工作区是一台机器上的文件夹。它的设置页面在 **Machine** 下显示那台机器；没有移动按钮，因为文件夹、它的文件和 Git checkout 都在那台机器的磁盘上。

## 把工作带过去

1. 确保工作在新机器能拿到的地方：推送到仓库，或合入 main。
2. 在新机器上，把仓库克隆到 Runner 的用户可写入的文件夹。
3. 在 **Settings** 中按 **New workspace**，选择新机器，并把 **Working directory** 设为那个文件夹。给它一个能区分开的名称，例如 `site (gpu-01)`。
4. 在那里启动新的会话。

## 什么会移动，什么会留下

- **会移动**（因为它在 Orbit 里）：项目、任务、Wiki、你的供应商密钥和账户池。
- **留在旧工作区**：它的会话及其对话记录、旧机器上未提交的文件，以及旧机器的引擎登录状态。在新机器上重新登录引擎。

## 无法在当前机器运行的会话

当 Claude 在机器所在地区不可用时，会话卡片会提供 **Move to another machine**，以及 **Use another provider** 和 **Check again**。它移动的是这一个会话，不是工作区。

## 停用旧机器

当它上面不再运行任何东西时，打开机器的 **Actions** 菜单并选择 **Delete**。

完整指南：[Onboarding, step 3](../../../onboarding.md#3-create-the-first-workspace)。
