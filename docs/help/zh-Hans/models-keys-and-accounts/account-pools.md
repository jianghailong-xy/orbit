---
title: 账户池
summary: 把多个账户放在一个名字下，每个会话从还有额度的账户开始。
---

账户池是放在一个名字下的多个账户。选择池而不是单个账户，Orbit 会为每个会话挑选账户。

## 池如何挑选

- 由你的订阅组成的池：每个会话从额度最早重置的账户开始，并一直用它，直到用完。你的额度一点都不会浪费。
- 由 API 密钥组成的池：每个会话从余量最多的密钥开始。

## 创建

1. 打开 [Settings → Account pools](orbit:/settings/providers/pools) 并按 **New pool**。
2. 在 **New account pool** 中，选择 **Engine**，给它一个 **Name**，并选择 **Who can use it**：**Just me** 或 **Me and people I add**。
3. 勾选要包含的 **Accounts**：在你机器上登录的订阅和 API 密钥。
4. 按 **Create pool**。

如果你有多个 Claude 订阅，页面会建议：“Pool them, and each session starts on the one whose quota resets soonest”。按 **Create a pool**。

## 使用

启动会话时，在输入框的 **Provider** 菜单中选择池。

## 分享池

选择 **Me and people I add** 时，你添加的人可以在池的账户上运行他们自己的会话。

完整指南：[Runner CLI: providers](../../../runner-cli.md#providers)。
