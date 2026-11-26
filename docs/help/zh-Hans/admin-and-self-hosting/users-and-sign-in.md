---
title: 用户与登录
summary: 添加账户、重置密码、设置管理员，以及打开 Google 登录。
---

管理员管理谁可以使用这台 Orbit 服务器。Admin 在账户菜单里，只有管理员能看到它。

## 第一个管理员

在新服务器上，每个地址都会指向 `/setup`。在那里创建第一个账户的人就是管理员。之后没有公开注册。

## 添加用户

1. 打开 [Admin](orbit:/admin)。**Users** 页面列出每个账户。
2. 按 **Add user**，输入 **Email**，可选填 **Name (optional)**。
3. 按 **Create**。会生成一个一次性密码并只显示一次：私下交给那个人。

打开 Google 登录时，勾选 **Google sign-in only** 可以创建一个没有密码、只能用 Google 登录的账户。

## 管理账户

每个账户的 ⋯ 菜单提供 **Reset password**、**Make admin**（或 **Make member**）、**Disable**，以及在设置邮件后的 **Send welcome email**。禁用前会先询问你，并说明会停止什么。

## Google 登录

1. 打开 [Admin → Sign-in](orbit:/admin/sign-in) 并复制 **Authorized redirect URI**。
2. 在 Google Cloud 控制台中，创建一个 **Web application** 类型的 OAuth 客户端，并原样添加该重定向 URI。
3. 回到 Orbit，打开 **Allow signing in with Google**，粘贴 **Client ID** 和 **Client secret**，并选择 **Who can sign in with Google**：**Existing accounts only** 或 **Anyone with a Google account**。
4. 按 **Save**。

登录页面随后会提供 **Continue with Google**，在 Web 和各个应用中都是如此。密码始终仍然有效。

Google 需要公网域名上的 `https` 地址；`http://localhost` 是唯一的例外。

完整指南：[Self-hosting: Google sign-in](../../self-hosting.md#google-sign-in)。
