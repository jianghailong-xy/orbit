# Scheduled page chat: manage every schedule from one conversation (product plan, 2026-11-26)

**Status:** proposal, not decided, nothing built. Builds on [scheduled-tasks-design.md](scheduled-tasks-design.md)
(cited as *S§n*) and the Wiki chat panel ([wiki-chat-design.md](wiki-chat-design.md), cited as *W§n*).

> Owner 11-26: on the Scheduled page, a press opens a Chat in a column on the right, so that I can manage all
> scheduled tasks through chat.

---

## 0. One page

1. **A Chat button on the Scheduled page opens a conversation docked on the right.** The list stays readable beside
   it. This is the Wiki chat's pattern (W§3, W§4.1) on another page: an ordinary session in a panel, with no new
   model loop and no new store.
2. **The chat covers the whole page, not one schedule.** "Pause both x1 checks", "move the engine bump to 07:00 on
   weekdays", "why did yesterday's run fail?", "make a new one that watches the Kimi changelog": each is one
   sentence, across every workspace the page lists.
3. **Nothing new about authority.** The chat changes schedules only through the existing tools (`schedule_update`,
   `_pause`, `_resume`, `_run_now`, `_run_stop`, `_end`, `_delete`, `_create`). The envelope (S§4) decides what
   applies at once with **Undo** and what waits on a card. A change is recorded as the person's (`changedBy = USER`,
   with their words as `askedText`), as from a change conversation (S§8.2).
4. **One panel hosts every schedule conversation.** The page-wide chat, a schedule's **Change…** (S§8.2), and the
   session a quick-add sentence starts (S§8.1) all open in this panel instead of taking you to another page. Today
   those three leave the page. With the plan they stay on it.
5. **What the chat does shows up in the list as it happens.** A changed row flashes once. Each change line in the
   chat names its schedule, and clicking the name selects that row and opens its inspector.
6. **It costs nothing until you speak.** Orbit draws the opening from the list, as Change… already does. The engine
   starts with your first words.

---

## 1. Today

| Piece | Today | What is missing |
| --- | --- | --- |
| Managing by chat | Works from **any** session: S§8.4 says "pause the Codex check until Monday" works from a chat | A place for it on the Scheduled page. Today you leave the page, find or open a session, and lose sight of the list |
| Change… | Opens `/schedules/:id/change` (`ScheduleChangePage`), then navigates to the session page | It leaves the page, and it covers one schedule only |
| Quick-add line | `POST /api/schedules/drafts` opens an ordinary session. The draft row's inspector has **Open conversation**, which leaves the page | The same |
| Docked chat | The Wiki page has one: `WikiChatPanel` + `SessionConversation` + `SessionComposer`, a FAB (`WikiChatFab`), open by default ≥ 1200 px, a history view, `?chat=` in the URL | Not reusable as-is. It is wired to wiki spaces (`wikiChatSpaceId`, draft cards) |
| Right side of the page | The inspector (`sched-inspector`), resizable (`useInspectorWidth`) | Room for a second column |
| Workspace for a create | `schedule_create` takes the calling session's workspace. `schedule_update({workspaceId})` moves one, and that needs **Allow** | A page-wide chat runs in one workspace but lists all of them (§5) |

---

## 2. Main flow (web desktop)

1. The header gets a **Chat** button at the far right of the tools row, after *Show past runs* (D1). With the panel
   open, the button shows as pressed. Pressing it again closes the panel.
2. The panel docks on the right at full height and pushes the list over. The inspector, when a row is selected,
   sits between the list and the chat (D2).
3. A new chat opens with Orbit's opening (§4.1), plus a *Runs in* line naming its workspace (§5). The composer is the
   session page's composer, as in the Wiki chat (W§4.1).
4. If a row is selected, the composer carries it as a removable chip: `⌗ Engine version bump ✕`. That is "you are
   probably talking about this one", sent as context and not as a limit (§4.2). Selecting another row swaps the
   chip. The person can remove it.
5. The person speaks. The agent reads (`schedule_list`, `schedule_get`, runs), acts through the tools, and answers.
6. Inside the envelope, the change applies at once. The chat shows the existing change line, the same one a session
   shows today (S§9.2 *Sessions*), with **Undo**. The row in the list flashes and re-reads.
7. Outside the envelope (more runs, longer runs, more access, another workspace), the existing card appears in the
   chat **and** in *Waiting on you*. **Allow** or **Decline** right there.
