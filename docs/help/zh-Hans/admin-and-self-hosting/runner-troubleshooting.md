---
title: Runner 故障排查
summary: Runner 机器上的注册、心跳和引擎故障，以及每种情况要运行的检查。
---

在 Runner 机器上，用注册它的用户账户运行下面的每条命令。

## 首先，两条命令

```bash
orbit status    # 注册信息、服务器、心跳时间、版本
orbit doctor    # 引擎、登录状态、服务的 PATH
```

`orbit status` 会打印私有标识符和路径：分享之前先整理干净。

## 注册无法完成

- 在机器上检查服务器有响应：`curl -fsS https://your-orbit-server/healthz` 应打印 `ok`。
- 在登录正确账户的状态下，于过期前批准浏览器页面。页面过期时，从 **Register a machine** 复制一条新命令。
- 如果 `orbit status` 显示 "no runner registered"，再次运行安装命令。

## 已注册，但显示 Offline

- 间隔一分钟运行两次 `orbit status`；心跳时间应保持很小。
- 查看服务：Linux 上 `systemctl status <service>` 和 `journalctl -u <service> --since '10 minutes ago'`（名称在注册时打印过）；macOS 上 `launchctl list com.orbit.runner` 和 `tail -n 100 ~/.orbit/runner.log`。
- 日志中反复出现 `401` 表示 Runner 的凭据被撤销：用 `orbit register --server <url> --force` 重新注册。
- 超时或 TLS 错误表示机器无法访问服务器；修复网络，而不是重新注册。

## 在线，但会话无法启动引擎

- `orbit doctor` 应显示所选引擎已安装、已登录，并且在服务的 PATH 上可见。它会为任何缺失项打印安装或登录命令。
- 在你 shell 中可用、但在会话中不可用的引擎，通常位于不同的 PATH 或不同的用户下，而不是服务使用的那个。
- 登录正常之后出现额度或速率限制错误，是供应商的限制：等待重置或换一个账户。

## 磁盘空间不足

会话的 checkout 位于 `~/.orbit/worktrees` 下。长文指南说明了哪些可以安全清理。

## 提交问题之前

记录操作系统、Orbit 版本（`orbit status` 的第一行）、哪个检查失败以及时间。先移除令牌、验证码、私有地址和文件内容。

完整指南：[Runner troubleshooting](../../runner-troubleshooting.md)。
