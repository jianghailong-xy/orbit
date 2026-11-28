# `#` and `@` in the composer: design

Status: proposal (2026-11-28). Nothing here is built yet. §9 lists the open decisions, each with a
recommended default.

## 1. Where things stand

Two symbols that look like a family but were built separately:

- **`#`** (web session composer only) picks a task list or task; the Drive picker reuses the same
  chip for files. The box holds `#<title>`, the client remembers the id
  (`src/web/src/lib/composerRefs.ts`), send materialises `[title](orbit-list|task:<id>)`, and the
  apiserver appends a `<referenced-list|task>` block at delivery
  (`src/apiserver/src/tasks/reference-expansion.ts`). Drive chips are sent as a path instead.
- **`@`** means two different things:
  - in the **session composer** it is plain text with no server meaning — the agent may or may not
    act on it;
  - in **task comments** (web, Apple, Android) it is an addressed delivery: the client derives
    `mentions[]` by matching names, and the server delivers through a retried, recorded ledger
    (`TaskCommentMentionDelivery`, `MentionDeliveryNotes`).

The defects this produces:

| # | Defect |
|---|---|
| D1 | `@` in a session is a promise the system does not keep: no id, no delivery, no status. |
| D2 | The two `@` menus offer different candidates (this runner's workspaces vs all of them). |
| D3 | Mentions are identified by **name**: a rename, or two workspaces whose names are prefixes, silently changes who was addressed; the session mirror chips any `@word`. |
| D4 | The session menus read the end of the draft, the comment menu reads the caret. |
| D5 | `#` covers lists and tasks, but agents already link projects, sessions and wiki entries; the link-preview contract (`src/shared/src/link-preview.ts`) knows all five kinds. |
| D6 | Drive chips are resolved on the client into a path the server never sees as a reference. |
| D7 | A reference that cannot be expanded (deleted, not the sender's) vanishes silently for the agent. |
| D8 | Apple and Android have no `#`, and `@` only in comments. |
| D9 | The picked-id map lives in component state: a draft restored from storage, or text pasted from another message, loses its references. |

## 2. The model: three symbols, three roles

One rule decides what each symbol is for, so a new kind never has to ask which symbol it gets:

| Symbol | Role | Answers | Effect on the message |
|---|---|---|---|
| `/` | **verb** | "what should happen" | runs a command or skill (unchanged, out of scope) |
| `#` | **noun** | "what is this about" | adds *context* for the message's existing recipient |
| `@` | **addressee** | "who should get this" | adds a *recipient*; the message is delivered to them |

The consequences:

- `#` never makes anything happen by itself. It can be added to any message on any surface without
  changing who receives it.
- `@` always delivers, everywhere, through one recorded mechanism, with visible status. There is no
  surface where `@` is only decoration (fixes D1).
- Something that can both be talked about and talked to (a session, an agent) is `#` when it is the
  subject and `@` when it is the recipient. "#nightly-crawl stalled again, @reviewer take a look"
  is two different acts and reads that way.

## 3. What can be referenced and addressed

### 3.1 `#` kinds

| Kind | Scheme | Picker source | Delivered to the agent as | Phase |
|---|---|---|---|---|
| Task | `orbit-task:` | task search (exists) | `<referenced-task>` (exists) | 1 |
| Task list | `orbit-list:` | list index (exists) | `<referenced-list>` (exists) | 1 |
| Project | `orbit-project:` | project list | `<referenced-project>`: status, criteria x/y, blockers, coordinator session | 2 |
| Session | `orbit-session:` | `GET /sessions/search` | `<referenced-session>`: title, state, workspace, last turn outcome, task | 2 |
| Wiki entry | `orbit-wiki:` | `GET /wiki/search` | `<referenced-wiki>`: title, trust, status | 2 |
| Drive file / folder | `orbit-drive:` | `GET /drive/search` and the Drive picker | `<referenced-drive>`: name, size, **mount path** | 2 |

Every kind follows the rule the existing expansion already set: the block carries **the shape and
the id, never the contents**, plus the tool that fetches the rest. The Drive path is part of the
shape, so Drive stops being a client-side special case (D6).

Not `#` targets, deliberately: attachments (already inline), commands and skills (`/`), runners and
providers (configuration, not subject matter — a link from Settings is the right tool there).

### 3.2 `@` targets

| Target | Scheme | Delivered how | Phase |
|---|---|---|---|
| Workspace (agent) | `orbit-workspace:` | the mention ledger (exists for comments) | 1 comments, 3 sessions |
| Person (owner, session guest) | `orbit-user:` | a notification with a link to the message | 4 |

The candidates are the same on every surface: every enabled workspace the sender can deliver to,
with this runner's workspaces ranked first where there is one (fixes D2).

## 4. Wire format: one link grammar for both symbols

Both symbols travel as an ordinary markdown link whose **URI** carries the identity and whose
**text** carries what the person saw:

```
[#FineWeb CC-MAIN-2025-26](orbit-list:3fK9…)
[@reviewer](orbit-workspace:7Qa2…)
```

- The server parses meaning from the URI only, as `reference-expansion.ts` already does. The label
  is display, so renames cannot change the addressee (D3).
- `mentions[]` on the comment API becomes derived server-side from the body. The field stays
  accepted for one release for old clients, and the server takes the union.
- Text an old client sends (`@reviewer` without a link) keeps working the way it does today.
- Ids are base62 public ids, the same spelling as every other id an agent sees.

The grammar, the tokenizer, the label escaping (task titles start with `[W 009/250]`) and the
longest-first resolution move into `@orbit/shared` as one module, with a shared fixture file that
the Swift and Kotlin ports are tested against, as `orbit-link.fixture.json` already is for link
rendering.

## 5. Composer behaviour (all clients)

- **Trigger at the caret**, on every surface, by one shared rule: the token starts at a `#` or `@`
  that begins the text or follows whitespace or an opening bracket (fixes D4). `#` queries may
  contain spaces and run to the caret; `@` queries stop at whitespace.
- **One menu, grouped by kind.** A blank `#` shows *this conversation's own context* first (its
  task, its project, its list), then recent picks, then lists. Typing searches every kind; a kind
  prefix (`#task:`, `#wiki:`, `#file:`) narrows it. Each row shows a kind icon, the title and a
  secondary line (status, list, path) so rows with the same title can be told apart.
- **Chips are atomic.** Backspace at a chip's end removes the whole chip. Typing inside one turns
  it back into plain text, visibly: the colour goes, so the person can see the reference is gone
  before they send it. The web mirror keeps its constraint (colour and background only, same
  characters).
- **Paste and drop.** Pasting an Orbit URL or an `orbit-*:` link becomes a chip. Dropping a Drive
  file does the same.
- **Drafts own their references.** The draft is stored as text plus its reference map, so a restored
  draft keeps its chips (D9).
- **Limits are shown before send.** More than 8 references, or an `@` the sender cannot deliver to,
  is flagged on the chip rather than discovered afterwards.

## 6. Delivery

### 6.1 `#` expansion

The current properties stay: expansion happens at delivery so the counts are current; the
transcript keeps what the person typed; the result is de-duplicated and capped at 8.

Changes:

- **A registry per kind.** `ReferenceExpansionService` dispatches by kind; each kind owns its query,
  its block and its access rule.
- **Access is the sender's.** In a shared session a guest's `#` expands only what that guest can
  read. Something they cannot read expands to the same "unavailable" block as a deleted one, so it
  does not reveal whether the object exists.
- **No silent drops (D7).** A reference that does not resolve still produces a block:
  `<referenced-task id="…" unavailable="not found or not accessible"/>`. The agent learns that the
  person meant something and it is not there, rather than receiving a message that silently
  mentions nothing.
- **A size budget**, not just a count: blocks are capped in total bytes, and a block over the
  budget is replaced by its id and fetch tool.
- **Agent-written messages too.** The same expansion applies to `session_send` / `project_send`
  bodies, so an orchestrator writing `[#Fix login](orbit-task:…)` to a sub-agent gives it the same
  entry point a person's message would.

### 6.2 `@` delivery

One ledger, generalised from `TaskCommentMentionDelivery` into a mention delivery keyed by
*(source message, target)*, with the same states, retries, terminal codes and the
availability-refund rule. Sources:

- **a task comment** (exists; delivers to the task's run when one is going, otherwise opens a reply
  conversation);
- **a session message** (new): the message is delivered to the mentioned workspace as a new
  conversation that links back to the source session, and its reply returns to the source session as
  a turn, the way `session_send` with `expectReply` already returns answers (§9 decision A).

The status line under the message reuses `MentionDeliveryNotes` on every surface. It is one line in
the grey meta voice under the bubble, never inside it — the 2026-10-27 owner ruling for anything
Orbit adds to a person's message.

## 7. Rendering in the transcript

- **The person's bubble** draws each reference as a chip reading exactly what they saw (`#title`,
  `@name`). Tapping it opens the object. The chip's live state (status dot, title if renamed) comes
  from `POST /api/link-previews`, which already batches every kind in §3.1 except Drive.
