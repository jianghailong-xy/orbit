---
title: 电子邮件
summary: 通过 Resend 向新账户发送欢迎邮件。
---

Orbit 只发送一种邮件：给每个新账户的欢迎邮件，通过 [Resend](https://resend.com) 发送。管理员设置之前它是关闭的。设置无需重启即可生效。

## 设置

1. 在 Resend 中添加并验证你将用来发送的域名，然后创建一个具有 **Sending access** 的 API 密钥。复制它；它以 `re_` 开头。
2. 在 Orbit 中打开 [Admin → Email](orbit:/admin/email)。
3. 在 **Resend API key** 下粘贴密钥。
4. 在 **From** 中填写已验证域名上的地址，例如 `Orbit <orbit@example.com>`。它的域名必须在 Resend 中验证过。
5. **Reply-To** 可选。留空时，回复会发到第一个管理员的地址。
6. 打开 **Send email from this deployment**，并保持 **Send a welcome email to new accounts** 开启。
7. 按 **Save**，然后按 **Send test email**。Orbit 会给你发一封简短的邮件，并显示 Resend 的回答。

## 会发送什么

在邮件开启之后创建的每个账户都会收到一封欢迎邮件。它说明如何登录和开始使用，且绝不包含密码、令牌或登录链接。对于较早的账户，在 **Admin → Users** 下它的菜单中使用 **Send welcome email**。

发送失败会重试。如果一直失败，**Admin → Users** 会在该账户下显示 **Welcome email failed**；悬停可看 Resend 的错误。**Admin → Email** 显示过去 7 天发送和失败的数量。

## 常见错误

| Resend 的回答 | 修复 |
| --- | --- |
| `403 — The example.com domain is not verified` | 在 Resend 中验证该域名，或使用已验证域名上的 From 地址。 |
| `401 — API key is invalid` | 创建一个新密钥并粘贴。 |
| `403 — You can only send testing emails to your own email address` | 验证一个域名并在 From 中使用它。 |

完整指南：[Self-hosting: configure outgoing email](../../../self-hosting.md#configure-outgoing-email)。
