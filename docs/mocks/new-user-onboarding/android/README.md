# Android: the welcome card beside the web

Android's take on the welcome card the web shipped in 40bd23aa2 (board 02, the owner's picks A/A/A/A). Every sentence comes from
`src/web/src/lib/welcomeCopy.ts` (`WelcomeCopy.kt`, held to it word for word by `WelcomeCopyParityTest`).

- `1-managed.png` … `5-register.png`: each web page in `../after/` beside the Android frame of the same state.
- `frames/`: the emulator frames (API 36, 1080×2400, halved). `WelcomeCardDeviceTest` drew them. It runs in the
  `increments` device kit against its own fixture, which serves the runner, workspace and managed-runner states that
  `capture/after.mjs` serves the web. `6-history-*` are the same accounts with one Completed session: today's pages, with no card.

The iOS/macOS welcome card has not landed, so the web is the reference here.

Matched to the web on the owner's ruling (strict parity, 11-12):

- **Landing.** A new account whose only workspace is its managed runner's default lands straight on that workspace's draft, with the
  card showing and no tap (`1-managed` is that cold launch). Back reaches the workspace's list. An account that has had a session keeps
  today's landing on the list (`frames/6-history-managed-landing.png`).
- **Step 2's sign-in.** On the welcome card, managed and bare machine, it reads "Sign in to <engine>", with "Use an API key instead"
  beside it and the web's hint under them. The bare machine's card also keeps its "Use <other CLI> instead" links, and the managed card
  draws none, as on the web. With no key that runs there, "Use an API key instead" opens Machines & models, as the web opens
  `/infrastructure#keys`. The shared `RunnerSignInCard` gained these words as options, and its two buttons now wrap onto a second
  line when they don't fit on one, instead of the second being squeezed (on a phone, "Use an API key instead" was). Every other
  screen that uses it keeps its words, including the setup card of an account that has had a session ("Sign In", "Use an API Key").

## Differences from the web, and why

| # | Web | Android | Why |
|---|-----|---------|-----|
| 1 | One wide page: the draft sits beside the workspace list, and the examples fit on one line. | One column. The card scrolls above the composer, and the examples wrap to two lines. | Phone width. |
| 2 | The card stands in for the managed runner's notice and the engine hero. | It stands in for the draft's "Engine" row. | Android has no engine hero and no managed runner notice. Its managed runner reading (`ManagedRunner.kt`, held to the shared fixture) is new, and only the card uses it. |
| 3 | Notice: animated dots, a blue box. | A Material progress ring, primary-tinted. Attention states are amber. | Android's own spinner and colour tokens. |
| 4 | "Use my own computer instead" opens `/runners/register`. | It opens the Add machine sheet: the install command, and the device code. | Android's registration flow. |
| 5 | No machine: the command box with Copy on its right. "Having trouble?" has no target yet (a TODO). | Android's dark command box with Copy under it. "Having trouble?" opens the Add machine sheet, whose "No browser?" path is the help it has. | The command box is the Add machine sheet's own. A link that does nothing is not drawn on Android. |
| 6 | The no-machine card is the registration guide's welcome branch. | It is the home page of an account with no machine, shown only when the server offers no managed runner. | A managed-runner account gets its default workspace instead, as on the web. |
| 7 | The page moves on to the machine's draft once one connects. | The runner list is read every 5 s. Once one is online, the directory is read again and the launch's landing opens the machine's setup page. | Same result. Android's landing rule does the move. |
| 8 | Picking an example fills the composer and focuses it. | The same. The keyboard opens. `3-ready` is taken with the keyboard put away. | Platform. |
