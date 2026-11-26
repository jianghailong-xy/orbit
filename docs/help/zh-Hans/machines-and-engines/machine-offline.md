---
title: 机器显示为离线
summary: 为什么会这样，以及如何在一分钟内把它恢复。
---

当 Runner 90 秒没有签到时，Orbit 会把机器标记为 **Offline**。Runner 每 30 秒签到一次，所以这是错过了三次心跳。它上面的会话会等待，机器恢复后继续。

## 1. 电脑醒着吗？

休眠的笔记本是最常见的原因。唤醒它并等几秒钟。机器那一行显示 **Offline · last seen …**，告诉你它是什么时候安静下来的。

## 2. Runner 在运行吗？

在机器上，用注册它的用户运行：

```bash
orbit status
```

它显示 Runner 注册到的服务器，以及距离上次签到过了多久。间隔一分钟运行两次：心跳时间应该保持很小。

如果看起来不对，让它自检：

```bash
orbit doctor
```

## 3. 启动服务

Runner 作为服务运行。要重启它：

- **Linux**：`systemctl status <service>` 会显示它；服务名在注册时打印过。
- **macOS**：`launchctl list com.orbit.runner`；日志在 `~/.orbit/runner.log`。

如果你用 `--no-service` 注册，请在你保持打开的终端里运行 `orbit run`。

## 4. 仍然离线？

- 机器可能无法访问你的 Orbit 服务器（网络、VPN、防火墙或代理）。长文指南里有两个 `curl` 检查。
- 凭据被撤销的 Runner 会被拒绝。从 **Register a machine** 重新注册它。

## 更新不算离线

正在安装更新的 Runner 会显示 **Updating to 0.1.254**。它停止接受新工作，完成进行中的回合，然后自行安装并重启。

[打开机器](orbit:/settings/machines/:id)

完整指南：[Runner troubleshooting, section B](../../../runner-troubleshooting.md#b-enrolled-runner-stays-offline-or-heartbeats-stop)。
