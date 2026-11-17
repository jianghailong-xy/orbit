---
title: Share a session
summary: Make a read-only link to a session, choose what it includes, and turn it off again.
category: workspaces-and-sessions
routes: [/workspaces/:id/*, /sessions/:id, /settings/shared-links, /s/:token]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

You can let anyone with a link read a session. Viewers need no sign-in, and they cannot reply or change anything.

## Make a link

1. Open the session and press **⋯** in its header, then **Share…**. (You can also use **Share…** on the session's row in the list.)
2. Under access, choose **Anyone with the link**. **Only you** keeps it private.
3. Check what it includes: **Messages** and **Tool calls and output**.
4. Choose when it **Expires**: **Never**, **1 day**, **7 days** or **30 days**.
5. Press **Copy**. The link looks like `https://your-orbit-server/s/…`.

Shared links are live: viewers see new messages as they happen. A shared session's row shows **Shared · anyone with the link**.

## See and manage every link

[Settings → Shared links](orbit:/settings/shared-links) lists everything you have shared, under **Active**, **Paused** and **Ended**, with how many views each has had.

- **Copy link** copies it again.
- **Settings…** opens the link's share settings again.
- **Turn off…** ends it. Anyone who has the link loses access right away.
- An expired link offers **Share again**.

## Trash pauses a link

Moving a shared session to Trash pauses its link. **Restore to Open** turns the link back on.

Full guide: [Onboarding, step 4](../../onboarding.md#4-start-a-session-and-watch-a-turn).
