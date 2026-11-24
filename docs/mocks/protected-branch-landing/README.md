# Protected-branch landing: design board

Board for `docs/design/protected-branch-landing.md` §11 (task "Design board: landing setting and pull-request landing states").
All copy is English. Light and dark are drawn; iOS is the layout reference for Android.

| Image | What it shows |
|---|---|
| `01-setting-web.png` | The workspace landing setting: options A, B, C; option A in its other states (Push as me on, GitHub not connected, after a refusal, not a GitHub workspace, permissions not accepted, dark); the label question |
| `02-landing-card-web.png` | The landing card in each state (a opened, b waiting for review, c check failed, d main moved, e merged, f Push as me fell back to a pull request, plus closed and direct push); three placements of the "Faster" tip; dark mode |
| `03-phones.png` | The setting and the card states on iOS and Android, light and dark |

`build.mjs` regenerates the HTML and PNGs: `node build.mjs <path to playwright-core/index.mjs>`.
The coordinator's two preview attachments could not be fetched from this session, so the board redraws them from the design doc's copy and the app's colour tokens.

## Choices for the owner

| # | Question | Recommended | Alternatives |
|---|---|---|---|
| 1 | Where the setting lives | **A.** A "Landing" section with both choices visible (Pull request · Default, Push as me · Faster) | B. One "Land work by" dropdown row under Sessions. C. A single "Push as me" switch |
| 2 | Label of the default | **Keep "Pull request"** with a Default badge; the description says Orbit pushes when GitHub allows it | "Follow branch rules"; "Pull request if required" |
| 3 | The "Faster next time" tip | **1.** Inside the review-wait card, dismissible, hidden once Push as me is on | 2. No tip. 3. Only a "Landing settings ›" link in the card's actions |

## Owner's choices

The owner confirmed the board on 2026-11-23 with the recommended option on all three:

1. **Setting: A.** A "Landing" section in workspace settings with both choices visible: Pull request (Default badge) and Push as me (Faster badge).
2. **Label: keep "Pull request"** with the Default badge. Its description says Orbit pushes when GitHub allows it and opens a pull request when main requires one.
3. **Tip: 1.** "Faster next time: Push as me" sits inside the waiting-for-review landing card, is dismissible, and is not shown once Push as me is on.
