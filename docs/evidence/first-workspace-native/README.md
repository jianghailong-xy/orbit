# iPhone, iPad and Mac: a machine's first workspace, real shells against board 03

Task 34pLtXs3PjSVUmtKFuDvQ of project 34pLjYBjU6ILsehatEjJs. The boards are
`docs/mocks/first-workspace-in-conversation` (03 for the design, 04 for the rules); the server is
`docs/first-workspace-contract.md`; the words and the behaviour are the web's (`docs/evidence/first-workspace-web`).

- `compare/`: board 03's proposal frames beside the real iPhone screens.
- `iphone/`, `ipad/`, `mac/`: what `probe-harness` photographed, one file per scene.
- `probe-harness/`: the real shells built from the real sources against a stub of the contract. Its tests press what
  a person presses, read back the request the app made, and fail on a missing word. See its README.

## What the pictures are

Nothing in them is drawn for the probe: the apps are the shared sources, and only the API behind them is a stub
(`probe-harness/stub.py`, the slice of the contract in §2 and §3). The account has orbit@austin and no workspace unless
the scene says otherwise.

| File | Scene |
| --- | --- |
| `iphone/01-card.png` | Where the account lands: the card (board 03 ②). |
| `iphone/02-drawer.png` | The drawer's Set up row, with New session no longer grey (board 03 ①). |
| `iphone/03-held.png`, `04-folder-done.png` | The message waiting under the card, and step one done. |
| `iphone/05-created.png`, `05b-renamed.png` | It went by itself: the Created workspace line, and Rename from it (board 03 ③). |
| `iphone/06-drawer-after.png` | The Set up row is that workspace's row now. |
| `iphone/07-ready.png` | Both steps done before anything was typed. |
| `iphone/08-no-such-directory.png`, `09-not-a-repository.png` | Another folder, checked on the machine. |
| `iphone/10-offline.png`, `11-older-runner.png` | A machine that can't answer (offline; before `dir-probe/v1`). |
| `iphone/12-all-offline.png` | Rule 11: with nothing online the landing is Machines & models. |
| `iphone/13-machine-page.png` | Rule 12: the machine's page says Start a session. |
| `iphone/14-drawer-mixed.png`, `15-card-from-the-row.png` | Rule 9: after every workspace, and what the row opens. |
| `iphone/16-dark-held.png` | Dark. |
| `iphone/17-refused.png` | A refused first message waits on the person. |
| `iphone/20-elsewhere.png` | Another device made the workspace: the page moves on and the words come back in its composer, unsent. |
| `iphone/21-new-session.png` | New session, pressed from the Projects page with no workspace: back on the machine's page. It asks about the folder again as it arrives, and this is after the machine answered: until then `A new folder` is ticked, about 1.5 seconds against the stub. An answer is never kept past the page that asked, as on the web (`useDirProbe`): a folder can appear between two looks. |
| `iphone/18-sign-in-and-key.png`, `19-on-a-key.png` | Rule 5 with a key that can run: Use an API Key, and the step it answers. |
| `mac/mac-14-sidebar-mixed.png`, `mac-15-sidebar-card.png` | The Mac's sidebar by machine: an empty machine's header and row. |
| `mac/mac-01-card.png`, `mac-05-created.png`, `mac-20-elsewhere.png`, `mac-21-new-session.png` | The same page, line, hand-over and new session on a Mac, there by ⌘N. |
| `ipad/ipad-01-card.png`, `ipad-05-created.png`, `ipad-20-elsewhere.png`, `ipad-21-new-session.png` | The same on an iPad, whose sidebar is the drawer. |

## The run

Client CI run `41227387620`, on the commit these pictures came from plus the probe's own files: every job green.

| Check | Result |
| --- | --- |
| OrbitKit `swift test`, macOS | 4254 tests, 5 skipped, 0 failures |
| OrbitApp for macOS | Build complete |
| iOS app | `BUILD SUCCEEDED` |
| Shots, iPhone | 13 of 13 tests passed |
| Shots, iPad | 13 of 13 tests passed |
| Shots, Mac | 13 of 13 tests passed |

