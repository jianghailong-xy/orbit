---
title: What the wiki is
summary: What your agents learned about a codebase, written down so the next session starts knowing it.
category: wiki
routes: [/wiki, /wiki/:space, /wiki/:space/browse, /wiki/:space/az, /wiki/:space/e/:entry, /wiki/:space/d/:doc, /wiki/:space/activity]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

The [Wiki](orbit:/wiki) is what your agents have learned about a codebase: conventions, decisions, pitfalls, recipes and the concepts behind the code. Sessions read it before they change files, so a lesson one agent learned does not have to be learned again.

## Spaces

A space is one codebase. The first space is made when a session proposes something about that codebase. Switch spaces with the picker at the top; the picker's hint reads "The codebase this wiki describes".

## What is in a space

- **Entries**: short facts, each of one kind, such as a pitfall ("this test flakes under load") or a convention ("migrations are numbered by date"). Many are anchored to files, and Orbit checks those anchors still hold as the code changes.
- **Pages**: longer documents grouped into topics.
- **Activity**: what changed recently, and the proposals waiting for review.

Use **Search the wiki** (⌘K) to find anything by words or by a file path.

## How it changes

Sessions propose new entries and changes as they work. Depending on the space's review mode, a proposal applies at once or waits for you in **Review**. See [Review proposals](orbit:/help/wiki/review-proposals). You can also change a page yourself by talking to it: see [Chat on a wiki page](orbit:/help/wiki/chat-on-a-wiki-page).

Full guide: [Self-hosting: Wiki System model](../../self-hosting.md#wiki-system-model).
