# Activity's Plan card under server execution — `System model · about 1–2 hours`

Evidence for 「服务端执行时，Plan 卡写「System model · about 1–2 hours」（web 和 macOS/iOS）」, the
follow-up to P6 that closes the line board 35 left as "留给 P6、另议".

Owner's call 2026-10-08: while the server executes the account's wiki, the line beside **Draft plan**
reads `System model · about 1–2 hours`; under runner it is the provider's, word for word as before. The
duration is not touched until P10 measures it in production.

## The screenshots

| file | what it shows |
| --- | --- |
| `activity-plan-server.png` | the whole Activity page, server execution (`executor.serverExecutes: true`), 1440×1100 @2x |
| `activity-plan-server-card.png` | the Plan card alone, the same shot |
| `activity-plan-runner.png` | the same page under runner, for the "word for word unchanged" half |
| `activity-plan-runner-card.png` | the Plan card alone under runner |
| `activity-plan-*.txt` | what the DOM held under each shot: the line, that Draft plan is beside it, and the card's foot |
| `plan-card-shot.mjs` | the harness that took them |
| `SHA256SUMS` | the four PNGs and the harness, as hashed |

The two lines, as the browser rendered them:

```
<button …><span>Draft plan</span></button><span class="hint">System model · about 1–2 hours</span>   # server execution
<button …><span>Draft plan</span></button><span class="hint">local-vllm · about 1–2 hours</span>      # runner
```

## How they were taken

The real web page of this branch, served by vite (`npx vite --port 5273`) with a fake API, as board 35's
screenshots were made — **no deployment is switched for this**. `plan-card-shot.mjs` is the harness:
Playwright intercepts `/api/**`, answers a space whose plan is `none` (`confirmed`, `draft`, `proposals`
and `job` all empty) with a runner workspace and the maintenance provider `local-vllm`, and shoots the
page twice — `executor.serverExecutes: true`, and `false`. Run it from `src/web`:

```bash
cd src/web && npx vite --port 5273 &
node ../../docs/evidence/wiki-plan-server-note/plan-card-shot.mjs          # server execution
node ../../docs/evidence/wiki-plan-server-note/plan-card-shot.mjs runner   # runner
```

Production screenshots come with P10's canary, as the coordinator arranged.

## What the words are held to

`src/shared/src/wiki-server-execution.fixture.json` → `plan.note`. The web reads it in
`src/web/src/lib/wikiPlan.test.ts` (`WIKI_PLAN_NOTE_SERVER`, `wikiPlanCard`, `wikiPlanEmptyNote`) and the
native end in OrbitKit's `WikiServerExecutionCopyParityTests` (`WikiPlanCopy.noteServer`,
`WikiPlanCopy.emptyNote`), so the two ends cannot drift into two sentences. Under runner both keep the
line `wiki-docs.fixture.json` already held.
