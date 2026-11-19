# Orbit Cloud browser · real-page shots (frames 4–9)

Taken from the shipped web build (`npm run build`, served by vite preview) by
[`src/web/ui-migration/runner-browser.capture.mjs`](../../../../src/web/ui-migration/runner-browser.capture.mjs):
the UI-migration fixtures answer the API, and a small RFB server on the real viewer WebSocket route stands in for
the runner's x11vnc. It draws a staged page and counts the pointer and key events that reach it.

| Shot | Board frame |
| --- | --- |
| [`4-session-browser-chip.png`](4-session-browser-chip.png) | ④ the Browser chip in the session's outputs (and [`4a-session-switch-off.png`](4a-session-switch-off.png): no chip while the server reports the browser off) |
| [`5-drawer-view-only.png`](5-drawer-view-only.png) | ⑤ the drawer, view only |
| [`6-take-control.png`](6-take-control.png) | ⑥ Take control: "You are controlling the browser · the agent keeps running", orange outline; the typed `!` reached the runner |
| [`7-hand-back.png`](7-hand-back.png) | ⑦ Hand back: view only again |
| [`8-settings-browser-section.png`](8-settings-browser-section.png), [`8b-clear-saved-logins-confirm.png`](8b-clear-saved-logins-confirm.png) | ⑧ Settings → Orbit Cloud: Browser, and Clear saved logins' confirmation |
| [`9-settings-open-browser-in-control.png`](9-settings-open-browser-in-control.png) | ⑨ Open browser: in control from the start, Done |
| [`real-page-frames-4-9.png`](real-page-frames-4-9.png), [`beside-board-2.png`](beside-board-2.png) | all six, and beside board 2 |

[`input-log.json`](input-log.json) records what reached the stand-in runner in each frame. Frames 5 and 7 (view only,
with a click and a key pressed on the canvas) received nothing. Frames 6 and 9 (in control) received the clicks and
keys. No frame made a write request to the server, so taking control and handing back sent nothing to the session.
