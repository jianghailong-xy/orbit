# Verification tiers: the fast gate on the task, the full run at the merge boundary

Every task used to run the whole API acceptance. On 2026-09-01 that cost about eight machine-hours
in one day — nineteen task-side attempts averaging fourteen minutes, plus ten more runs by hand —
to answer a question the run was not able to answer. Every red that day was red **after** a merge,
not on the branch that produced it: the branch runs were green, and two downstream tasks then
failed against what the merge had left behind.

So the money was being spent in the wrong place. A branch run tells you about the branch. The risk
is at the merge.

| Tier | What it is | Target | When |
|---|---|---|---|
| **Fast gate** | `tsc --noEmit`, build-orphan detection, and the specs this change is answerable for | **≤ 90s** | Every task, as often as you like |
| **Full run** | `npm run test:outcome-reconciler:full-api` — every compiled spec, one disposable database and role per case | ~25–30 min | **Once at the merge boundary**, by whoever merges — not once per task |
| **Release DAG** | `npm run test:outcome-reconciler:release-dag` | hours | Once, after the whole line of work is finished |

## The fast gate

```sh
npm run test:outcome-reconciler:fast-gate              # run it
npm run test:outcome-reconciler:fast-gate -- --dry-run # print what it would run, run nothing
ORBIT_FAST_GATE_SPECS='sessions/.*\.spec\.ts$' npm run test:outcome-reconciler:fast-gate
```

Three stages, in this order:

1. **Build orphans.** `tsc --build --clean` cannot remove the output of a source file that no
   longer exists — the build info it consults has no record of a file the current include set never
   saw. The full run enumerates `src/apiserver/build/**/*.spec.js`, so every stale artifact becomes
   an extra case run against a tree that no longer contains what it tests. Three of them turned
   into three phantom reds in one evening. Fix: `rm -rf src/apiserver/build`.
2. **`tsc -p tsconfig.test.json --noEmit`.** `--noEmit` on purpose: this stage must not be able to
   leave an artifact behind, because stage 1 is the thing that notices artifacts.
3. **The specs this change is answerable for.** A changed spec selects itself; a changed source
   file selects its `.spec.ts` / `.pg.spec.ts` / `.http.spec.ts` siblings; anything else selects
   nothing. `.pg` specs are listed but deferred — they need the disposable server the full run
   provisions, and every one of them reports itself skipped without it, so running them here would
   turn "no database" into a green.

## The fast gate is not a merge gate

It says so in its own output, every time it runs, because the whole risk of having a cheap gate is
that somebody merges on it.

**Before merging, run the full acceptance once.** The fast gate cannot see the failures that
matter most:

- A change that touches only `prisma/migrations` selects **no specs at all**. Dropping the seven
  completion-ack triggers broke twenty-one specs in `sessions/` and `runner-api/` — no dependency
  analysis could have pointed at them in advance, and the fast gate would have passed it.
- The 0217 / 0218 merges were let through on targeted gates alone (ratification 24/24, plan 64/64,
  `tsc`, the structural gate) and left four reds behind. Two downstream tasks ran into them and
  failed; one of them did a whole round of wasted work on a spec that had already been deleted.

The blast radius of a removal is not statically predictable. That is the whole argument for keeping
the full run, unshrunk, at the boundary where merges happen.

## What the full run must keep

- **The case count never goes down.** No spec may be skipped, conditionally skipped, or dropped
  from the enumeration. Tiering changes *when* the full run happens, not *how much* it runs. The
  manifest asserts `fail`, `cancelled`, `skipped` and `todo` are all zero, and every case leaves a
  receipt proving it reported at least one test.
- **Parallelism stays at 4** (`OUTCOME_RELEASE_API_JOBS`, 1–8). Lowering it to hide a failure is
  the same thing as removing the failure.
- **One disposable database, empty database and role per case** (`pccrf_cNNNN_{d,e,u}`), the
  identity read back through the case role itself before the spec may mutate anything, and a
  cleanup that asks the server rather than assuming — `resourcesRemaining=0`.

## Failures are reported when they happen, and the run keeps going

Each case appends one line to `build/outcome-reconciler-full-api-failures.log` the moment it ends
badly, and the run continues so the final list is the whole list rather than the first entry in it.
A case that failed in three seconds used to arrive twenty minutes later, behind the 298 cases that
ran after it.

A failing case prints its own inner TAP — the assertion text, not just `error: 'test failed'`. The
case runner drops `NODE_TEST_*` from the child's environment for that reason: inherited, it makes
the inner runner report to a listener that is not there, and the case comes back with empty output
and exit 0, which is a false **green**. A case that dies before producing any TAP still reports
`SPEC_FAILED | TIMED_OUT | SIGNALED | CRASHED_BEFORE_TAP exit=N elapsed=Ns timeout=Ns` plus the
tail of whatever it did write.

## "This change deletes more than it adds" may not be measured with `git diff main..HEAD`

`git diff --numstat main...HEAD` measures **where the branch stands**, not whether this change is
subtraction. On the branch it reads 8,666 deleted / 0 added; **after the merge it is 0/0 forever**,
so the assertion flips on exactly the tree it exists to protect. It was green when the task
delivered and red the moment the change landed — twice, in the same shape.

Pinning a fixed SHA only trades "flips immediately" for "flips once unrelated work dilutes it", and
requires that SHA to be reachable in a clone.

**The baseline has to be content, not a revision.** Both numbers are read out of the working tree,
so they read the same before and after a merge:

- **retired** — the lines the removed mechanism was installed with. Its creating migration is
  immutable in an append-only ledger, so no later commit can dilute it.
- **spent** — the lines this removal cost: the removal migration, plus any later migration that
  returns to the same vocabulary. Filtered by vocabulary rather than by date, so a compatibility
  shim for the removed mechanism is charged to the removal and unrelated migrations on top are not.
- Assertion 1: `spent × 5 < retired`.
- Assertion 2, absolute: at and after the removal point, no migration re-creates any dropped object.

A negative control is mandatory for this assertion: add a table back inside the removed range, and
separately add a migration that is pure line count and re-creates nothing. Both must really turn
red before being changed back. Check the vocabulary pattern is not simply dead by running it over
the installer migrations — each should match.