The iPad's sidebar title reads `O…` in these pictures. That is `CompactShell.columnBar`, which this work didn't change.

## Differences from board 03

The board is hand-drawn from measured values; its copy was the first draft.

| Frame | Board | Real app | Why |
| --- | --- | --- | --- |
| Drawer | A `⊕` glyph | `folder.badge.plus` | The web's `FolderAddOutlined`. The board's was a placeholder glyph. |
| Card, Created line | `~/code/app` | `/home/orbit/code/app`, on its own line on a phone | The contract's `DirProbe.path` is absolute, and the web shows the same. It is the line that grants access, so it isn't broken at a slash to fit. |
| Card | `Another folder…`, `Ask for a clone in your first message.`, `…signed in on that machine.`, `Nothing is created until you send.` | The web's landed sentences | The task names the web as the source of the words; `MachineSetupCopyParityTests` holds them to it. |
| Card, head | A `▭` glyph | `desktopcomputer` | The web's icon. The board's was a placeholder glyph. |
| Card, step 2 | `Use an API Key` always drawn | Drawn when a key can run here | Rule 5 says "when the account has a key that can run". These clients can't connect one, so with none there is nothing to offer. `18-sign-in-and-key.png` is the board's frame, on an account with a key. |
| Page | `#F7F7F9` behind the card | The app's page colour | The composer's field is tuned against that backdrop; the card keeps its hairline and shadow. |
| Conversation | Hamburger, session title, `app · orbit@austin` | Back, the ⋯ menu, no title | The console's own bar, which gave up its title on 2026-10-15 at the owner's word (`ConsoleView`). Back goes to the workspace the session made, which has the hamburger. |
| Conversation | `Reply…`, `Default` | `Message…`, `Auto` | The console's own placeholder, and the mode the draft sent, which is the one the board's own draft shows. |
| Conversation | `Working for 1m` | Not drawn | The web's turn head. These consoles have none. |

## Decisions

- **The page.** A frame of its own, `NavNode.machineDraft(runnerID:)`, as the web has `/runners/:id/new`: a machine with
  no workspace has none to name, and on its own frame "no workspace" is simply the state the page is in. It is the drawer
  row's own destination, so it leads with the hamburger and the left edge opens the drawer.
- **The draft.** A machine has no `Agent`, and the composer's engine, model and account pickers all read one, so the draft
  stands on one with the machine's name and no id (`Agent.machineDraft`). Its create names the machine and a folder
  instead of a workspace, and always names the engine and provider, as there is nothing to inherit them from.
- **What waits, and for how long.** One message per machine, kept by the app for this run with the picked folder
  (`MachineSetupModel`), so a sign-in through a browser loses neither. Not on disk, as the web keeps it to its tab: a
  message waiting in two places would be sent by both, and each send makes a workspace.
- **A workspace made elsewhere.** It reaches a page by the `agent.changed` a session's create publishes, which is what
  `20-elsewhere.png` receives. The workspace form alone publishes nothing, so that one arrives with its first session,
  the next reconnect or a relaunch, and there is no poll of the list here to shorten that. The web waits the same way,
  bar its refetch on window focus.
- **A Mac's runner rows.** The 15-second runner refresh was iOS's alone. It runs on the Mac now, because a Set up row comes
  and goes with what it reads.
- **`RUNNER_WORKSPACES_FOOTER` stays declared.** These pages no longer draw it. It stays in `RunnerPageCopy.swift` and the
  web's `runnerCopy.ts` only because Android's page still says it, and Android's `RunnerPageTest` and the parity test
  read those two files. Android's P1b takes it out of all three.
- **Rule 12 on these clients.** Add Runner's next step says Start a session, as the web's guide does. The empty machine
  says the web's sentence without its "or add one here", as these clients have no form to add one.
