# Native shots: managed runner entry on iPhone and Mac (board 3)

Built from this tree's own shared sources and shells (`src/macos/OrbitApp`, `src/ios`), pointed at a
stub that serves the managed-runner states from
`src/shared/src/managed-runner-states.fixture.json` verbatim, with two of the account's own machines
(`workstation`, `laptop`) already there. iPhone on the iOS simulator, Mac in its own window.

| Shot | What it shows | Beside the board |
| --- | --- | --- |
| `1-entry.png` | Machines & models: the managed runner's Set up banner above the account's two machines | `1-entry-beside-board.png` |
| `2-confirmation.png` | Set up on an established account asks first (D3), in the design's words | `2-confirmation-beside-board.png` |
| `3-after-setup-page.png` | The REQUESTED answer opened the managed runner's machine page: its banner and state label, and Resources and Engines each "Available once the runner is ready." | `3-after-setup-page-beside-board.png` |
| `3-after-setup-row.png` | iPhone, back on the list: the managed runner is one machine row reading Preparing | `3-after-setup-row-beside-board.png` |
| `4-ready-page.png` | The same runner once it reports: Ready, the ordinary machine page | `4-ready-page-beside-board.png` |
| `5-asleep-row.png` | A sleeping managed runner: its row reads Asleep, with "Wakes automatically when you start a session" whole; its workspace row in the sidebar says Asleep too | `5-asleep-row-beside-board.png` |
| `6-composer-asleep.png` | A conversation on its workspace: the shared composer line, sending allowed | `6-composer-asleep-beside-board.png` |
| `7-picker-asleep.png` | Change workspace: Asleep, never "Runner offline" | `7-picker-asleep-beside-board.png` |
| `8-feature-off.png` | The switch off: Machines & models as today, and this launch logged no GET /managed-runner | `8-feature-off-beside-board.png` |

The Mac's window shows the machine list and the managed runner's page side by side, so its
`3-after-setup-page` and `3-after-setup-row` are the same picture; the iPhone is a stack and shows
them as two. The Mac's confirmation and Change workspace pictures are the sheets themselves
(`2-confirmation`, `7-picker-asleep`): this host's login keychain is locked, and its unlock prompt
covers the screen. The window images are the app's own window bitmaps, which contain no other
process's window; the two sheets are captured from the app's own sheet windows.

`requests.log` beside each platform's shots is the stub's log: `MANAGED-RUNNER READ` marks every
GET /managed-runner. The feature-off pass asserts none after its own launch (its line count is in
`managed-reads.txt`; earlier launches in the same pass do read the status).
