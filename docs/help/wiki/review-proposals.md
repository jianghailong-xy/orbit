---
title: Review proposals
summary: Accept, edit or reject what sessions propose for the wiki, and choose how much waits for you.
category: wiki
routes: [/wiki/review, /wiki/:space/review, /wiki/:space/settings]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

Sessions propose new wiki entries and changes as they work. Proposals that need a person wait in [Review](orbit:/wiki/review).

## Decide a proposal

Each proposal shows the entry, what it is based on and the session that proposed it.

- **Accept** applies it. Accepting makes it Confirmed.
- **Edit** lets you fix the wording before it applies.
- **Reject** turns it down. Pick a reason: **Not true**, **Not useful**, **Duplicate** or **Too specific**. The reason helps future sessions propose better.

An entry someone has challenged offers **Keep**, **Amend…** or **Retire…** instead.

"Nothing is waiting for you." means Review is empty.

## Choose how much waits for you

Open **Wiki settings** for the space (`/wiki/:space/settings`) and pick a **Review mode**:

- **Manual**: every change from sessions, maintenance and imports waits for you in Review.
- **Tiered** (the default): your own words and machine-checked entries apply at once; the rest show as Unreviewed and are not sent to agents.
- **Automatic**: the System model checks each change against its sources first. Supported changes apply, partly supported ones show as Unreviewed, and the rest are rejected with a reason.

With Automatic, **Spot-check Automatic** sends 1 in 200 of the changes it applied to Review, so you can see what it lets through.

Full guide: [Self-hosting: Wiki System model](../../self-hosting.md#wiki-system-model).
