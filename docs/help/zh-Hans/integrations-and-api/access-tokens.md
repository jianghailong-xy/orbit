---
title: 个人访问令牌
summary: 让脚本或 orbit CLI 以你的身份操作，只拥有你授予的权限。
---

个人访问令牌让你的脚本和 `orbit` CLI 以你的身份使用 Orbit API。它写入的内容会记在你名下。请像对待密码一样对待令牌。

## 创建

1. 打开 [Settings → Access tokens](orbit:/settings/access-tokens) 并按 **New token**。
2. 在 **New access token** 中：
   - **Name**：用途，例如 "Nightly report script"。
   - **Access**：**Read-only**、**Read & write**，或 **Custom** 逐个选择权限范围。
   - **Workspaces**：保留 **All workspaces**，或限制到某些工作区。
   - **Expires**：**30 days**、**90 days**（默认）、**1 year** 或 **Never**。永不过期的令牌会一直有效，直到你撤销它。
3. 按 **Create token** 并复制。它只显示一次。

## 从 CLI 使用

在任何机器上，无论有没有 Runner：

```bash
orbit login                       # 在浏览器中批准；它为这台机器保存一个令牌
orbit login --with-token < token.txt   # 或者使用你在上面创建的令牌
orbit whoami
orbit api /api/tasks
orbit logout                      # 撤销令牌，然后忘记它
```

`orbit login` 会在浏览器中打开一个页面，显示令牌的名称、权限、有效期和发起请求的机器；在那里批准或拒绝。在 CI 中，设置 `ORBIT_USER_TOKEN`，而不是保存登录。

## 撤销

令牌列在 **Active** 和 **Revoked & expired** 下。不再需要令牌，或者它可能已经泄露时，立即撤销它。

## 令牌做不到的事

任何令牌都不能替你做你自己的决定：确认、证据裁定、审批、启动或结束项目、账户设置、管理，以及管理令牌。这些都在应用里。

`401` 表示令牌无效、已撤销或已过期。创建一个新的，或者重新运行 `orbit login`。

完整指南：[Runner CLI: personal access tokens](../../runner-cli.md#personal-access-tokens)。
