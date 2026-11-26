# Scheduled page chat: board 01

Board for [docs/scheduled-chat-design.md](../../scheduled-chat-design.md) (revision 2; owner chose A on D1–D6, 2026-11-26). Sample data only.

| PNG | Shows |
| --- | --- |
| `01-board-1.png` | Today vs the docked chat at 1460 px: header Chat button, list · inspector · chat, chip, change line with Undo, row flash |
| `01-board-2.png` | 1280 px (sidebar folds to icons) and 1024 px (slide-over), and the width bands |
| `01-board-3.png` | A card while the panel is closed, the envelope card in the chat, Run now as your press, empty account + offline Runs in |
| `01-board-4.png` | iPhone toolbar button, chat sheet, a schedule's sheet from a change line; macOS and iPad notes |
| `01-board-5.png` | Decisions D1–D6 and what gets built |

Render: `node render.mjs "$PWD/01-board.html" "$PWD" 01-board` (playwright-core 1.63 from any worktree, chromium-1243, `FONTCONFIG_FILE` for Inter/Noto). It writes one PNG per `section.b-part`.