- **What Orbit added** (the expansion blocks) is not drawn in the bubble. A meta line under it says
  so (`⊕ Orbit attached: 2 references`), and opening that line shows the blocks.
- **Unavailable references** draw as a struck-through chip with the reason in its tooltip.

## 8. Security and limits

- Every resolve, expand and deliver step checks access as the sender, not the agent; delivery adds
  the recipient's own access check.
- Titles are the owner's own text, and they appear in the block as data lines, not as
  instructions.
- `@` to a workspace on another runner is allowed only where `session_send` would be allowed. The
  existing per-pair message rate limit applies to mention deliveries too, so a loop of agents
  mentioning each other is bounded.

## 9. Open decisions (recommendation first)

**A. What does `@agent` in a session message do?**
- **A1 (recommended): deliver a copy.** The current agent still gets the message; the mentioned
  agent gets it as a new linked conversation, through the ledger, with status under the bubble.
  This is the same meaning `@` has in comments, so there is one rule.
- A2: an instruction to the current agent ("hand this to X"). This is today's behaviour made
  explicit. It is cheap, but it leaves `@` meaning something different in sessions and in
  comments, which is D1 again.
- A3: switch the recipient (the message goes only to X). This is a different gesture; if wanted,
  it is a composer recipient control, not a symbol.

