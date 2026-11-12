# Start an Orbit session from the terminal (`orbit`)

Status: **proposal**, waiting on the owner's decisions D1–D6. Board: `docs/mocks/terminal-session/`.

## Problem

Typing `claude` in a folder opens a conversation right there. Typing `orbit` prints the help text and
exits 0. The commands that come close each miss part of it:

| Command | What it does | What it lacks |
|---|---|---|
| `orbit resume <id>` | runs the session's engine CLI (`claude --resume <uuid>`) in its recorded work dir (`main.go` `resumeCommand`) | the session must already exist; turns made in that terminal never reach Orbit's transcript |
| `orbit session create --prompt` | files a session that a runner runs in the background | no terminal conversation; refused under `orbit login` (`user_mode.go`) and outside a session without a service token |
| `orbit session import <uuid>` | copies a finished Claude Code transcript into a new Orbit session | one-shot: the turns after the import stay in the terminal |

## Proposal (recommended defaults)

`orbit` with no arguments, run on a TTY on a machine with a registered runner:

1. **Finds the workspace** on this machine that contains the cwd. This is the same lookup
   `session import` already does for a transcript's recorded cwd (D3).
2. **Files a session** in it through the runner credential, the way import does (D2). The session is
   marked **held by a terminal**, so that no runner dispatch spawns a second engine process on it.
3. **Starts Claude Code in the foreground, in the cwd itself, with no worktree** (D4):
   `claude --session-id <sessionUuid>`, with the Orbit MCP server and `ORBIT_SESSION_ID` set and the
   `CLAUDE_CONFIG_DIR` of the account that the session records. The person gets Claude Code's own UI,
   unchanged.
4. **Mirrors the conversation live.** It tails `<uuid>.jsonl` and posts each new record as run events,
   through the parser that `session import` uses (`transcript_import.go`). Web and phones show the
   session as it runs.
5. **When Claude exits**, it posts the last records and releases the hold. The session then stays an
   ordinary Orbit session. The next message from any client resumes it on this machine's runner
   (`claude --resume`), on the same jsonl.

Messages sent from another client while the terminal holds the session are queued and run after the
terminal exits (D6). The composer says so.

`orbit resume <id>` gets the same hold and mirror, so turns made in a resumed terminal stop vanishing
from Orbit.

## Decisions

| | Question | A (recommended) | B | C |
|---|---|---|---|---|
| D1 | What runs in the terminal | Claude Code's own TUI + live mirror into Orbit | an Orbit TUI client over the REST API (any engine, any runner) | — |
| D2 | Whose credential files the session | the machine's runner credential, like `session import` | require `orbit login` (personal token) | — |
| D3 | cwd is in no workspace | ask `Add ~/x as a workspace? [Y/n]`, then create it | refuse, naming the command that adds one | — |
| D4 | Where edits happen | the cwd itself, no worktree (what `claude` does) | a new Orbit worktree, as web sessions get | follow the workspace's setting |
| D5 | Command name | bare `orbit` on a TTY; help on a non-TTY, `orbit help`, `--help` | `orbit chat` only; bare `orbit` keeps printing help | — |
| D6 | A phone sends while the terminal holds the session | queue; run it after the terminal exits; the composer says so | refuse with 409 | — |

Engines: Claude Code first. Codex next (`codex resume` plus its rollout file). Kimi and OpenCode
follow the same shape. DeepSeek Harness and Cursor stay refused, as in `orbit resume`.

## Risks

- **Account directory.** The runner may run a Claude session in an account's own `CLAUDE_CONFIG_DIR`
  (`claude_account_slot.go`). The terminal must start in the directory that the session records, or
  the runner's later `--resume` does not find the jsonl.
- **Two writers.** While the hold is set, the server must not lease an executable turn to the runner.
  Releasing the hold on exit has to survive a killed terminal, so it needs a lease plus heartbeat, the
  same shape as session leases.
- **Mirror fidelity.** Import refuses a transcript whose replay does not reproduce it. A live tail
  needs the same check per batch, plus a resync when Claude compacts the conversation.

## Landing (cheapest first)

1. CLI: bare `orbit` on a TTY → workspace lookup, session create (runner credential), foreground
   `claude --session-id`. No mirror yet: the transcript appears on exit, through the import path.
2. Server: a terminal hold on the session (lease + heartbeat); queued sends while held; composer
   notice on web, iOS and Android.
3. Live mirror: tail the jsonl and post events incrementally; same for `orbit resume`.
4. D3 B → A: create a workspace from the terminal prompt.
5. Codex, then Kimi and OpenCode.