8. Destructive actions on more than one schedule (D4): one confirmation card in the chat, listing every schedule it
   touches, with a single press.
9. A plain question ("what runs tomorrow?", "why is x1 paused?") gets an answer with links to the rows and nothing
   changes. Going by how the Wiki chat is used (W§2), that will probably be the most common use.

---

## 3. The panel

Reuse, not a copy. The Wiki chat panel is split into a generic **docked chat panel** plus a per-page adapter:

| Part | Generic (shared by Wiki and Scheduled) | Scheduled adapter |
| --- | --- | --- |
| Frame | dock, resize handle, header (title → history, `+` new, `↗` open as full session, `✕` close) | — |
| Body | `SessionConversation`, `SessionComposer`, approvals, pending tray | the schedule cards and change lines already drawn by `ScheduleCards` |
| History | search, Open / Completed, row `⋯` (Rename, Open as full session, Complete, Move to Trash) | lists the account's **schedule conversations** (§4.3), not wiki chats |
| Context chip | chip row above the composer | the selected schedule |
| URL | `?chat=<session>` | same key |
| Opening | — | §4.1 |

- **Open by default?** No (D3): the Scheduled page is a list you glance at, and a chat that opens itself takes half
  of it. The panel opens on a press and remembers itself per device: if it was open when you left the page, it is
  open when you come back.
- **Width.** It docks at ≥ 1200 px, as the Wiki chat does. Below that width (and on a phone browser), it is a sheet
  over the page, and selecting a row from inside the chat closes the sheet and shows the inspector.
- **Which conversation the button opens:** the one waiting on you, else the most recent open schedule conversation,
  else a new chat (the Wiki chat's order, W§4.1).
- **Header status on the button** (from the Wiki chat FAB's four states, W§3, read from the conversation and never
  stored): at rest; a ring while a turn runs; an amber count while a card waits; nothing for "done", because a
  change line with Undo already says it.

---

## 4. The conversation

### 4.1 Opening

Drawn by Orbit from the page's data, before any engine starts (the Change… opening's mechanism,
`Session.scheduleChangeOpening`). For example:

```text
You have 4 scheduled tasks: 2 active, 2 paused, none failing.
Next: Engine version bump, tomorrow at 06:00 on orbit-ws01.

Ask me anything about them, or tell me what to change:
  · "Pause everything on orbit-ws04 until Monday"
  · "Why did the last engine bump run take 40 minutes?"
  · "Every weekday at 09:00, check the Kimi changelog and tell me what's new"

Time, days, what a task checks and how it reports change at once, and you can undo them.
More runs, longer runs, more access or another workspace need your Allow.
```

The examples come from the account's own schedules, using the same wording rules as the page's empty-state
examples.

### 4.2 What the agent knows

Each message reaches the engine with a control-plane note after the person's words (the `<orbit_schedule_change>`
mechanism, S§8.2), named `<orbit_schedules>`. It carries:

- the schedules the page lists (id, title, state, rule sentence, workspace, next run, revision, tag), capped at 50,
  with a count of any beyond the cap. The page's workspace filter is noted, but the agent may act on any of the
  owner's schedules;
- the selected schedule, when the chip is on;
- an instruction to act through the schedule tools, to ask back only for what only the person can decide, and to
  name each schedule it touches by title.

The note is the person's view at delivery time, so "the second one" and "this one" resolve. The agent still reads
fresh data through `schedule_get` before it changes anything, because the revision check of S§8.2 still holds.

### 4.3 What kind of session it is

A new run source, `SCHEDULE_CHAT`, alongside `SCHEDULE_CHANGE`:

- Like change conversations, it is **not** listed in the workspace's session list. It is reached from the panel's
  history and from *Waiting on you* when it holds a card (S§9.2).
- A **Change…** conversation (`SCHEDULE_CHANGE`) and a quick-add session also open in this panel. The history
  lists all three, each with its schedule's title as the second line where it has one. The quick-add session stays
  an ordinary listed session, as S§8.1 decided. It simply opens here too.
- The person can complete, rename or trash it like any session. One that was opened and left without a word leaves
  nothing behind (S§8.2).

### 4.4 Several schedules in one sentence

"Pause both x1 checks" is two `schedule_pause` calls. Each writes its own revision with its own Undo, as today. The
chat draws calls made in one turn as **one** change line: `Paused 2 schedules · x1 walkthrough version check,
x1-walkthrough version check · Undo`. Undo there undoes all of them, newest first. If one undo is refused (the
schedule moved on since), the line says which one and keeps the rest undone. Grouping is done when drawing, by turn.
The server stays one revision per change.

