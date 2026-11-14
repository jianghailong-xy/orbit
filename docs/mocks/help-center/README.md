# Help center · design boards

| Board | What it covers |
| --- | --- |
| [`01-web.png`](01-web.png) | Web: the ? entry and keyboard `?`, the help drawer with "For this page" articles, reading and search in the drawer, the `/help` home (search, Get started checklist, topics) and the article page |
| [`02-ask.png`](02-ask.png) | Ask: a read-only session on your own machine that answers from the help articles and your account's read-only state, cites articles, offers buttons instead of changing anything, "Still stuck" hand-offs, the no-machine state (decided: Ask needs a machine), Your questions |
| [`03-apps-and-content.png`](03-apps-and-content.png) | macOS Help menu + inspector, iPhone and Android Help screens and Ask, where the articles live and how they ship, the first ~30 articles, what stays the same, the five decisions (owner, 2026-11-14: all as recommended) |

The boards' explanations are in Chinese for the owner; every product string drawn in the frames is English.

Re-render: `node capture/render.mjs "$PWD/<board>.html" "$PWD/<board>.png"` (Playwright and the headless shell under `/mnt/data/tmp` and `~/.cache/ms-playwright`). People and machine names are made up.
