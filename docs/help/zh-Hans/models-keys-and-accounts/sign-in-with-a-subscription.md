---
title: 用订阅登录
summary: 使用你的 Claude 或 ChatGPT 方案而不是 API 密钥；登录状态留在那台机器上。
---

如果你有 Claude 或 ChatGPT 订阅，会话可以在它上面运行，而不是使用按 token 付费的密钥。你在运行引擎的机器上登录，登录状态留在那里：Orbit 的服务器永远不会收到它。

## 登录

1. 打开 **Settings**，然后在 **Machines** 下打开那台机器。
2. 找到引擎：Claude 方案选 **Claude Code**，ChatGPT 方案选 **Codex**，Kimi 选 **Kimi Code**。它的行显示 **Signed out**。
3. 按 **Sign in**。面板会提供 **Sign in to Claude Code**（或 Codex、Kimi Code）。
4. 按 **Copy Code & Open Sign-In Page**，在打开的浏览器标签页中登录供应商，如果需要代码就粘贴进去。**Copy sign-in link** 可以让你在另一台设备上完成。
5. 该行变为 **Signed in**。

新账户在欢迎卡片的第 2 步 **A model to think with** 做这件事。

## 一台机器上的多个账户

在引擎那一行按 **Add account** 登录第二个订阅。要让会话在额度用尽时在它们之间切换，把它们放进一个 [账户池](orbit:/help/models-keys-and-accounts/account-pools)。

## 退出登录时

供应商可以结束登录，例如在修改密码之后。该行会回到 **Signed out**，其上的会话会停止，你的设备会收到通知（**Engine sign-outs** 总是发送）。用同样的方式重新登录。

::: platform macos
在用户只通过 SSH 登录的 Mac 上，Claude Code 无法从 Runner 的服务中读取登录 Keychain，所以会显示为已退出。用机器的 **Sign in** 按钮重新登录；之后 Claude Code 会把登录信息保存在服务能读取的文件中。
:::

完整指南：[Runner troubleshooting, section C](../../../runner-troubleshooting.md#c-runner-is-online-but-a-task-cannot-start-its-runtime)。
