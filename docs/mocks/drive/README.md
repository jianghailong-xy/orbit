# Documents · design board

The account's drive, drawn from [`docs/drive-product-design.md`](../../drive-product-design.md) (D1–D23 and rules 1–8, settled 2026-11-19).
iPhone is the reference design; web, Mac and Android follow it. Start with the index.

| Board | What it holds |
| --- | --- |
| [`00-index.png`](00-index.png) | Every screen named with the decision it shows, and the open points for the owner |
| [`01-ios.png`](01-ios.png) | iPhone, 18 frames (also the phone layouts): left menu, Files, a folder with who wrote each file, picture and Markdown preview, row menu, Move, resumable uploads, share link (clean and with the secret warning), Trash, an earlier version, Storage, composer drive picker, reply linking a drive file, and the uploads sheet with an agent's directory sync (its states and failure details) |
| [`02-web.png`](02-web.png) | Web console, 8 frames: sidebar + tree/list/preview, Markdown + row menu + rename, drag-and-drop with the upload tray, Move with New folder, share link with the secret warning, Trash, Storage, composer picker + reply links |
| [`03-mac.png`](03-mac.png) | Mac app, 4 frames: sidebar, list and inspector with a Finder drop; Share Link sheet; Trash and Storage; the upload popover with an agent's directory sync |
| [`04-android.png`](04-android.png) | Android app, 15 frames in Material 3 with the app's own colours: drawer, Documents, a folder with Undo, row actions sheet, Upload with the system pickers, the background-upload notification, uploads sheet with an agent's sync, picture preview, Move, share link with the secret warning, Trash, Storage, a dark folder, composer picker, sync details |
| [`05-web-consistency-1.png`](05-web-consistency-1.png) … [`-5`](05-web-consistency-5.png) | Web Drive made consistent with the session console (2026-11-27): today vs proposed drawn with the shipped stylesheets, the three session-page patterns borrowed, the open Trash/Storage placement choice, and the landing order by cost. `05-web-consistency.png` is the whole board |

## How it is made

- Hand-drawn HTML sharing [`board.css`](board.css), [`icons.js`](icons.js) (inline SVG icons) and [`marks.js`](marks.js) (numbered marks placed on `data-mk` elements).
- Rendered with [`render.mjs`](render.mjs), which adds Inter, Noto Sans SC and JetBrains Mono from the kit in `/mnt/tmp/band-glass-mock` (override with `MOCK_KIT`), and Roboto for the Android phones from `MOCK_ROBOTO`, and waits for the fonts:
  `node render.mjs "$PWD/01-ios.html" "$PWD/01-ios.png"` (likewise `02-web`, `03-mac`, `04-android`, and `index.html` → `00-index.png`). `05-web-consistency` links the shipped web stylesheets and takes a third argument, `parts`, to also write one PNG per section.
- Names, sessions, sizes and dates are demo data.