**B. Do agents' own messages expand `#` references?** Recommended: yes (§6.1), with the same caps.
Alternative: people only, so agent-to-agent traffic stays byte-identical.

**C. Unavailable references:** recommended: an explicit unavailable block (§6.1). Alternative:
today's silent drop.

**D. Kind prefixes in the menu (`#task:`):** recommended: support them but do not advertise them —
grouped results are the main path. Alternative: tabs in the menu.

**E. People as `@` targets:** recommended: phase 4, after workspaces are unified; it needs a
notification route for guests that does not exist yet.

## 10. Phases

1. **Shared grammar.** Tokenizer, link format and fixture in `@orbit/shared`. Caret-based triggers
   and one candidate rule on web. `@` sent as `orbit-workspace:` links, with comment `mentions[]`
   derived on the server (D2, D3, D4, D9).
2. **More `#` kinds.** Project, session, wiki and Drive through the expansion registry, the
   unavailable block, and the size budget (D5, D6, D7).
3. **`@` in sessions** through the generalised ledger, per decision A (D1).
4. **Native clients.** `#` and the unified `@` on Apple and Android, against the shared fixture; then
   people as targets (D8).

Each phase stands on its own and leaves old messages rendering as they do today.

## 11. What would show this works

- The shared fixture passes in TS, Swift and Kotlin, including titles with brackets, prefix-sharing
  titles and CJK text around the tokens.
- Renaming a workspace after a comment mentions it does not change who the mention delivered to.
- A guest's `#` to an object they cannot read produces the same unavailable block as a deleted id.
- An `@` in a session message reaches the mentioned agent with the delivery ledger recording it,
  and the status shows under the source message on all three clients.
