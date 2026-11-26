---
title: 添加你的第一台机器
summary: 在你希望 Agent 工作的那台电脑上运行一条命令，Orbit 会自动进入下一步。
---

Agent 会在你连接的一台机器上运行：Mac、Linux 主机或服务器。在一台机器上线之前，Orbit 无处运行任何东西，所以新账户会从欢迎卡片开始。

## 连接机器

1. 在欢迎卡片上找到 **A computer to work on**。（之后也可以在设置里使用 [Register a machine](orbit:/settings/machines/new)，它会打开 **Add a runner**。）
2. 选择机器的操作系统：**macOS**、**Linux** 或 **Windows**。
3. 按 **Copy**，然后在那台机器上运行命令。在 macOS 和 Linux 上它看起来像：

   ```bash
   curl -fsSL https://your-orbit-server/install.sh | bash
   ```

4. 安装程序会把 `orbit` CLI 放到机器上，并打开浏览器确认这台机器属于你。请在登录同一个 Orbit 账户的状态下批准。
5. 保持终端打开，直到它显示服务已安装。它会在 Linux 上建立 systemd 服务、在 macOS 上建立 launchd 服务，所以关闭终端后 Runner 仍会继续运行。

页面会显示 **Waiting for it to connect… this page moves on by itself.** 你不需要刷新。

## 在机器上检查

```bash
orbit status
orbit doctor
```

`orbit status` 显示它注册到的服务器，以及距离上次签到过了多久。`orbit doctor` 列出它找到的引擎，并为缺失的引擎打印安装或登录命令。

## Orbit 替你启动的 Runner

有些服务器开启了托管 Runner。此时欢迎卡片会显示 **Orbit is starting one for you. You don't need to install anything.** 如果你更想连接自己的电脑，选择 **Use my own computer instead**。

## 如果没有自动进入下一步

参见 [机器显示为离线](orbit:/help/machines-and-engines/machine-offline) 或下面的长文指南。

完整指南：[Clean-machine first-run checklist](../../first-run.md#4-enroll-a-runner-and-authenticate-one-runtime)。
