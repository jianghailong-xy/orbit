# Documents · design board

The account's drive, drawn from [`docs/documents-drive-design.md`](../../documents-drive-design.md) (D1–D23 and rules 1–8, settled 2026-11-19).
iPhone is the reference design; web and Mac follow it. Start with the index.

| Board | What it holds |
| --- | --- |
| [`00-index.png`](00-index.png) | Every screen named with the decision it shows, and the open points for the owner |
| [`01-ios.png`](01-ios.png) | iPhone, 15 frames (also the phone layouts): left menu, Files, a folder with who wrote each file, picture and Markdown preview, row menu, Move, resumable uploads, share link (clean and with the secret warning), Trash, an earlier version, Storage, composer drive picker, reply linking a drive file |
| [`02-web.png`](02-web.png) | Web console, 8 frames: sidebar + tree/list/preview, Markdown + row menu + rename, drag-and-drop with the upload tray, Move with New folder, share link with the secret warning, Trash, Storage, composer picker + reply links |
| [`03-mac.png`](03-mac.png) | Mac app, 3 frames: sidebar, list and inspector with a Finder drop; Share Link sheet; Trash and Storage |

## How it is made

- Hand-drawn HTML sharing [`board.css`](board.css), [`icons.js`](icons.js) (inline SVG icons) and [`marks.js`](marks.js) (numbered marks placed on `data-mk` elements).
- Rendered with [`render.mjs`](render.mjs), which adds Inter, Noto Sans SC and JetBrains Mono from the kit in `/mnt/tmp/band-glass-mock` (override with `MOCK_KIT`) and waits for the fonts:
  `node render.mjs "$PWD/01-ios.html" "$PWD/01-ios.png"` (likewise `02-web`, `03-mac`, and `index.html` → `00-index.png`).
- Names, sessions, sizes and dates are demo data.
