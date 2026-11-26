---
title: 安装或更新引擎
summary: 从机器页面安装 Claude Code、Codex、Cursor CLI、Kimi Code、OpenCode、DeepSeek Harness 和 Antigravity CLI。
---

引擎是会话运行的编码 Agent 程序：**Claude Code**、**Codex**、**Cursor CLI**、**Kimi Code**、**OpenCode**、**DeepSeek Harness** 或 **Antigravity CLI**。每台机器运行安装在它上面的引擎。

## 安装

1. 打开 **Settings**，然后在 **Machines** 下打开那台机器。
2. 找到引擎。缺失的引擎会显示 **Not installed — Orbit can install it here**。
3. 按 **Install**。该行显示 **Installing…**，然后显示 **Installed**。如果失败，该行会显示 **Install failed** 和机器报告的内容；按 **Retry**。

机器必须在线。它会运行引擎自己推荐的安装程序。

## 登录

已安装的引擎需要一个账户来思考。它的行显示 **Signed in**、**Signed out** 或 **Unknown**。按 **Sign in** 并按面板操作：它会打开引擎自己的登录页面（Antigravity 是 **Sign in with Google**）。登录状态留在那台机器上。参见 [用订阅登录](orbit:/help/models-keys-and-accounts/sign-in-with-a-subscription)。

## 更新

引擎会自行更新：Runner 大约每 30 分钟检查一次。要立即更新，打开机器的 **Actions** 菜单并选择 **Update engines**。在机器终端中也可以运行：

```bash
orbit engine-update
```

## 从命令行

`orbit doctor` 列出每个引擎的版本、登录状态，以及 Runner 的服务能否找到它，并为缺失的引擎打印安装或登录命令。

## 如果会话说引擎缺失

引擎可能已安装到你的 shell，但没有出现在 Runner 服务的 PATH 中，或者安装在另一个用户账户下。以 Runner 的用户身份运行 `orbit doctor` 并对比。

完整指南：[Runner troubleshooting, section C](../../runner-troubleshooting.md#c-runner-is-online-but-a-task-cannot-start-its-runtime)。
