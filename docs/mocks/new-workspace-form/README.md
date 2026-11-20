# New workspace · one form for the setup card and Settings

The owner asked on 2026-11-20 that Settings → New workspace share a page with the machine setup card (the one shown after a machine registers, before it has a workspace), and that it support GitHub. The design follows [`docs/github-workspace-design.md`](../../github-workspace-design.md) and the board [`../github-workspace/`](../github-workspace/README.md).

| Board | Contents |
| --- | --- |
| [`01-shared-form.png`](01-shared-form.png) | Today's two forms side by side; the proposal (Settings hosts the setup card's form: empty, full path with history import, From GitHub); three open decisions, each with a recommendation; phasing |

The frames are hand-written DOM over the app's own stylesheets (`index.css`, `ui/*.css`, `MachineSetupCard.css`, `Settings.css`). The board reuses `../github-workspace/board.css` and `icons.js`. Redraw with `node capture/render.mjs <absolute path to board.html>` (Playwright 1.63 from `PW_FROM`, fonts from `FONTS`).
