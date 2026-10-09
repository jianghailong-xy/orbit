# The plan's words under server execution — who drafts, and the lines beside Draft plan

Evidence for 「服务端执行时，Plan 卡写「System model · about 1–2 hours」（web 和 macOS/iOS）」, the
follow-up to P6 that closes the line board 35 left as "留给 P6、另议", and its second revision after the
coordinator's review of the first delivery.

Owner's call 2026-10-08: while the server executes the account's wiki, the wiki-worker drafts the plan
with the System model — so no sentence may name the account's provider as the drafter, and the line
beside **Draft plan** reads `System model · about 1–2 hours`. Under runner every one of those sentences
is word for word what it always was. The duration is not touched until P10 measures it in production.

## The sentences

| where | server execution | runner |
| --- | --- | --- |
| Activity's Plan card, beside Draft plan (`plan.note`) | `System model · about 1–2 hours` | `<provider> · about 1–2 hours` |
| the plan's empty page, under Draft plan (`plan.emptyNote`) | `Runs on the server with the System model — usually 1–2 hours. Until you confirm a plan, the Wiki shows its topic articles.` | `Runs as a task in the Wiki maintenance list, on <where> with <provider> — usually 1–2 hours. Until you confirm a plan, …` |
| the plan's empty page, its body (`plan.emptyText`) | `… The System model drafts it; nothing is written until you confirm it.` | `… <provider> drafts it; …` |
| Redraft…'s dialog (`plan.redraftNotes`) | `The System model drafts it again from v1, the plan in force, with what you write here. …` | `<provider> drafts it again from v1, …` |
| the drafting job's card, and Activity's drafting line (`plan.drafter`) | `System model · attempt 1 of 3 · started 12m ago` | `<provider> · attempt 1 of 3 · …` |

## The screenshots

| file | what it shows |
| --- | --- |
| `activity-plan-server.png` / `-card.png` | Activity, server execution (`executor.serverExecutes: true`), 1440×1100 @2x, and the Plan card alone |
| `plan-empty-server.png` / `-card.png` | the plan's empty page under the same switch: the body and the note |
| `activity-plan-runner.png` / `-card.png` | the same Activity page under runner, for the "word for word unchanged" half |
| `plan-empty-runner.png` / `-card.png` | the same plan page under runner |
| `activity-plan-server.txt` / `activity-plan-runner.txt` | what the DOM held: the card's line with Draft plan beside it, and the empty page's body and note |
| `plan-card-shot.mjs` | the harness that took them |
| `SHA256SUMS` | every PNG and the harness, as hashed |

The card's line, as the browser rendered it (from `activity-plan-*.txt`):

```
<button …><span>Draft plan</span></button><span class="hint">System model · about 1–2 hours</span>   # server execution
<button …><span>Draft plan</span></button><span class="hint">local-vllm · about 1–2 hours</span>      # runner
```

## How they were taken

The real web page of this branch, served by vite (`npx vite --port 5273`) with a fake API, as board 35's
screenshots were made — **no deployment is switched for this**. `plan-card-shot.mjs` is the harness:
Playwright intercepts `/api/**`, answers a space whose plan is `none` (`confirmed`, `draft`, `proposals`
and `job` all empty) with a runner workspace and the maintenance provider `local-vllm`, and shoots
`/wiki/orbit/activity` and `/wiki/orbit/plan` twice — `executor.serverExecutes: true`, and `false`. Run
it from `src/web`:

```bash
cd src/web && npx vite --port 5273 &
node ../../docs/evidence/wiki-plan-server-note/plan-card-shot.mjs          # server execution
node ../../docs/evidence/wiki-plan-server-note/plan-card-shot.mjs runner   # runner
```

Production screenshots come with P10's canary, as the coordinator arranged.

## What the words are held to

`src/shared/src/wiki-server-execution.fixture.json` → `plan` (`drafter`, `note`, `emptyNote`, `emptyText`,
`redraftNotes`). The web reads it in `src/web/src/lib/wikiPlan.test.ts` and
`src/web/src/components/WikiPlanPage.test.tsx`, the native end in OrbitKit's
`WikiServerExecutionCopyParityTests` (`WikiPlanCopy.drafterServer`, `noteServer`, `emptyNoteServer`,
`emptyText`, `emptyNote`, `redraftNote`, `WikiPlanLogic.jobCard`) — which also looks each constant up in
the web source, so the two ends cannot drift into two sentences. Under runner both keep the rows
`wiki-docs.fixture.json` already held, word for word.

## The native compile

`client.yml` compiles both shells (macOS: OrbitKit's tests + an OrbitApp `swift build`; iOS: an
`xcodebuild` for the Simulator) and the merge check does not — it is one Linux container. This delivery
changes three OrbitApp files (`WikiPlanView.swift`, `WikiDocScreens.swift`, `WikiModel.swift`), so a
probe branch was pushed for those jobs: see `ci/` for the run, its jobs and their conclusions.
