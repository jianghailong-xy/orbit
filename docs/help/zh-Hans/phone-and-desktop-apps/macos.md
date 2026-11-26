---
title: Mac 版 Orbit
summary: 原生 Mac 应用，如何安装和更新它，以及它与 Runner 的关系。
---

Mac 应用是你 Orbit 账户的原生窗口：项目、任务、工作区和会话、Wiki、机器和模型，以及设置。它是客户端：它本身不运行 Agent。

## 安装

每个 Orbit 版本都会在 GitHub Release 上附带一个已签名并公证的磁盘映像：`Orbit-v<version>-arm64.dmg`。打开它，把 Orbit 拖到 Applications。应用需要 Apple 芯片的 Mac。

## 更新

应用会自己检查新版本。要立即检查，打开 **Orbit** 菜单并选择 **Check for Updates…**。

## 登录

输入 **Email** 和 **Password**，点 **Sign In**，或者点 **Continue with Google**。对于自托管服务器，先在登录界面修改 **Server address**（参见 [iPhone 和 iPad 上的 Orbit](orbit:/help/phone-and-desktop-apps/iphone)，Mac 的做法相同）。

## 也在这台 Mac 上运行 Agent

要让 Agent 在这台 Mac 上工作，把它添加为机器：在 **Settings** 中打开 **Register a machine**，在终端中运行命令。Runner 是与应用分离的服务，所以应用关闭后 Agent 仍会继续工作。参见 [添加机器](orbit:/help/machines-and-engines/add-a-machine)。

::: platform macos
Mac 上的 Runner 是一个名为 `com.orbit.runner` 的 launchd 服务；它的日志是 `~/.orbit/runner.log`。
:::

完整指南：[Runner troubleshooting](../../../runner-troubleshooting.md#find-the-runner-logs)。
