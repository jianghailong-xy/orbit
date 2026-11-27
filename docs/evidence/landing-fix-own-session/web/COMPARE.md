# Web against the ruled board — landing fix by the task's own session

Board: `docs/mocks/landing-fix-own-session/` (`04-web-session.png`, `05-web-landing.png`, `06-web-project.png`),
ruled **Approve as drawn** by the owner on 2026-11-22. Captures: the real production build of this branch
(`kit/run.sh`), light and dark, 1440 px wide at 2x, Asia/Shanghai clock frozen at the board's times. The kit's reads
carry exactly the fields the server sends since S5 (the landing-fix turn's words, `landing.state = FIXING`, the three
timeline kinds, `withWorkSession` / `workSession`, task `integration.state = FIXING` + `workSessionId`).

The board drew each web frame with the parts of 2026-11 (`landing-session/v4`, `landings-one-window`). Since then the
Landings window on main became a chat (`landings-chat-bubbles`, `landings-chat-trigger`, `landings-chat-tools`); the
ruled elements are drawn into today's window, in the same words, order and doors. Where a frame shows two moments at
once (a: the card and the "again" line; b: Fixing and the later generation), the kit shoots each moment.

Legend: ✅ as drawn · ≈ same element, today's chrome · ⚠ differs (why)

## a · the task's own session (`a1-session-card`, `a2-session-again`)

| # | Board element | Web | |
|---|---|---|---|
| ① | Card on Orbit's side, amber wash, eyebrow `⚠ FROM ORBIT · LANDING`, pill `Conflict` at the right | `.landing-fix-card`, warning tokens, same eyebrow and pill | ✅ |
| ① | Title `Orbit could not land your work on project/…` | same | ✅ |
| ① | `Conflict while rebasing onto the project branch at 41ac9e0. Nothing was pushed.` (sha in code, last sentence bold) | same | ✅ |
| ① | Files box, one path per line, monospace | same | ✅ |
| ① | Steps 1–3: Merge the project branch… / Run what failed… / Commit, then end your turn. | same, read from the turn | ✅ |
| ① | Foot: `Orbit lands the new commit and runs the checks again. Do not push the project branch. Not yours to fix? End your turn without committing and say why. · Open landing ›` | same; `Open landing ›` opens the landing the turn names | ✅ |
| ② | The session's reply below the card | the agent's own reply | ✅ |
| ③ | `↻ Landing 4be19c2 again · Open landing ›` centred pill under the reply | `.landing-fix-again`, in the place of the session's landing label, while the fix's attempt is the landing's newest and unsettled | ✅ |
| ③ | Left column: `Landing · Fixing`, `conflict · its own session is on it`, task, `onto project/…`, `The task's session is fixing it · 4m · round 1 of 2`, `Open Session` + `Open landing ›` | same card (today's landing card parts), Fixing in purple | ✅ |
| ③ | Session row: `Landing · the task's session is fixing it` | same, on the project's sessions page | ✅ |
| — | Nothing at the session's bottom while it fixes (a ① moment) | today's session landing label `Landing · conflict ›` (red) stays until the fix lands again, then becomes ③ | ⚠ the board drew no frame of this moment; the label was left as it is |
| — | Board frame shows the left card at Fixing while the again line shows | a1 shows Fixing; a2 (after the fix) shows today's in-flight landing card instead, since the item is being landed again | ≈ two moments |

## b · landing window, Fixing (`b1-landing-fixing`, `b2-landing-again`)

| # | Board element | Web | |
|---|---|---|---|
| ① | State word **Fixing**, purple (not amber, not red) | status card head `Fixing · its own session is on it`, purple mark and words | ≈ today's status card |
| ① | `Conflict in 2 files while rebasing onto … · nothing was pushed` | the window's reply sentence and the attempt's steps say it (today's chat window) | ≈ |
| ① | `👤 The task's session is fixing it · 4m · round 1 of 2` | same line, person mark | ✅ |
| ① | Doors `Open Session` (primary) · `Open Task` | same | ✅ |
| ① | Left column card is the same head | same as a ③ | ✅ |
| ② | Row `👤 Handed to the task's session` / `It wrote this work · round 1 of 2` | same, on its own line after the attempt's steps, newest row bold | ✅ |
| ② | Row `↑ Fixed in 4be19c2 · landing again` | same, opening generation 2 (b2), followed by the attempt's trigger `From the task's session · Fix` | ✅ |
| ② | Generation 2 written on after 10:09 (faded on the board) | b2: generation 2's steps and `Landed … on the second try` | ≈ |
| ③ | Footer `Decisions: the task's own session first, then the coordinator` | the footer line `Orbit runs these landings · Decisions: the task's own session first, then the coordinator` while a landing is Fixing | ≈ today's footer |

## c · handed back (`c-handed-back`)

| # | Board element | Web | |
|---|---|---|---|
| ① | Quote box: *The task's session ended its turn without a new commit:* “…its last words…” | same, from the work session's last words (the column the server quotes) | ✅ |
| ① | State back to `Not landed` | `Not landed · waiting for a decision` (today's waiting card) | ✅ |
| ① | `👤 Coordinator has it · just now` | same | ✅ |
| ① | Doors `Open Coordinator` (primary) · `Open Session` · `Open Task` | same | ✅ |
| ② | Row `→ Returned to the coordinator: no new commit` / `Its last words are on the card above.` | same row; second line says **below** | ⚠ the web window draws its card under the record, so "above" would point at nothing |
| ② | Hand-off row now plain, `round 1 of 2` | same | ✅ |
| — | Left column: `Landing · Not landed`, amber card, `Coordinator has it · just now`, `Open Coordinator` + `Open landing ›` | same | ✅ |
| — | Left column detail `conflict · rebasing onto the project branch` | `conflict · nothing was pushed` | ⚠ the open-items read the column draws from carries no phase |
| — | Footer `Decisions: the coordinator · Open coordinator ›` | today's footer: `Orbit runs these landings` + `Open coordinator` | ✅ |

## d, e · project page (`d-project`, `e-task-row`)

| # | Board element | Web | |
|---|---|---|---|
| ① | Open items group `BEING FIXED BY ITS SESSION · 1`, purple | same | ✅ |
| ① | Row `👤 Landing conflict · A10c …` / `The task's session is on it · 4m · round 1 of 2 · nothing was pushed` / `Open session ›` | same | ✅ |
| ① | Not counted in Needs you | header still `0 need you`; the item is in no Needs you list | ✅ |
| — | (fixture) Coordinator card reads `Cannot be opened` | the kit's coordinator read is minimal; not part of this ruling | — |
| ① | `NEEDS YOU · 0` heading, `WITH THE COORDINATOR · 1` group | not drawn: the web card has no empty Needs you heading and no With the coordinator group today | ⚠ outside this ruling's elements |
| ② | Task row `Landing · fixing`, presses into the task's own session | purple tag; a link to the work session | ✅ |
| ② | Other rows `Landing · checking`, `Landed` | today's words (`Integrating · checking`, `On project/…`) | ⚠ unchanged by this ruling |
