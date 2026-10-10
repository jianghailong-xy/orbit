# The start dialog's close button sat on the card's corner

Reported 2026-10-10 with a screenshot of the "Start this project?" dialog and an arrow at its
top-right corner: the dialog's close ✕ straddled the card's own top-right corner, its lower arm
cutting through the card's blue border — an element crossing a surface boundary, which reads as a
mistake. It is the same in the P4.3b delivery and reference shots (`p43b-start.*`), so the Base UI
migration neither made nor broke it: the two title-less dialogs (`start-card-dialog`,
`project-done-dialog`) draw their content at the dialog's own 20px padding, and the close — absolute
at `top: 12px; right: 12px; 32×32` (`components/ui/Overlay.css`) — ends 44px down, over the card.

## The fix

One rule in `src/web/src/index.css`, on the empty title row the card already starts after:

```css
.start-card-dialog > .orbit-overlay-header { height: 36px; margin-bottom: 0; }
```

The close keeps its place at the dialog's corner; the 36px row (its box plus the 12px it keeps from
the dialog's edges) moves the card down so it starts *under* the close, which is what
`Overlay.css`'s own note about a title-less dialog claims ("starts its content under it").

## What the numbers say

Measured on the real page (dialog-relative px, 1280×900 @2x):

| | before | after |
|---|---|---|
| close box | `y 12–44` (32×32, `right 12`) | `y 12–44` (unchanged) |
| card's top edge | `y 30` (20px dialog padding + the card's 10px margin) | `y 66` (padding + the 36px row + margin) |
| card's top vs the close's box | **−14px** (the card under the button) | **+22px** (clear) |
| dialog height | 1166.3 | 1202.3 (36 taller, as the reserved row says) |

The dialog's ✕ ink sits at `y 22–34`, so before the fix it crossed the card's border by ~10px — the
detail the arrow pointed at.

## What the shots show

| Shot | What it is |
|---|---|
| `01-corner-3x-before-after.png` | the top-right corner at 3× — the ✕ cutting the card's border, then clear of it |
| `02-dialog-top-before.png` / `03-dialog-top-after.png` | the dialog's top band, as it was and as it is |
| `04-dialog-before-after.png` | the whole dialog, before and after — nothing but the card's start moves |

## How they were taken, and why they are not a mock

`kit/shot.mjs` drives the real project page and the real `ProjectStartDialog` on the ui-migration
P4.3b fixtures (`src/web/ui-migration/`), through vite and Playwright, vite and Chromium inside one
`unshare -n` (the host's docker veths otherwise abort the dev server's module loads):

```
bash docs/evidence/start-dialog-close-corner/kit/run-ns.sh shot.mjs        # INJECT=1 adds the rule to the open dialog
INJECT=0 OUT=<dir> bash .../run-ns.sh shot.mjs                            # the tree as it stands, twice
```

`01` and `04`'s "after" halves are the tree as it stands (`INJECT=0`, the rule committed in
`index.css`); the injected candidate and the built tree are pixel-identical
(`PIL.ImageChops.difference` → `bbox=None` on both the corner and the top-band clips), so the board
does not flatter the build.

## Tests

`npx vitest run` over the specs that draw or read this stylesheet: `StartProjectCard`,
`WorkspaceView.projectSessions`, `ProjectsPage`, `TaskListView`, `ProjectTasksTopology`,
`InfrastructurePage.machines`, `RunnerDetailPage.layout`, `ProjectTaskRow.opening`,
`firstPageStylesheet` — 281 passed.

## Left alone

`project-done-dialog` has the same shape (its row is `margin-bottom: 0`, its title hidden, its card
at the dialog's padding), and its ✕ lands on the card's own "FROM ORBIT" chip
(`docs/evidence/base-ui-migration/p4.3b/shots/delivery/chromium-light-desktop/p43b-done.png`). Not
touched here: one report, one change. The same rule fixes it.
