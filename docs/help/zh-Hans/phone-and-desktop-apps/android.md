---
title: Android 上的 Orbit
summary: 安装 APK，登录你的服务器，在 Android 手机上跟进你的 Agent。
---

Android 应用显示与 Web 相同的账户：工作区和会话、项目和任务及列表、Wiki、watch 和机器。它需要 Android 10 或更高版本。

## 安装

每个 Orbit 版本都会在 GitHub Release 上附带一个已签名的 APK：`orbit-android-<version>.apk`。在手机上下载并打开；Android 会要求你允许一次来自该来源的应用安装。之后，应用会自己提供新版本。

## 登录

1. 打开应用，输入 **Email** 和 **Password**，或者如果服务器支持，使用 **Continue with Google**。
2. 要使用自托管服务器，在登录界面像在 iPhone 上一样修改服务器地址：输入管理员给你的 **Server address** 并保存。默认实例是 `orbitd.io`。

## 设置

**Settings** 从 **Machines & models** 开始，然后是 **Preferences**（Sessions、Notifications、Appearance）、**Account**（Email、Instance、Shared links、Access tokens、Change password、管理员的 Admin）、**About** 和 **Sign out**。请求登录的终端在 **Machines & models** 下对应机器的页面中批准，已批准的终端列在那里并带有 **Revoke**；新请求会显示一次性的 **Approve a terminal** 提示。

::: platform android

## 通知

如果 **Settings** 显示 **Notifications are off**，点 **Turn on**，并在 Android 询问时允许通知。打开后，在 Android 自己的 Orbit 设置中管理类别。参见 [通知](orbit:/help/phone-and-desktop-apps/notifications)。
:::

## 离线

应用会保留上次加载的列表和会话，所以没有连接时也能阅读。更改需要连接。

完整指南：[Onboarding, step by step](../../onboarding.md)。
