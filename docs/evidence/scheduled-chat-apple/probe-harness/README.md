# TEMPORARY evidence probe — never merged as an app

Task 354CXjOML0uOFkSP36f4M: the Scheduled page's chat in the iPhone, iPad and Mac apps (docs/scheduled-chat-design.md §6,
board `docs/mocks/scheduled-chat/01-board-4.png`). Adapted from the Wiki chat's probe
(`docs/evidence/wiki-chat-ios/probe-harness`). It builds the iOS app's own shells (`CompactShell` on an iPhone,
`MainView` on an iPad at a regular width, as `OrbitiOSApp`'s RootView picks them) and the Mac app's own `MainView` from
the tree's shared sources into throwaway apps pointed at `stub.py`, each launch opening the Scheduled section
(`ProbeArgs.land`). A fresh launch also forgets the chat's open-or-closed on the device.

`stub.py` serves board 4's account — four schedules (two active, two paused), and one Scheduled chat, "Move the audit",
whose first turn moved Nightly dependency audit to weekdays at 07:00 (a change line with Undo) and whose second answer
offers `[Run now](orbit-run-now:sch1)`. Stage `new` (`POST /__set`) has no chat yet, for Orbit's opening.

| test | what it photographs and checks |
|---|---|
| `testPhoneSheetNameOpensTheScheduleAndChatGoesBack` | iPhone: the toolbar's Chat button, the chat never open by itself; the sheet at medium, then large with the Run now button; the change line's name and Undo; the name opens that schedule's sheet with ‹ Chat; ‹ Chat goes back to the chat |
| `testPhoneNewChatShowsOrbitsOpening` | iPhone: a new chat's opening and Runs in |
| `testColumnOpensBesideAndIsRememberedOnTheDevice` | iPad and Mac: never open the first time; the button opens the third column (beside the inspector on a Mac); the name opens the schedule with no ‹ Chat; open, then closed, remembered across launches |

Every write is answered 409: the probe presses nothing that changes data. All data is made up.

Run on a Mac with Xcode and XcodeGen: `bash run.sh` (`PASSES=ios`, `ipad` or `mac` for one). Pictures and notes land
in `shots/<pass>/`.

`mac-shots.sh` launches the Mac probe app directly with `-probe.inspect sch2 -probe.chat YES -probe.capture <png>
-probe.windowWidth <points>`: a row selected, the chat's button pressed in code, the window set to 1010 and then 1460
points and rendered by the app itself (`ProbeArgs.capture`), so a window wider than a CI runner's 1024-point screen is
photographed whole. It needs a logged-in screen; orbit-ws05's Mac mini has none, so the Mac pass and these pictures run
on GitHub's macos-26 runner (`client.shots.yml`, put in place of `.github/workflows/client.yml` on a probe branch only).

Sample names are neutral: workspaces `dev-box` (on "Mac mini") and `laptop` (on "MacBook").
