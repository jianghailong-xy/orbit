---
title: Orbit on Android
summary: Install the APK, sign in to your server, and follow your agents from an Android phone.
category: phone-and-desktop-apps
routes: []
errors: []
platforms: [android]
common: false
updated: 2026-11-17
---

The Android app shows the same account as the web: workspaces and sessions, projects, tasks and lists, the wiki, watches and machines. It needs Android 10 or later.

## Install it

Each Orbit release attaches a signed APK, `orbit-android-<version>.apk`, to its GitHub Release. Download it on the phone and open it; Android asks you to allow installing apps from that source once. After that, the app offers new versions itself.

## Sign in

1. Open the app and enter your **Email** and **Password**, or use **Continue with Google** if your server offers it.
2. To use a self-hosted server, change the server address from the sign-in screen the same way as on iPhone: type the **Server address** your administrator gave you and save it. The default instance is `orbitd.io`.

## Settings

**Settings** starts with **Machines & models**, then **Preferences** (Sessions, Notifications, Appearance), **Account** (Email, Instance, Shared links, Access tokens, Change password, Admin for administrators), **About** and **Sign out**. Terminals asking to sign in are approved on their machine's page under **Machines & models**, where approved terminals are listed with **Revoke**; a new request shows a one-time **Approve a terminal** toast.

::: platform android

## Notifications

If **Settings** shows **Notifications are off**, tap **Turn on** and allow notifications when Android asks. Once they are on, manage categories in Android's own settings for Orbit. See [Notifications](orbit:/help/phone-and-desktop-apps/notifications).
:::

## Offline

The app keeps the lists and sessions it last loaded, so you can read them without a connection. Changes need a connection.

Full guide: [Onboarding, step by step](../../onboarding.md).
