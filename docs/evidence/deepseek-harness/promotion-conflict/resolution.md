# Promotion-conflict resolution — DeepSeek Harness integration

## Sources and trees

| role | ref / commit |
|---|---|
| merge-base | `5b73f4717e17bb077f829b3fd4f1e04ba1245c02` |
| project tip (ours) | `6a35f15646bc406f4219c3552efc899f253413e5` (project/34ZurCP3bv9yLXGVyUGnx) |
| main tip (theirs) | `0964637855907292d0143e86acd2fed117e4c32f` |
| resolution commit | `0f40f88abbef42e208a0d35185272552227f3c99` (merge, parents = project tip + main tip) |

Note: the task brief named main tip `58c42783b5439d25a6674463170916f131da28de`, but main had
advanced to `096463785` by execution time (a further "Chat about this" / open-item round merged in
via project/34Y7). The conflict set was re-derived against the current tip, and the same
six-file scope held (plus a new apiserver ledger-spec conflict, see below).

## Conflicts (reproduced with `git merge-tree --write-tree <project-tip> <main-tip>`)

Five files conflicted. Two more were auto-merged and reviewed for semantics.

1. `src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts` — NEW (main advanced).
2. `src/web/src/components/WorkspaceView.acceptanceConfirmationCard.test.tsx`
3. `src/web/src/components/WorkspaceView.criteriaDecisionCard.test.tsx`
4. `src/web/src/components/WorkspaceView.promotionPlacement.test.tsx`
5. `src/web/src/components/WorkspaceView.settlementPointer.test.tsx`

Auto-merged and reviewed: `CriteriaDecisionCard.receipt.test.tsx`,
`CriteriaDecisionCard.sessionSwitch.test.tsx`.

## Root cause

The compact-review-card change (`9198bdfd4`, `feat(macos): show long decision cards as compact
previews with review sheet`) broke 30 tests across 6 web files. Two projects independently fixed
them:

- **Project side** (`ddf1cce09` "migrate card integration checks to preview dialogs") migrated the
  WorkspaceView tests to the *preview → dialog portal* structure, assuming a narrow-only rendering.
- **Main side** (`eebda088d` "restore compact review card integration regressions", plus
  `a38fb021e` "arm decision card hotkeys by default on wide screens", `d74d09176`, `23ee64d89`
  "keep Enter on a focused link from answering the card") expressed the *final* contract.

The final product (`ReviewCard.tsx`) renders `{children}` inline on wide screens and a
`review-card-preview` button + `review-card-dialog` on narrow screens (`useIsMobile`). The project
side's tests reflect an intermediate, narrow-only reading; main's tests are the final, wide+narrow
reading.

## Resolution strategy

For the four web WorkspaceView files and the two CriteriaDecisionCard contract files, the
resolution **adopts main's versions**. Rationale: main's test files already express the full
contract —

- `WorkspaceView.acceptanceConfirmationCard` carries an explicit `narrow` flag and
  `it.each([false, true])` for the two cases where wide and narrow differ (settings-preserved
  close/reopen; Enter only reaches an opened review).
- The data/decision contract of the criteria card runs through the `inlineReviewCard` mock
  (`vi.mock('./ReviewCard', () => import('../test/inlineReviewCard'))`) so receipt/sessionSwitch
  assert the decision payloads directly.
- The generic preview→dialog mechanics (click opens a portal, close/reopen keeps the draft,
  closed/stale reviews suspend hotkeys, focus returns to the preview) are covered once, in
  `ReviewCard.test.tsx` ("compact review dialogs" / "full reviews on wide screens").

Mapping the project side's assertions to main's coverage:

| project-side assertion | where it is covered in main's suite |
|---|---|
| preview count / position | `count('#settlement-preview')`, `count('.review-card[id^="criteria-decision-"]')` |
| click really opens a portal | `ReviewCard.test.tsx` compact-review cases |
| close/reopen keeps the input | `ReviewCard.test.tsx` + acceptanceConfirmationCard `narrow` branch |
| route switch cleans up | wide-mode "leaves no card behind" / "leaves no line on New session" tests |
| closed/stale shortcut protection | `ReviewCard.test.tsx` "suspends background hotkeys" etc. |
| precise request/receipt assertions | receipt/sessionSwitch decision-payload assertions |

No product code (rendering, permissions, dsh) was changed to make tests pass; the only non-test
edit is the apiserver ledger spec, resolved below.

## The apiserver ledger spec (mechanical)

`task-judgment-data-preserved.spec.ts` lists every migration after 0375. Both sides appended to the
same list: the project added `0377_dsh_runner_gate`; main added `0378..0382`. The migration
directories on the merged tree contain all of 0377 and 0378..0382 (no number collision), so the
resolution keeps both in numeric order:

```
'0376_android_push_installation',
'0377_dsh_runner_gate',        // project (dsh runner admission)
'0378_open_item_hand_over',    // main
'0379_open_item_fix_link',     // main
'0380_owner_integration_retry',// main
'0381_task_reopen_landing_intent',// main
'0382_pool_credential_throttle',  // main
```

## The two auto-merged contract files

`CriteriaDecisionCard.receipt.test.tsx` and `sessionSwitch.test.tsx` auto-merged into an
**incoherent mix**: main's `inlineReviewCard` mock (renders the full form inline, no dialog) was
combined with the project side's `reviewDialog()`-based `approveButton()` helper (which searches a
dialog that the mock never renders). That mix would never find the approve button. The files were
reset to main's versions, which are internally consistent (inline mock + `approveButton(node)`).

## Final tree

`git merge-tree --write-tree HEAD refs/heads/main` → exit 0, no conflicts.
The merge commit has both parents, so main is an ancestor of the resolved branch and the promotion
candidate merges cleanly.

## Command results

See `commands.md` for each command, its real exit code, and raw output pointers.

## Limitations

- The project side's narrow-only WorkspaceView tests (preview→portal in situ) are not kept verbatim;
  their behaviour is covered by `ReviewCard.test.tsx` and the `narrow` branches in
  `WorkspaceView.acceptanceConfirmationCard.test.tsx`. This is a deliberate deduplication, matching
  main's own test design.
- The narrow-mode "open dialog then navigate away cleans up the portal" path has no dedicated test in
  main's suite; route cleanup is asserted in the wide mode. The portal is removed by React on
  unmount, so the behaviour is structural. Not re-added here to stay within the six-file scope and
  to avoid duplicating `ReviewCard.test.tsx` coverage.
