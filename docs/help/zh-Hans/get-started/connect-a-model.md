---
title: 连接模型
summary: 用你的 Claude 或 ChatGPT 订阅登录，或者使用 API 密钥。
---

Agent 需要一个模型来思考。有两种方式给它模型，而且可以同时使用。

## 订阅：Claude 或 ChatGPT

使用你已经付费的方案。你在运行 Agent 的机器上登录，登录状态留在那台机器上。

1. 在欢迎卡片上，第 2 步是 **A model to think with**。之后，在 **Settings → Machines** 下打开那台机器。
2. 选择引擎：Claude 选 **Claude Code**，ChatGPT 选 **Codex**。
3. 按 **Sign in**，按供应商的登录页面操作。
4. 该引擎所在行会变成 **Signed in**。

订阅有使用限制，例如 5 小时窗口。参见 [会话停止：账户额度用尽](orbit:/help/models-keys-and-accounts/account-out-of-quota)。

## API 密钥

按 token 付费，没有使用窗口。密钥保存在你的 Orbit 账户上，所以每台机器都能使用。

1. 打开 **Settings**。在 **Providers** 下按 **Connect a provider**。
2. 选择供应商，例如 **Anthropic**、**OpenAI** 或 **DeepSeek**，粘贴密钥，然后按 **Connect**。

[连接供应商](orbit:/settings/providers/new)

## 按会话选择

输入框会显示会话运行所用的引擎和模型，它的 **Provider** 菜单列出你的密钥和账户池。发送前在那里选择。

## 在机器上检查

`orbit doctor` 列出每个引擎及其登录状态，并为已退出的引擎打印登录命令。

完整指南：[Onboarding, step 2](../../onboarding.md#2-connect-the-first-runner)。
