# How the boards' pictures were taken

Task 34tDf8rxHzhwoGyK6r0kj. Every picture in `../shots` is a real capture of this tree (main 8480a7f2e).

- **Stack** (`rig.sh`, `gateway.mjs`, `build.sh`): postgres:16-alpine on tmpfs (127.0.0.1:5734), this tree's
  apiserver on :3734, the built web console behind a small gateway on :2734.
- **Data** (`seed.mjs`, `challenge.mjs`): the owner, a runner and task A's session (5vD9EcdOwXQIktLuv8GaOn), the two
  tasks and the tool call the challenges cite under their production ids, the `orbit` space, the four entries as
  `wiki_get` reads them, then changeset 34so6smHP5ywNOPjvYbqa's four challenges word for word through the runner door
  as that session (`POST /api/runner/wiki/changesets`), backdated 3 h. The inputs (the `wiki_propose` calls read from
  task A's own transcript, the entries, the cited tool call) live outside the repository, in the session's scratch
  directory. `restore.sh` puts the database back from a `pg_dump` of that state.
- **Web** (`capture.mjs`): Playwright on the real pages, 1440 and 390 wide, presses included. `propose.mjs` draws
  the proposal into the same real page (only the challenge card's buttons, the After row and the Retire… dialog),
  and `measure.mjs` takes the crops and the element boxes the boards' marks ring.
- **Android** (`android/`): `drive.py` drives the debug APK over adb (Server dialog through raw touch events, Wiki →
  Activity → Review, a press, the entry page's Retire…). The host's shared emulator was locked by another task, so
  it ran in `review-challenge-android-probe.yml` on a probe branch: an API 36 emulator on GitHub's runner, this
  commit's apiserver and the same database restored byte for byte (`server.sh`, `emulator.sh`).
- **iPhone / Mac**: the real apps built from this tree's sources by the probe harness of
  `docs/evidence/wiki-diagram-apple`, against a stub that answers with the stack's recorded reads.
- **Boards**: `render.mjs` renders `../NN-*.html` at 2x; `put.py` crops and squeezes captures into `../shots`.