---

## 5. Which workspace it runs in

A page-wide chat lists schedules from every workspace but runs on one machine.

- **Runs in** = the workspace on the quick-add line (the picker the page already has). It is shown
  under the title of a new chat and folds away after the first message, as in the Wiki chat (W§4.1).
- **Reading and changing** need no particular machine: the tools work on any of the owner's schedules from any
  owner session (S§8.2).
- **Creating** in another workspace: today `schedule_create` always uses the caller's workspace. Add an optional
  `workspaceId` to `schedule_create`. The create card already shows *Runs in* and already needs a press, so naming
  another workspace adds no new authority. The agent cannot do the baseline check (S§8.1) for a workspace it is not
  in, so that card has no *Today* line, as S§8.1 already allows.
- If the workspace's machine is offline, the chat says so on the *Runs in* line, as the Wiki chat does (W§5.1), and
  offers the picker.

---

## 6. Other clients

Web first. Then, following the Wiki chat:

- **macOS / iPad (regular width):** a third column next to the inspector, opened by the toolbar's Chat button and
  remembered per device (UserDefaults).
- **iPhone:** a toolbar Chat button opens a sheet (medium and large detents). A schedule name in a change line
  closes the sheet and opens that schedule's sheet.
- **Android:** follows iOS: a toolbar action that opens a bottom sheet.

Mocks first, with iOS as the reference for layout (S§9.2).

---

## 7. Edges

- **Run sessions** cannot open or act in this chat. Their scope stays `SCHEDULE_RUN_SESSION_SCOPE`.
- **Run now from the chat** is a session's press, so it counts toward the session budget of S§8.4 and not the
  owner-interactive one. The chat says "Started" or explains the refusal (`SCHEDULE_OVER_BUDGET`).
- **Concurrent edits** (the inspector's Rename, another device) go through the existing revision check. A stale
  `schedule_update` is refused, and the agent re-reads and retries once.
- **Copy is English** (CLAUDE.md §5): every label and every word of the opening.
- **No new REST door changes a schedule.** The panel only opens sessions: `POST /api/schedules/chat {text,
  workspaceId}` mirrors `POST /api/schedules/:id/change`.

## 8. Not doing

- A form, or bulk-select checkboxes on the list. The sentence is the bulk action.
- Opening the panel automatically (D3).
- A separate store or model loop for the chat.
- Letting the chat widen an envelope without a card.

---

## 9. Decisions to make

| | Question | A (recommended) | B |
| --- | --- | --- | --- |
| D1 | Entry point | A **Chat** button in the header's tools row, because you asked for "a press" and the page's bottom right already holds the quick-add line and its workspace picker | The Wiki chat's round FAB at the bottom right, for consistency between pages |
| D2 | Inspector and chat together | Three columns: list · inspector · chat. Below 1440 px the list narrows to its minimum. Below 1200 px the chat becomes a sheet | One right column: the chat replaces the inspector while open. A row press brings the inspector back, and the chat folds to a tab |
| D3 | Open by default | No. Open on a press, remembered per device | Like the Wiki chat: open by default on wide windows |
| D4 | End/Delete across several schedules | One confirmation card in the chat listing them | Apply at once with grouped Undo (Delete has no Undo today, so this would add one) |
| D5 | Change… and quick-add | Open in the panel (one place for every schedule conversation) | Keep today's pages. The panel is only the page-wide chat |

## 10. Delivery (by cost)

1. **Server:** `SCHEDULE_CHAT` run source + migration; `POST /api/schedules/chat`, `GET /api/schedules/chat` (open
   conversation + opening); the `<orbit_schedules>` note; `schedule_create({workspaceId?})`; history query over
   the three schedule conversation kinds; specs for scope, the note's cap and the create card's workspace.
2. **Web:** split `WikiChatPanel` into a generic docked panel + the wiki adapter (with no change in behaviour, guarded
   by the existing Wiki chat tests); the Scheduled adapter (button, chip, opening, row flash, grouped change line);
   Change… and the quick-add line open in the panel (D5).
3. **macOS + iOS.**
4. **Android.**

Before step 1: a board in `docs/mocks/scheduled-chat/` showing (1) today vs the docked chat, (2) list · inspector ·
chat at 1440 and at 1280, (3) a grouped change line with Undo, (4) the multi-delete card, and (5) iPhone sheet, with
D1–D5 marked.
