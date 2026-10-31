# Web: a machine's first workspace, real pages against the boards

Task 34pLtXoRoxc9rRrGuwuQN of project 34pLjYBjU6ILsehatEjJs. The boards are
`docs/mocks/first-workspace-in-conversation` (01, 02, 04); the server is `docs/first-workspace-contract.md`.

- `compare/`: each proposal frame of boards 01 and 02, three times across: the board's frame, the same crop of the
  real page, and what differs (pixels more than 40 of 255 apart in grey).
- `beyond-the-boards/`: states no board drew: dark, a phone's width, a pane shorter than the card (each with a
  message waiting), and a runner from before `dir-probe/v1`.
- `rig/`: what made them. It runs from the kit at `/var/tmp/first-ws-mock`, on a tree that holds this code:

  ```bash
  cp rig/* /var/tmp/first-ws-mock/ && cd /var/tmp/first-ws-mock
  ln -sfn <worktree> wt-p1
  unshare -n ./run-ns.sh /var/tmp/first-ws-mock/wt-p1 capture-p1.mjs        # every frame, into shots-p1/
  unshare -n ./run-ns.sh /var/tmp/first-ws-mock/wt-p1 flow-p1.mjs           # the flows in a real browser
  python3 -I compare-p1.py shots-p1 compare-p1 <worktree>/docs/mocks/first-workspace-in-conversation/frames
  ```

  Nothing in these shots is injected: the held message and the Created workspace line are the product's, and
  `rig/data.mjs` carries the contract's fields (`registerDir`, `capabilities`, `DirProbe`, `createdWorkspace`) where
  the prototype had `homeDir`, `registerDirProbe` and `/runners/:id/probe-dir`.

## The route

A machine's new session page is `/runners/:id/new`, a route of its own in the console, rather than the existing
`/workspaces/<runner id>` fallback. `/workspaces/:id` means a workspace to every reader of that address: the view
locks to it and sends it (`POST /sessions` answers 403 for a runner's id), the session list and folders scope to it, the
sidebar lights a row by it, and the Wiki remembers it. A machine with no workspace has none to name, and on the new
address "no workspace" is simply the state the view is in, so none of them had to be taught an exception. The fallback
keeps working for old links: it redirects here, and this page redirects to the first workspace's draft once the machine
has one, so an entry can say Start a session for any machine.

## Differences from the frames

Of the 26 element boxes both runs measured, 21 match the board to the pixel; the other five are the p-progress, e-missing
and e-nogit rows below. The boards keep their frames at 1.1 to 2 pixels per CSS pixel and the comparison resizes them up
to the real crop, so the faint outlines around text in the frames the boards drew smaller are that resize, not a change.
The frame kept at full size (p-landing's card) differs by 0.15%, which is the path.

| Frame | Board | Real page | Why |
| --- | --- | --- | --- |
| All with a path | `~/code/app`, `~/orbit-repos/` | `/home/orbit/code/app`, `/home/orbit/orbit-repos/` | The contract has no home directory: `homeDir` was prototype data. An absolute path is what the workspace will hold, and this is the line that grants access. |
| p-progress | Bubble 112px tall, with blank space under the text | 84px | The prototype injected a bare `<p>` with its margins; this is the product's real bubble. The card sits 14px lower because the column is shorter. |
| e-missing, e-nogit | Card at y=94 | y=107 | A card taller than the pane: the prototype centred it and clipped its top. It now starts at the top and scrolls. |
| e-offline | Use Codex instead in link blue | Greyed, disabled | The task says both steps are disabled offline. |
| p-started | `⌂` text glyph, injected | The app's `HomeOutlined` icon | Same mark, from the icon set. |
| p-ready, p-progress, p-started | Text ends earlier | Text runs longer | Only the longer absolute path. |

Added where the boards drew nothing, all in `src/web/src/lib/machineSetupCopy.ts` and marked there: the runner too old
to check folders (and one that can't update itself), a new folder name the server would refuse, a path that is a file,
a check with no answer (Check again), an engine the machine doesn't have, a key or pool answering step 2, and a
refused first message (Try again).

## Decisions

- **Use an API key.** Rule 5 says it is offered when the account has a key that can run; the frames draw it on an account
  with none. Both hold: with a key that can run, the press makes it the draft's credential and the step reads done; with
  none, it goes to where one is connected, as this button does everywhere else.
- **Which engine a machine starts on.** One signed in, else the first it has, else Claude Code: the card doesn't ask to
  sign in Claude Code beside a signed-in Codex.
- **What waits, and for how long.** One message per machine, kept for this tab in `sessionStorage` with the picked folder,
  so a trip to connect a key or a reload loses neither. Tab-scoped because a send makes a workspace: two tabs must not
  both send it.
- **A refused first message** stays where it waited, says why, and goes again only on Try again.
