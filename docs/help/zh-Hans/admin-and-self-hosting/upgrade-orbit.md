---
title: 升级 Orbit
summary: 把自托管服务器升级到新版本；Runner 会自行跟进。
---

自托管的 Orbit 服务器从它的部署 checkout 升级。随后 Runner 会从服务器自行更新。

## 升级服务器

1. 先阅读发布说明，并做一份经过验证的备份。
2. 在部署 checkout 中，检出发布版本并重新构建：

   ```bash
   git fetch --tags
   git checkout <release-tag>
   docker compose up -d --build
   ```

3. 服务器启动时会应用数据库迁移。保持 PostgreSQL 运行。

在带托管 Runner 或 Runner link 的部署上，改用仓库的升级脚本 `.claude/skills/upgrade/upgrade.sh`：它还会重建托管 Runner 镜像、设置 Runner link 并重建 gateway。

这些步骤保持 `.env` 不变。

## Runner 会跟进

每个 Runner 都从你自己的服务器下载更新。空闲的 Runner 大约 10 分钟内自行更新。忙碌的会等它的回合结束：它的机器页面显示 **Updating to …**，它停止接受新工作，完成进行中的回合，然后安装并重启。

要立即更新一个，在 **Settings** 中打开机器，并从它的 **Actions** 菜单选择 **Update Runner Now**。

## 不更新的 Runner

关闭了自更新（`ORBIT_NO_SELFUPDATE`）的 Runner，或者无法写入安装目录的 Runner，会停留在它的版本上。在那台机器上运行：

```bash
orbit upgrade
```

如果二进制安装在系统范围内，使用 `sudo /usr/local/bin/orbit upgrade`。低于 0.1.237 的 Runner 每次启动都会记录 "Run `orbit upgrade` to update this runner"。

## 应用

Mac 应用自行更新；Android 应用会提供新版本；iPhone 应用通过 TestFlight 更新。

完整指南：[Self-hosting: upgrading](../../../self-hosting.md#upgrading)。
