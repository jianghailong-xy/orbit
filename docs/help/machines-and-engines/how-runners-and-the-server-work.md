---
title: How runners and the Orbit server work together
summary: What runs on orbitd.io or your own server, what runs on your machines, and how the two talk.
category: machines-and-engines
routes: [/settings/machines, /runners/register]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-26
---

Orbit has two parts. The server keeps the record, and runners do the work.

## The server

`orbitd.io` is the Orbit server we host. An organization can run its own instead, and then you sign in at its address. Either way, the server keeps your account, workspaces, sessions, tasks, approvals and transcripts. The web app and the phone and desktop apps all talk to it, so every device shows the same thing.

The server runs no agents.

## The runner

A runner is a small program on a computer of yours: a laptop, a Linux box or a server. When you [add a machine](orbit:/help/machines-and-engines/add-a-machine), you install it and enroll it with your account. The runner starts the engines on that machine (Claude Code, Codex, Cursor and others), and agents work in its folders with the access of the account that runs it.

Engine sign-ins stay on the machine. Model keys you add in Orbit are kept on the server and handed to an engine only when a session starts.

## How they talk

- **The runner always connects out.** It keeps a connection open to the server, so the machine needs no open port and no public address. A laptop behind a home router or a VPN works.
- **Work comes over that connection.** When you send a message or a task starts, the server tells the runner right away. The runner runs the turn and sends each step back, and the transcript fills in on every device.
- **Heartbeats.** The runner checks in every 30 seconds. After 90 seconds without one, its machine shows **Offline**. Messages sent in the meantime wait, and run once it is back. See [A machine shows Offline](orbit:/help/machines-and-engines/machine-offline).
- **Updates.** Runners download new versions from the server they are registered with and install them when they are idle.

On the machine, `orbit status` shows which server the runner is registered with and when it last checked in.

## A managed runner

Some servers can also run a runner for you, so you can start sessions without setting up a machine. It is listed under **Settings → Machines** as **Orbit Cloud**. When it is idle it goes to sleep and shows **Asleep**, not **Offline**. Sending a message wakes it, and its workspace and files are kept. Your own machines work the same way alongside it.
