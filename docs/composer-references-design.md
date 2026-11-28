# Pointing at a session: `#` and `@` in the composer, redesigned

Status: proposal, revision 2 (2026-11-28). Revision 1 gave every object kind equal standing and
made `@` a delivery everywhere. Production data (§1) says that was the wrong centre: what people
point at is **a session**, almost always by pasting its link, and almost always to ask the agent to
look into it. Tasks are created, run and commented on by agents; people do not reference them.
Nothing here is built yet. §8 lists the open decisions, each with a recommended default.

**Revision 3 (2026-11-28, owner's call): `@` = a session, `#` = a project.** This supersedes §3.2's
session-first `#` menu and §6. Board: `docs/mocks/session-at-references/` (01–06).

- **`@` lists your most recent sessions, by latest activity.** It covers every workspace and runner,
  task runs, coordinators and landings, but leaves out the current session. Status is a dot and a
  short label, and it never reorders the list. Typing searches via `/sessions/search`. Picking or
  pasting inserts `@<title>`, sent as `[@title](orbit-session:<id>)`. `@workspace` leaves the
  session composer; task-comment mentions are unchanged.
- **`#` names a piece of work: a project.** Sessions are one-off (413 references over 308
  sessions, 1.3 each); projects recur (317 over 77, 4.1 each, 302 of them hand-copied bare ids), and
  a recurring set is where a picker beats pasting.
  - A blank `#` shows this conversation's own project, then projects by latest activity.
  - Typing searches projects, then tasks (a few rows, labelled "Task").
  - Pasting a project or task URL or id gives the same chip.
- **Not in `#`, with the reason for each:**
  - task lists: 8 references; they are agents' dispatch plumbing, and old `orbit-list:` links
    still expand;
  - Drive files: about 6; a file is an attachment, so it goes back to the ＋ attach control and is
    sent as a path;
  - wiki entries: 6; agents search the wiki themselves;
  - sessions: they belong to `@`.
- **`<referenced-project>`** carries:
  - state and a "Shown as" line;
  - criteria met out of total, with the unmet ones named;
  - task counts and recent failures;
  - open blockers and items waiting on the owner;
  - the coordinator session and its state;
  - landing state.

  `<referenced-task>` gains its latest run's session id.
- **A message with both kinds gets one grey line:** `⊕ Orbit attached: 1 session, 1 project`.
- **Kill criterion for the `#` menu:** after a month, if under about 15% of project references
  arrive as a chip from the menu, remove the menu and keep server recognition. The threshold is a
  guess. A Fable run wrote this `#` definition.

## 1. What production shows

Read-only queries against production on 2026-11-28, over all `conversation_turn` rows since
2026-06-17. "Typed by a person" means the turn has a client-generated id and is not one of the
platform's own notices. That filter agrees with `by_person`, which exists only since 2026-11-23,
on 841 of 844 turns. It covers 18,413 turns in 4,111 sessions.

**What a typed message names**, resolved by looking each id up in its table:

| Kind | Typed turns that name it | Distinct objects | How it was written |
|---|---|---|---|
| **Session** | **413** | **308** | 206 pasted web URL, 209 bare id, 0 via a picker |
| Project | 317 | 77 | 302 bare id, 14 URL |
| Task | 316 | 184 | 305 bare id, **9 via the `#` chip** |
| Task list | 8 | 6 | — |
| Wiki entry | 6 | — | — |
| Workspace (`@`) | 4 | 7 | — |

**Who works on tasks.** Agents created 115,350 of 115,674 tasks (99.7%). Agents wrote 10,720 of
10,730 task comments. People wrote 10 comments, and 2 of them mention anyone. The task ids people
do type are copied out of agent replies and cards. Nobody goes looking for a task.

**What the referenced sessions are** (494 references):

- 271 are conversations a person opened, 134 are task runs, and 89 are coordinators. When a person
  cares about a task, they reach it through its run.
- 163 (33%) are on a **different runner** from the conversation that names them, so the agent
  often cannot read that session's machine.
- 110 are more than a day old. 53 messages name several sessions at once, to compare them. 31
  carry a page parameter or anchor (`?project=`, `?folder=`, a turn).
- 156 are almost nothing but the link: under 60 characters of other text.

**Why people point at one.** These keyword buckets overlap; the samples read the same way.

- **~70%: investigate it.** "This session finished but the task still shows running", "why does it
  still offer Merge to main", "why is it stuck waiting for a slot", "debug this session's error".
  The session is the subject, and the question is usually a mismatch between what a client shows
  and what happened.
- **~27%: continue or follow up.** Mostly addressed to coordinators: "why didn't you follow up",
  "it ended".
- **~6%: use it as an example.**

**What this means for the current design:**

- The one picker we built (`#` for tasks and lists) is for the kind people do not reference. It was
  used 9 times in five months.
- The kind they do reference gets **nothing**. A pasted session URL travels as plain text, the
  agent receives a 22-character string, and its first move is a `session_search` to find out what
  it is — on another machine a third of the time.
- `@` has almost no human use: 4 typed workspace references, and 2 comment mentions ever.

## 2. The model

- **`#` (and a paste) names something the message is about.** A session first, then a project.
  Tasks and lists stay valid targets, because agents link them, but they leave the person's
  default menu.
- **The server recognises a reference however it was written.** That covers a chip, a pasted URL
  and a bare id. Half of today's references are bare ids that no picker will ever produce, so the
  server-side recognition is the feature, and the picker is a convenience on top of it.
- **What the agent receives answers "look into this session"**: the facts it would otherwise spend
  its first five tool calls collecting (§4).
- **`@` stays as it is** and gets no new work (§8 decision A).

## 3. Recognising references

### 3.1 On the server, for every message a person sends

The rule:

1. **What counts as a reference:**
   - an Orbit web URL, on this deployment's own origin, naming a session, project, task or list,
     with or without query parameters;
   - an `orbit-<kind>:<id>` link;
   - a bare base62 or uuid token that **resolves to an object the sender owns**.
2. **Bare tokens are resolved, not guessed.** They are looked up with one batched query per kind;
   a token that resolves to nothing is ordinary text. This is what keeps commit hashes, keys and
   other 22-character strings from turning into references.
3. **What it applies to:**
   - turns a person sends; agent-to-agent `session_send` stays as it is (§8 decision B);
   - only when the person is the owner. A guest's tokens resolve only to objects the guest can
     read, and an unreadable one is plain text, so it does not reveal whether the object exists.
4. **Expansion.** It still happens at delivery, as `reference-expansion.ts` does today, so the
   facts are current; it is de-duplicated and capped at 8. The cap also covers the 53 messages
   that compare several sessions.

Old clients and every other way into a session (Feishu, the API) gain this without changing
anything. This step alone covers all 413 session-referencing turns in §1.

### 3.2 In the composer

The composer does two things.

- **Pasting becomes a chip.** Pasting a session URL or id shows `#<session title>`, with a status
  dot, where the URL was. What is sent is the canonical link,
  `[#title](orbit-session:<id>)`, keeping any turn anchor (§4.2). The person sees what they
  referenced before sending it, which today they cannot.
- **`#` opens a session-first menu:**
  - a blank `#` lists, in order: sessions in trouble (failed, stuck, waiting on a person), the
    sessions viewed most recently, then the conversation's own project;
  - typing searches sessions through `/sessions/search`, which already resolves ids, prefixes,
    titles and branch names, then projects;
  - tasks and lists are reachable with an explicit `#task:` / `#list:` prefix and are not offered
    otherwise.

The chip mechanics from `composerRefs.ts` stay: the box holds readable text, a map remembers the
id, and the mirror paints colour only. One addition: the map is stored with the draft, so a restored
draft keeps its chips.

**"Ask about this session" from the session itself.** A session's header and its list row's menu
gain a "Discuss in a new conversation" / "Copy reference" action. It opens a composer (or puts on
the clipboard) a reference that is already a chip. This is the gesture people make today by hand:
copy the URL, open another session, paste.

## 4. What the agent receives for a session

### 4.1 The block

Built for the ~70% investigating case. It carries facts and ids, never transcript content:

```
<referenced-session id="…">
  Title        …
  Opened       2026-11-20T08:14Z by PERSON · workspace orbit-ws04 on runner hpc (not this runner)
  State        IDLE · last turn ANSWERED 2026-11-20T09:02Z · 14 turns · ended no
  Shown as     Completed (web list) · Running badge cleared
  Task         "…" (id …) DONE · project "…" (id …)          — only when it is a task run or coordinator
  Code         branch orbit/session-ab12 · 3 commits ahead of main · uncommitted 0 · merged to main: no
  Last error   none | <class>: <first line>
  Pending      1 approval card · 0 questions
  Read more    session_get(id) for status and the latest output; session_search for its turns
</referenced-session>
```

- **"Shown as" is the line that answers the common question.** Most investigations are "the
  client shows X, but Y happened". Putting the server's own reading of what the clients draw next
  to the facts lets the agent see the mismatch in the first turn.
- **Where it runs, said outright.** "On runner hpc (not this runner)" stops the agent from looking
  for local logs that are not there, which is the case for a third of the references.
- **Task and project lines appear when the session belongs to one.** That is how a task reaches a
  person's question: through its run (134 of the 494 references).

### 4.2 A turn anchor

A URL that points at a turn adds that turn's prompt, outcome and error, truncated, to the block.
"Why did this one fail" names a turn more often than a whole session.

### 4.3 What the agent cannot yet do

`session_get` returns status and the latest output. There is no tool that reads a range of
another session's turns, which an investigation needs once the block runs out. Adding a read-only
`session_turns(id, around?, limit)` tool is part of this design (phase 2). I haven't checked that
no existing tool already does this; check before building.

### 4.4 Projects

A project gets the same treatment, smaller: status, criteria met out of total, open blockers,
coordinator session, and the integration line's state. Lists and tasks keep the blocks they have
today.

## 5. Rendering

- **In the person's bubble,** a reference is drawn as a chip reading the session title, with live
  state from `POST /api/link-previews`, which already serves sessions. A pasted URL that the server
  recognised is drawn the same way, so old messages improve too.
- **What Orbit attached** follows the 2026-10-27 owner ruling: one grey meta line under the
  bubble (`⊕ Orbit attached: 1 session`), and opening it shows the block.

## 6. `@`

There is almost no human use (§1), so this design does not extend it:

- Task-comment mentions keep their delivery ledger as they are. Agents do not use them either
  (0 of 10,720 agent comments).
- The session composer's `@` menu stays a plain-text convenience. It should be labelled honestly
  in its menu ("mention in the message; nothing is sent to that agent") rather than made into a
  delivery mechanism nobody has asked for.
- Making `@` deliver (revision 1's decision A) is dropped until there is evidence people address
  other agents from a conversation.

## 7. Phases

1. **Server recognition and the session block** (§3.1, §4.1). No client change, and it covers
   every existing way of referencing a session.
2. **Turn anchors and `session_turns`** (§4.2, §4.3).
3. **Web composer:** paste-to-chip, the session-first `#` menu, and drafts that keep their chips
   (§3.2), plus the chip in sent bubbles (§5).
4. **Apple and Android:** the same paste-to-chip and bubble chip against a shared fixture. The
   "Discuss in a new conversation" action on all three clients.

Each phase stands alone.

## 8. Open decisions (recommendation first)

**A. `@`:** leave it as it is and label it (§6). Alternatives: remove the session-composer `@`
menu, or make it deliver.

**B. Recognise references in agent-to-agent messages too?** Recommended: not in phase 1. Agents
already write canonical `orbit-session:` links (89 of 6,028 agent messages name a session) and can
call `session_get` themselves. Revisit if agents are seen searching for ids they were handed.

**C. Expand bare ids, or only URLs and links?** Recommended: bare ids too, resolved strictly to
objects the sender owns (§3.1). They are half of all references. Alternative: URLs only, with
no chance of a false match but half the coverage.

**D. Tasks in the menu:** recommended: only through an explicit `#task:`. Alternative: drop task
picking from the composer altogether.

## 9. What would show this works

- Replay the 413 historical turns through the recogniser: every session URL and bare session id is
  found, and no commit hash or other token becomes a reference.
- On a pasted session that lives on another runner, the agent's first turn answers without calling
  `session_search`.
- The bubble chip and the meta line render the same on web, Apple and Android.
- After a month, compare how often an agent's first tool call after a person's message is a
  `session_search` / `session_get` for an id in that message, before and after phase 1.
