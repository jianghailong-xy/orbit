---
title: 连接飞书或 Lark
summary: 用你自己的飞书或 Lark 应用作为 Orbit 的机器人，用于提醒，也用于在聊天中给 Agent 派工作。
---

你可以把你自己的飞书或 Lark 应用连接到 Orbit，作为它的机器人。Orbit 主动与飞书建立长连接，所以你的 Orbit 服务器不需要公网地址。

你的提醒，例如审批和已完成的会话，会通过机器人的私信送达。在你已连接的群里，@机器人 给它派工作。

## 开始之前

飞书机器人默认开启。如果 [Settings → Feishu](orbit:/settings/integrations/feishu) 显示 "An administrator has turned off Feishu bots on this Orbit server."，请让管理员打开 **Admin → Integrations → Allow accounts to connect Feishu bots**。

## 在飞书中设置应用

[Settings → Feishu](orbit:/settings/integrations/feishu) 会在 **Set up the app in Feishu** 下引导你：

1. 在飞书或 Lark 开发者控制台**创建一个自定义应用**，并添加机器人能力。在企业工作区中，发布通常需要管理员批准。
2. **授予这些权限**：从页面上的列表逐个复制。不要授予读取所有群消息的权限：只有 @ 机器人的消息才会到达 Orbit。
3. **先在 Orbit 中输入它的 App ID 和 App Secret**：粘贴到 **Your app** 并按 **Connect**。等 Orbit 显示应用已连接。密钥不会再次显示。
4. **切换到长连接**：在控制台中，通过长连接接收事件和回调，并订阅页面上列出的事件。控制台只有在 Orbit 连接后才允许保存，所以第 3 步在前。
5. **发布它**：选择谁可以使用该应用（至少包括你，以及你将使用的群的成员）并发布一个版本。

## 连接你的飞书账户

在 **Your Feishu account** 下按 **Connect your Feishu account**。把显示的验证码通过私信发给机器人，不要发在群里。验证码只能使用一次，且有有效期。卡片随后显示 **Connected**。

## 群

把机器人加入群。它会回复一张卡片；打开卡片即可在 Orbit 中连接该群。已连接的群列在 **Groups** 下。

## 移除

页面上的 **Remove app** 会断开机器人与 Orbit 的连接。

完整指南：[Feishu bot design](../../../feishu-bot-design.md)。
