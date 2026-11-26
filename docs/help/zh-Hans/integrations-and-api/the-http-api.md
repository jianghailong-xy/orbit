---
title: HTTP API
summary: Web 应用使用的每条路由都对你的脚本开放，位于 /api 下，使用 bearer 令牌。
---

Web 应用、手机和桌面应用、`orbit` CLI 以及 Runner 都与同一个 HTTP API 通信。你的脚本也可以使用它。

## 基础

- **基础路径**：每条路由都以你 Orbit 服务器上的 `/api` 开头，例如 `https://orbit.example.com/api/tasks`。
- **身份验证**：用[个人访问令牌](orbit:/settings/access-tokens)发送 `Authorization: Bearer <token>`。令牌以你的身份操作，权限限于你授予的范围。
- **请求体和响应**是 JSON。拒绝会返回 HTTP 状态和 JSON 正文；许多还会带一个稳定的 `code` 和一个 `requiredAction`，说明可以改做什么。
- **ID** 可以是你在 Orbit URL 中看到的短形式，也可以是完整的 UUID。

## 第一次调用

```bash
curl -fsS -H "Authorization: Bearer $ORBIT_TOKEN" https://orbit.example.com/api/tasks
```

或者让 CLI 替你处理令牌和服务器：

```bash
orbit login
orbit api /api/tasks
orbit api /api/tasks/page --paginate --json
```

`orbit api` 会打印响应，并在非 2xx 时以非零状态退出。

## 令牌无法通过 API 做的事

你自己的决定，例如确认、审批和证据裁定，以及账户本身、管理和访问令牌，都在应用里。参见 [个人访问令牌](orbit:/help/integrations-and-api/access-tokens)。

## 每条路由在哪里列出

完整参考是从服务器代码生成的，所以始终与你运行的版本一致。它说明谁可以调用每条路由，以及它接收和返回什么。

完整指南：[External HTTP API reference](../../api-reference.md)。
