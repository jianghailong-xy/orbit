---
title: Get notified when an agent needs you
summary: Turn on notifications on your devices, and choose which events alert you.
category: phone-and-desktop-apps
routes: [/settings/notifications]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-17
---

Agents often finish, or get stuck on a question, while you are elsewhere. Notifications tell your phone and computer.

## Choose what alerts you

[Settings → Notifications](orbit:/settings/notifications) has two switches. They apply to all your devices:

- **When a session finishes**: alert your devices when a run finishes on its own or fails for good.
- **When an agent asks for you**: let a running agent alert your devices itself, to ask something only you can answer or to report what you were waiting for. At most one per session per minute.

Some notifications are always sent, because each one waits on you or is a watch you set up: **Tool approvals**, **Projects waiting on you**, **Engine sign-outs** and **Watch matches**.

::: platform ios

## Allow them on this iPhone

Open **Settings → Notifications**. Under **This iPhone**, **Allow notifications** opens iOS Settings; turn notifications on for Orbit there. If the app shows **Notifications are off**, tap **Turn on**.
:::

::: platform android

## Allow them on this phone

If **Settings** shows **Notifications are off**, tap **Turn on** and allow notifications when Android asks. Categories are managed in Android's own settings for Orbit.
:::

## It says allowed, but nothing comes

- Check the phone's Focus or Do Not Disturb settings, and that notifications for Orbit are allowed in the system settings.
- Check the two switches above. Only the always-sent kinds arrive with both off.
- Look where the request waits: a session's row in the session list shows an amber dot and what it wants, terminals to approve are on their machine's page under **Settings → Machines**, and scheduled runs that need you are on the [Scheduled](orbit:/scheduled) page.

Full guide: [Find what needs you](orbit:/help/projects-and-tasks/find-what-needs-you).
