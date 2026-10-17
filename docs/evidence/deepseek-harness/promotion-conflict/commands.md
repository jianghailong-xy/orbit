# Commands and verification — promotion-conflict

## Environment setup (worktree has no committed node_modules)

The worktree ships without `node_modules`; the acceptance build needs these, none of which are
product changes (all live under the gitignored `node_modules/`):

- `cp -al /root/orbit/node_modules ./node_modules` (hoisted workspace deps), plus
  `cp -al /root/orbit/src/web/node_modules ./src/web/node_modules` and
  `cp -al /root/orbit/src/apiserver/node_modules ./src/apiserver/node_modules`.
- `prisma generate` (from `src/apiserver`) — the apiserver `tsc` build requires the generated
  Prisma client; `node_modules/@prisma/client` is a shim until generated.
- `@base-ui` and its transitive deps (`@floating-ui/utils`, `@floating-ui/react-dom`,
  `@floating-ui/dom`, `@floating-ui/core`, `reselect`, `use-sync-external-store`) are absent from
  `/root/orbit`; copied from another worktree's `node_modules` (`324aaa25…`).

## Conflict check before resolution

```
git merge-tree --write-tree 6a35f1564 096463785   # exit 1 — 5 conflicts (see conflicts-before.txt)
```

## Conflict check after resolution

```
git merge-tree --write-tree HEAD refs/heads/main   # exit 0, no conflicts
```

## Acceptance command (as declared)

```
git merge-tree --write-tree HEAD refs/heads/main \
  && npm run build \
  && npm test -w @orbit/shared \
  && npm test -w @orbit/apiserver \
  && npm test -w @orbit/web \
  && (cd src/runner-go && go test ./...)
```

Run with `NO_COLOR=1`, no pipe (per repo convention). Overall exit code **0**.

## Results (per stage, real exit codes)

| stage | result |
|---|---|
| `git merge-tree --write-tree HEAD refs/heads/main` | exit 0, single tree `ab53fab8…`, no conflicts |
| `npm run build` (shared + apiserver + web) | exit 0 |
| `npm test -w @orbit/shared` | 23 test files passed (23), 384 tests passed (384) |
| `npm test -w @orbit/apiserver` | `tsc -p tsconfig.test.json` then `node --test`: pass 4378, fail 0 |
| `npm test -w @orbit/web` | 305 test files passed (305), 3853 tests passed (3853) |
| `(cd src/runner-go && go test ./...)` | `ok orbit 204.698s`; `? orbit/cmd/release-manifest [no test files]` |

The six in-scope files pass individually:
`WorkspaceView.acceptanceConfirmationCard` (18), `WorkspaceView.criteriaDecisionCard`,
`WorkspaceView.promotionPlacement` (13), `WorkspaceView.settlementPointer` (9),
`CriteriaDecisionCard.receipt` (2), `CriteriaDecisionCard.sessionSwitch`.
