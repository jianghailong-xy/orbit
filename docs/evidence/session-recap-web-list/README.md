# The session list's recap line (0418)

Evidence for task `34d0xzHwt00tVjTa8NjSB` (project `34d0oH4R6LErqqsox7wYv`, criterion
`4Xb25ApIMbMGVVdKjhimQg`): the web session list prefers the server's rolling recap over the raw
last reply, and still shows live state while a session is working.

## What the shots show

`shots/light-list.png` / `shots/dark-list.png` — the list column of the real `WorkspaceView` built
from this tree, with three rows:

| Row | Fixture | Reads |
|---|---|---|
| Recap on the session list row | parked, `recapText` + `recapAt` | `Recap · 5:38 PM` (muted) then the recap |
| Drawer shadow fix | parked, `lastAssistantText` only | the flattened last reply, no label |
| Rebuilding the transcript page | RUNNING with `lastToolUse`, and a recap of the turn before | `Running task_create…` |

`shots/*-full.png` are the same windows whole. `shots/report.json` is what the capture read off
each row (title, line, label); the run exits non-zero if any row reads as anything else.

## How it was taken

Built from the task's branch (`orbit/web-session-recap-a48f29`) with `npm run build`, then the real
app is served from `src/web/dist` on loopback and fed the repo's own `ui-migration` fixtures plus
the three sessions in `lib.mjs` — the recap row is the real `sessionLine` and the real row markup,
not a mock of them.

```sh
npm run build -w @orbit/shared && npm run build -w @orbit/web
node docs/evidence/session-recap-web-list/capture.mjs
```

`capture.mjs` writes `shots/` and fails if a row's line is not exactly what the table above says.
The other front the same change is tested on is `src/web/src/components/WorkspaceView.recapRow.test.tsx`
(the three states through the real component, in jsdom) plus the precedence cases in
`WorkspaceView.sessionLine.test.tsx`.
