# Condition triggers on the web: the real build beside the board

Shots of the real web console (`npm run build` of `src/web`, served by `vite preview`) on the fixtures in
`src/web/ui-migration/condition-fixtures.mjs`, one per frame 2 to 6 of
[`docs/mocks/condition-triggers/01-board.png`](../../../mocks/condition-triggers/01-board.png). Each `*-beside-board.png`
sets the shot beside the board's frame. Taken by `src/web/ui-migration/condition-triggers.capture.mjs`:

```sh
cd src/web && npm run build && npx vite preview --port 4391 &
node src/web/ui-migration/condition-triggers.capture.mjs http://127.0.0.1:4391
```

| Frame | Shot | What it shows |
| --- | --- | --- |
| 2 | `2-task-create-card.png` | The task create card in a conversation: Starts when (condition, how it is checked, the command), Today, If never |
| 3 | `3-schedule-create-card.png` | The schedule create card: When (condition with its hold, re-arm and check line, the command), Today |
| 3 | `3b-schedule-create-card-repeat-cloud.png` | The same card with a repeat, on an Orbit Cloud workspace: the repeat and keeps-awake lines |
| 4 | `4-scheduled-page.png` | The Scheduled page: "Waiting for a condition" with each row's newest reading and its age and a gauge; Can't read under Needs you |
| 5 | `5-run-session-fired.png` | A run its condition started: the header names the firing instead of a planned time |
| 6 | `6-waiting-on-you.png` | Waiting on you: the can't-read card (Pause, Look into it) and the 30-day question (Keep waiting, Stop) |
| 6 | `6-inspector-condition.png` | The inspector: Condition (reading, age, gauge bar, firing and re-arm lines), How it checks, Fired and Ready again in the history |
| 6 | `6b-inspector-repeat-cloud.png` | A repeating condition on Orbit Cloud: the repeat line, the keeps-awake line, Fired again in the history |
| — | `extra-widen-command-card.png` | The widen card for a changed probe command, both commands verbatim |
| — | `extra-task-waiting-line.png` | The waiting line on a startWhen task |

The board is drawn on iOS; the web shows the same content in its own page, inspector panel and cards. Readings, times
and names are demo data.
