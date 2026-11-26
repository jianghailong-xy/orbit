---
title: Agent 需要你时收到通知
summary: 在你的设备上打开通知，并选择哪些事件提醒你。
---

Agent 常常在你不在时完成，或者卡在一个问题上。通知会告诉你的手机和电脑。

## 选择什么提醒你

[Settings → Notifications](orbit:/settings/notifications) 有两个开关。它们适用于你所有的设备：

- **When a session finishes**：当一次运行自行结束或彻底失败时，提醒你的设备。
- **When an agent asks for you**：让运行中的 Agent 自己提醒你的设备，用来问只有你能回答的事，或者报告你一直在等的东西。每个会话每分钟最多一次。

有些通知总是发送，因为每一个都在等你，或者是你设置的 watch：**Tool approvals**、**Projects waiting on you**、**Engine sign-outs** 和 **Watch matches**。

::: platform ios

## 在这台 iPhone 上允许

打开 **Settings → Notifications**。在 **This iPhone** 下，**Allow notifications** 会打开 iOS 设置；在那里为 Orbit 打开通知。如果应用显示 **Notifications are off**，点 **Turn on**。
:::

::: platform android

## 在这台手机上允许

如果 **Settings** 显示 **Notifications are off**，点 **Turn on**，并在 Android 询问时允许通知。类别在 Android 自己的 Orbit 设置中管理。
:::

## 显示已允许，却收不到

- 检查手机的专注模式或勿扰设置，以及系统设置中是否允许 Orbit 的通知。
- 检查上面的两个开关。两个都关闭时，只有总是发送的那些类型会到达。
- 到请求等待的地方看看：会话列表中会话那一行显示琥珀色圆点和它要什么；要批准的终端在 **Settings → Machines** 下对应机器的页面中；需要你的定时运行在 [Scheduled](orbit:/scheduled) 页面。

完整指南：[找到需要你处理的事](orbit:/help/projects-and-tasks/find-what-needs-you)。
