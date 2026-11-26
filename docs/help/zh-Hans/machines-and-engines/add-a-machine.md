---
title: 添加机器
summary: 在 Mac、Linux 主机或服务器上安装 Runner，并把它注册到你的账户。
---

任何你能打开终端的电脑都可以运行你的 Agent。每台机器运行 Runner（一个小服务），以及安装在它上面的引擎。

## 注册

1. 打开 **Settings**。在 **Machines** 下按 **Register a machine**（**+** 按钮）。页面叫 **Add a runner**。
2. 选择 **macOS**、**Linux** 或 **Windows**，按 **Copy**，然后在新机器上运行命令：

   ```bash
   curl -fsSL https://your-orbit-server/install.sh | bash
   ```

   在 Windows 上，用 PowerShell：`irm https://your-orbit-server/install.ps1 | iex`。
3. 用应该运行 Agent 的用户账户运行它。Agent 会获得该账户对文件和凭据的访问权限，所以在共享机器上使用专用账户是个好主意。
4. 浏览器会打开以确认这台机器属于你。批准它。
5. 页面显示 **Runner online — "build-box" is ready**。按 **Machine settings** 查看，或按 **Start a session**。

::: platform ios
iPhone App 在 **Settings → Machines & models** 下列出你的机器。注册新机器需要它的终端；在那里运行命令，并在任意设备上批准浏览器页面。
:::

## 检查

在机器上：

```bash
orbit status    # 注册到的服务器，以及最后一次心跳
orbit doctor    # 找到的引擎、登录状态，以及服务的 PATH
```

## 在机器页面上

设置中每台机器的页面显示它是否 **Online**、当前运行多少个会话（相对于允许的数量）、它的引擎，以及 **Actions** 菜单：**Rename**、**Update Runner Now**、**Update engines**、**Refresh models**、**Rotate token** 和 **Delete**。

## 一台 Linux 服务器上的多个用户

管理员可以先用 `orbit host setup --server <url>`（以 root 身份）把机器设置一次；之后每个人在它上面注册自己的 Runner。参见长文指南。

完整指南：[Self-hosting: register a runner](../../self-hosting.md#4-register-a-runner)。
