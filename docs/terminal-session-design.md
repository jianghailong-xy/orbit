# Start an Orbit session from the terminal (`orbit`)

Status: **decided** (owner, 2026-11-12); being built as an Orbit project. Board: `docs/mocks/terminal-session/`.

Decisions so far (owner, 2026-11-12):

- D1 = **B**: an Orbit terminal client over the REST API. It is not a mirror of Claude Code.
- D2–D6 as recommended in round 1.
- Approval cards are answered **in the terminal**.

D1 = B changes what D2 and D6 were about. Round 2 restated them and added D7–D9. Round 2 answers: D2′ = A,
D7 = **B** (remember the terminal for 30 days), D8 = A, D9 = A.

## Problem

Typing `claude` in a folder opens a conversation right there. Typing `orbit` prints the help text and
exits 0. The commands that come close each miss part of it:

| Command | What it does | What it lacks |
|---|---|---|
| `orbit resume <id>` | runs the session's engine CLI in its recorded work dir (`main.go` `resumeCommand`) | the session must already exist; turns made there never reach Orbit; DeepSeek Harness and Cursor are refused |
| `orbit session create --prompt` | files a background session | no conversation in the terminal; refused under `orbit login` |
| `orbit session import <uuid>` | copies a finished Claude Code transcript into Orbit | one-shot |

## Shape

The terminal becomes one more Orbit client, next to web, iOS and Android:

```
terminal (orbit TUI) ──REST + SSE──▶ apiserver ──link──▶ runner on this machine ──▶ engine (any)
phone / web ─────────────────────────┘
```

- The session runs on this machine's runner, exactly like a session started from the app. Every
  engine works, including DeepSeek Harness and Cursor, because the terminal never runs the engine.
- The TUI reads `GET /sessions/:id/events/page` once, then follows the SSE `GET /sessions/:id/events`.
  It writes through `POST /sessions/:id/turns`, `/interrupt` and
  `/approvals/:approvalId/decision`: the same doors the app uses, so steering and queueing behave
  as they do there.
- Phone and terminal can both send while the session runs. Nothing holds the session, so round 1's
  D6 (queue phone sends while a terminal holds the session) no longer applies.
- Leaving the TUI does not end the session. It keeps running on the runner and can be reopened.

## Flow of `orbit` (bare, on a TTY)

1. **Terminal login** (D7, first run on a machine, then every 30 days). The CLI asks the account's devices to approve "Terminal on dev-laptop". The
   owner taps Approve in the app, and the CLI receives a terminal credential (below).
2. **Workspace from the cwd** (D3 = A). The CLI looks for a workspace on this machine's runner that
   contains the cwd. If there is none, it asks `Add ~/x as a workspace? [Y/n]`. The existing
   `POST /sessions` already takes `newWorkspace: { workDir }` with `assignedRunnerId`, so this needs
   no new route.
3. **Session in the cwd itself, no worktree** (D4 = A). For a workspace whose setting is worktrees,
   `POST /sessions` needs a per-session override: a new field.
4. **TUI**: transcript, composer, approval cards answered with a key, Esc interrupts the turn, `/`
   opens Orbit's slash commands. `/exit` or Ctrl-D leaves the TUI. The session keeps running and the
   CLI prints how to reopen it (D9).

## The terminal credential (approvals in the terminal)

Today only the app's own login answers an approval card. `docs/human-only-authority.md` lists
approval answers among the owner-channel routes that refuse a personal access token
(`OWNER_INTERACTIVE_CREDENTIAL_REQUIRED`). The reason: agents run on the same machine, and a bearer
token on disk is one they can read and use to approve their own requests.

A new credential kind, `TERMINAL`, answers approvals. The owner chose (D7 = B) to remember a terminal
for 30 days, accepting that a same-user agent on that machine can read the stored credential. These
limits are what is left:

| Limit | What it stops |
|---|---|
| Minted only by the owner's tap in the app (an owner-channel act), never by a token or a runner | an agent minting its own |
| Bound to one machine (its runner) and to the sessions on that runner; refused on every other session | a copied credential used for sessions elsewhere |
| Stored in the OS keychain (macOS Keychain, Linux Secret Service); where there is none, a `0600` file under `ORBIT_HOME`; never in the environment | an agent reading it from `env` or from a world-readable file |
| Expires 30 days after the tap; listed in the app (Settings → Terminals) with Revoke | a leaked copy living on unnoticed |
| Allowed: create/open sessions, send, interrupt, read events, answer approval cards. Every other owner-channel act stays refused (evidence decisions, criteria, project start/done) | widening a terminal into the owner |
| Every answer recorded with `credential_kind = TERMINAL` and the machine name | unattributed answers |

**Accepted risk:** an agent running as the same OS user can read the stored credential and call the
approval route itself, approving its own requests on that machine's sessions. It is visible in the
activity log, and revocable. A runner installed under its own user (hostd) keeps agents out of the
person's keychain and home.

`human-only-authority.md` gets a `TERMINAL` row: approval answers are allowed, and the owner-accepted
risk above is recorded there.

## Decisions

| | Question | A (recommended) | B |
|---|---|---|---|
| D1 | What runs in the terminal | ~~Claude Code's TUI + mirror~~ | **Orbit TUI over REST — chosen** |
| D2′ | Whose credential the TUI uses (was: runner credential) | **chosen:** the terminal credential for everything: the user routes already exist, so no new runner routes | runner credential for create/send/read (new runner routes for the event stream) + terminal credential for approvals only |
| D3 | cwd in no workspace | ask `[Y/n]`, then create it — **chosen** | refuse |
| D4 | Where edits happen | the cwd, no worktree — **chosen** (needs a per-session override) | an Orbit worktree |
| D5 | Command name | bare `orbit` on a TTY — **chosen** | `orbit chat` |
| D6 | Phone sends while the terminal is open | ~~queue until the terminal exits~~ — moot: both send, as two app windows do | |
| D7 | Terminal login lifetime | ~~a tap at every launch, memory only~~ | **remember the terminal for 30 days (OS keychain); a tap only the first time — chosen** |
| D8 | `orbit resume <id>` | **chosen:** opens the Orbit TUI on that session (all engines); the engine CLI moves to `orbit resume --engine-cli` | unchanged; the TUI opens with `orbit open <id>` |
| D9 | Leaving the TUI mid-turn | **chosen:** the session keeps running; reopen with `orbit resume <id>` | leaving interrupts the turn, as quitting Claude Code does |

## Landing (cheapest first)

1. **Terminal credential**: device-login flow (reuse `pat-device-login`) with an approve card in the
   app that names the machine; keychain storage; Settings → Terminals with Revoke; `TERMINAL` kind on sessions, turns, interrupt, events and approval
   decisions only; activity rows; `human-only-authority.md` row.
2. **TUI v1** (Go, in the `orbit` binary, new dependency `charmbracelet/bubbletea`): open or create a
   session, render the transcript (text, folded tool calls, diffs), composer, Esc to interrupt,
   approval cards with y/n.
3. **cwd → workspace**: lookup on this machine's runner, `[Y/n]` creation through `newWorkspace`, and
   the per-session no-worktree override on `POST /sessions`.
4. `orbit resume` opens the TUI (D8).
5. TUI v2: slash commands, attachments (paste a file path), the steer delivery states, the engine and
   model pickers.
