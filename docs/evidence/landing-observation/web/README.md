# R29-10 · web: delivery mode, the two items, the task row's observation words

Contract: `docs/project-integration-line-contract.md` §10.7, §10.8, §10.9 (revision 29), §7.1 V2, §7.6 V13.
Every frame is the real web app: this branch's production build (`npm run build` in `src/web`), served
from loopback, signed in with the repo's `src/web/ui-migration/fixtures.mjs`, with each scene's reads
layered over the fixtures. Light and dark, 2x, clock frozen at the fixtures' 2026-09-28 12:00Z.

Reproduce: `(cd src/web && npm run build) && unshare -n docs/evidence/landing-observation/web/rig/run-ns.sh`
(optionally `<scene>` or `<scene>-<theme>` arguments). `capture-results.jsonl` is the last run's output:
the text each shot drew, page errors and API calls no fixture answered (none in this run).

| Frame | What it shows |
| --- | --- |
| `start-agent-push-*` | The start card on a main line, Delivery set to "The agent pushes it": its hint, the Automatic sentence without "Each merge into main still asks you", and no "Each merge into main" under Comes to you |
| `start-delivery-menu-*` | The Delivery menu open: both ways, each with what it means |
| `start-project-branch-*` | The start card on a project branch: Delivery locked on "Orbit lands it", with why (the door's 409 `DELIVERY_MODE_NEEDS_MAIN_LINE`) |
| `settings-agent-push-*` | How it runs on a started main line: the line is locked, the delivery mode is not; the agent pushes |
| `settings-project-branch-*` | How it runs on a project branch: "The agent pushes it" disabled, with the same reason |
| `task-rows-*` | `Waiting to be seen on main · 9f1c2ab` (frozen commit), `Waiting to be seen on main` (not frozen yet), `On main`, and the task waiting on them |
| `open-items-agent-push-*` | Open items rows: `Not on main yet: …` with the reason and short delivered commit, `Observing main… — running / queued`, and the failing observations' item |
| `open-items-platform-*` | Open items row: `Reached main without your confirmation: …` with its receipt line |
| `card-landing-unobserved-*` | The coordinator's `LANDING_UNOBSERVED` card: §10.7 title, the server's doors with Observe again, Chat about this |
| `card-observing-*` | The same kind handed to the owner: its title kept as the first line under the hand-over heading, and the observation it asked for running |
| `card-observe-failing-*` | `IE:observe`: Observe again as its one, leading door |
| `observe-dialog-*` | Observe again's dialog asking for the reason the door requires |
| `card-landed-without-confirmation-*` | `LANDED_WITHOUT_CONFIRMATION`: §10.7 title, the receipt, Accept leading |
| `pinned-strip-*` | The conversation's pinned line naming it `Landed without your confirmation` |
| `conversation-agent-push-*`, `conversation-landed-without-confirmation-*` | The coordinator conversation whole: session row and header word, pinned line, sidebar count, cards at their moments |
| `owner-confirmation-agent-pushed-*` | The owner confirmation card of an AGENT_PUSH project's task: If you confirm says `Pushed to main by the agent; Orbit records it once it sees the commit there`, and that confirming merges nothing |
| `projects-list-*` | The projects list chip `Needs you · Landed without your confirmation · 2h` |

The web has no cross-conversation banner; the native banner's `Landed without your confirmation · <project>`
is the kind word the session row and header above already say (`OWNER_ITEM_LANDED_WITHOUT_CONFIRMATION`).
