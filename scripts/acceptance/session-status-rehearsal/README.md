# The `session.status` rehearsal, D1 to D2 (task T16)

The kit for [docs/session-status-retirement-plan.md](../../../docs/session-status-retirement-plan.md) §7.2 and §7.3;
what it showed is in [docs/session-status-rehearsal.md](../../../docs/session-status-rehearsal.md). Everything runs on
one isolated stack: loopback only, the Compose project `orbit-link-t16`, state under `/mnt/tmp/t16`. Nothing reaches
production, and no production row is read.

| File | What it does |
|---|---|
| `build-images.sh` | The apiserver at D1 (`D1_REF`, where T2 landed: migrations 1611/1612, code on the word) and at D2 (`D2_REF`, the project tip), and the link gateway, each from a `git archive` of its commit. `WEB_IMAGE` is retagged as the web (the walk reads no page) |
| `rehearse.sh` | The steps: `up` (both apiservers at D1, through `scripts/acceptance/landing-measured/stack.sh`), `rewind` (D1's down script on the fresh database, so it is as production is before D1), `seed`, `d1`, `census`, `gate`, `backfill`, `plans`, `d2` (apiserver-b replaced by D2 code, which migrates while D1 serves), `post-gate`, `migrations`, `stop-load`, `down` |
| `seed-shapes.cjs` | Every row shape the projector is pinned over (`WORD_SHAPES`), as a writer before D1 leaves it, with production's measured counts where there are any, and each released shape filed in Completed and in Trash too. Beside `scripts/session-status-query-plans-seed.sql` (101,358 sessions) |
| `writer-loop.cjs` | Writes as code before D2 does, the word only, every 100 ms, and times every statement: what a writer waits behind a migration |
| `sample-locks.sh` | Every 0.2 s, each backend waiting on a lock, what it waits for and who holds it |
| `census.cjs` | For every row, the stored word against `legacySessionStatus` (the projector itself), runState and sessionState from each, `phase` against `deriveSessionPhase`, `turn_state` against the word's; one line per kind. Exit 1 on a changed word outside §3.4's kinds, a held row whose word changes, or a fact that disagrees |
| `walk.mjs`, `walk.sh` | One walk pass, §7.3's scenarios against a real runner (go build of `src/runner-go`) whose only engine is the fake claude, read back from the database. `--code` says which deploy's writer the two statement rows follow |
| `recheck.mjs` | An earlier pass's sessions, read from another replica (S12) |
| `compare.mjs` | Pass against pass, scenario by scenario, and a recheck's payloads |
| `load.mjs` | API and runner load for a hand-over (T17): a second runner, and the owner's calls (sessions made, followed up and ended, the session lists, task runs batch-stopped) sent in turn to the serving containers, each call recorded with the release that answered |
| `seed-c8.sql` | The four §3.4 C8 rows T16b found on the production backup, which the shapes lack (D2-era: it names the column) |
| `windows.mjs` | The records by window: lock waits, every HTTP error by release, the writer loop's statements and rows |

**D3 to D4 (task T17).** On a database D4 migrated (no `session.status`): `census.cjs` reports the projector's words
and checks `phase` only; `seed-shapes.cjs` writes the facts; `writer-loop.cjs` takes `WRITER_CODE=d3` (and
`WRITER_CYCLE=parked`, which leaves no cycled row RUNNING for the reaper to release); `walk.mjs` takes `--code d3|d4`
and reads words through the projector. The D1/D2 scripts `rehearse.sh` calls for the plans, the backfill, the SQL
census and the phase down script are D2-era: they need the column. So the copy is seeded at D2 and handed to D3.1 before
1711 runs. `build-images.sh` takes `SIDES`, and `rehearse.sh` the steps of its header from `stop-slots` on. A hand-over
is the upgrade skill's: `next <side>` starts the new release beside both slots (it migrates as it boots, answering to
`apiserver` too), `replace a|b <side>` replaces each slot in turn, and `next-stop` ends it. `census-pair` runs the census
in two releases' images in one exported snapshot, so they count the same rows while the load writes. The run of
2026-11-27, with every command, is in docs/session-status-rehearsal.md under "D3 to D4":

    SIDES="d2=5a08c866c4 d3=feeb45cf16 d31=7474f16158 d4=<project head>" PROJECT=orbit-link-t17 WEB_IMAGE=<web image> \
      scripts/acceptance/session-status-rehearsal/build-images.sh /mnt/tmp/t17
    export LM_PROJECT=orbit-link-t17 LM_DIR=/mnt/tmp/t17/lm OUT=/mnt/tmp/t17/out LM_HTTP_PORT=58086 ...   # every LM_*_PORT
    UP_SIDE=d2 $R/rehearse.sh up; $R/rehearse.sh stop-slots; KIT_IMAGE=$LM_PROJECT-apiserver:d2 $R/rehearse.sh seed
    $R/rehearse.sh seed-c8; $R/rehearse.sh replace a d31; $R/rehearse.sh replace b d31     # 1671 at the first boot
    $R/rehearse.sh census-pair c1 d31 d4; KIT_IMAGE=$LM_PROJECT-apiserver:d31 $R/rehearse.sh writer-on; $R/rehearse.sh load-on
    $R/walk.sh wd31 http://<apiserver's address>:3000/api d3
    $R/rehearse.sh next d4                                                                  # 1711 at its boot
    $R/walk.sh h1-mix http://<apiserver's address>:3000/api d3                              # D3.1 beside D4
    $R/rehearse.sh replace a d4; $R/rehearse.sh replace b d4; $R/rehearse.sh next-stop
    $R/rehearse.sh drop-down; ... next d31, replace a d31, replace b d31, next-stop          # the rollback
    $R/rehearse.sh load-off; $R/rehearse.sh stop-load; node $R/windows.mjs $OUT <name>=<from>..<to> ...; $R/rehearse.sh down

Run, in order (each step writes its records into `$OUT`, default `/mnt/tmp/t16/out`, and a line into `timeline.log`):

    D1_REF=1b4e3290a0 WEB_IMAGE=<an existing web image> scripts/acceptance/session-status-rehearsal/build-images.sh /mnt/tmp/t16
    R=scripts/acceptance/session-status-rehearsal
    $R/rehearse.sh up; $R/rehearse.sh rewind; $R/rehearse.sh seed; $R/rehearse.sh d1
    $R/rehearse.sh census pre-backfill; $R/rehearse.sh gate pre-backfill      # the gate must refuse
    $R/rehearse.sh backfill; $R/rehearse.sh census post-backfill; $R/rehearse.sh plans before-d2
    $R/walk.sh w1 http://127.0.0.1:57086/api d1                               # D1 code on both replicas
    $R/rehearse.sh d2; $R/rehearse.sh post-gate
    $R/walk.sh w2 http://<apiserver-b>:3000/api d2                            # D2 code beside a D1 replica
    $R/rehearse.sh plans after-d2; $R/rehearse.sh census after-d2
    docker stop orbit-link-t16-apiserver; $R/walk.sh w3 http://<apiserver-b>:3000/api d2
    node $R/compare.mjs /mnt/tmp/t16/out w1 w2 w3
    $R/rehearse.sh stop-load; $R/rehearse.sh down

`WALK_ONLY=S8r,S12` runs the end the runner does not honour (two minutes of the reaper's cancel grace) and nothing else.

What the copy is not: production. It is the plans seed (one busy runner with 44,073 sessions, 73 held; nineteen others)
plus every projector shape, so the census counts kinds the seed holds, not production's; the plan (§7.1) asks for the
newest nightly backup, which needs the owner's go.
