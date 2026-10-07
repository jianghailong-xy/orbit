# A12 Wiki / Watch fixed-source baseline and Android implementation

This document records the development input at the ordinary merge below. It is a source inventory, not a frozen iOS installation or proof of a cross-platform business run. The approved product scope remains Kotlin + Compose, Android 10–16 / minSdk 29 / GMS phones. S1 and D09 physical-device requirements are unchanged.

## Identity and inheritance

| Identity | Value |
| --- | --- |
| A12 initial HEAD | `3cb12b3be2a38c55601786bdfa1967f60a86990a` |
| Required inherited A07 | `51bbcc303cec3c64dfb217316afce9498add760d` |
| Ordinary merge | `0f98546a5eed77ec0f41181296c33bdf037f161d` |
| Merge parents, in order | initial HEAD, required inherited A07 |
| `contracts` tree at merge | `16996d541211aacdd18c89bb6d9849ebef2b3d02` |
| `src/apiserver` tree at merge | `c0aa1a79ded9d330c38acfb668e746e80d768b1b` |
| `src/shared` tree at merge | `de5d906751a4f57018c24f30c6ef0bca61ddf911` |
| `src/macos` tree at merge | `2689ba528cc644d9d39b8e62e662dcc4396793cc` |

`git diff 51bbcc3 0f98546 -- src/apiserver src/shared contracts src/macos` is empty. Relative to the A12 initial HEAD, backend and contracts are unchanged; shared adds only `interaction-cards.fixture.json` and `interaction-cards-review.fixture.json`. These inherited files are not A12 authored changes. A06 reader / Markdown / image / link / record-anchor behavior and A08 cards are inherited dependencies, not permission to rewrite those modules. No main tracking, rebase, project-line reset, public push or deployment is part of this work.

Read-only runtime inventory on 2026-10-05: Docker returned five PostgreSQL test containers and no apiserver/web container. The checked-in `src/apiserver/src/health/health.controller.ts` exposes a constant liveness response, not a build identity. This does **not** establish the actual deployed backend/shared SHA, and does not imply a remote deployment is absent. A deployed image digest/build SHA, API contract identity and authenticated role evidence must be attached in the later real-resource run.

## Source authorities

The paths below are relative to the repository root, read at the merge above.

- iOS actual entrances: `src/macos/OrbitApp/Sources/OrbitApp/Views/CompactShell.swift`, `WikiScreens.swift`, `WikiDocScreens.swift`, `WikiView.swift`, `WikiArticleView.swift`, `WikiDocView.swift`, `WikiSettingsView.swift`, `WikiPlanView.swift`, `WikiRunView.swift`, `FollowingView.swift`, `WatchViews.swift`, `WatchingCard.swift`, `WatchWakeCardView.swift`, `TaskDetailParts.swift` and the Followed by section of `TasksView.swift`.
- Reads, mutations and refresh behavior: `src/macos/OrbitApp/Sources/OrbitApp/WikiModel.swift`, `WatchesModel.swift` and `src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift`.
- Shapes and policy: OrbitKit `Models/Wiki*.swift`, `Models/Watches.swift`; `App/WikiLogic.swift`, `WikiModeLogic.swift`, `WikiArticleLogic.swift`, `WikiDocLogic.swift`, `WikiHealthLogic.swift`, `WikiPlanLogic.swift`, `WatchStateMachine.swift`, `WatchEditing.swift`, `WatchProjection.swift`, `WatchWake.swift`, `DeepLink.swift`.
- Contracts: `contracts/wiki.contract.json`, `contracts/watch.contract.json`. A contract/API operation is not, by itself, evidence that iOS exposes a button for it. `OrbitLink.swift` deliberately leaves Wiki web page URLs external while `orbit-wiki:<id>` opens an entry internally; its Copy link creates `/wiki/<spaceSlug>/e/<id>`. Preserve inherited Android URL support without interpreting this as a new iOS internal-page protocol.

## Wiki entrance and operation map

| Actual iOS entrance | Read / behavior / permitted mutation | Android acceptance observation |
| --- | --- | --- |
| Drawer Wiki → home | Space picker; status/health; search under title; review banner; plan banner; Principles, Recent decisions, Recently changed, Agents used the wiki | Preserve band order, selected space, loading/error/empty distinction and returned server counts |
| Home Contents button → sheet | Home, Browse, Index, Plan; category/topic/article hierarchy before a confirmed plan, category/document/section hierarchy after one | `docsDirectory.plan != null` selects documents, not an independently invented top-level page |
| Browse / index | `articles`, `article-index`, `topics/:slug`; or `docs`, `doc-index` | Alphabetical index and category browsing open the correct article part or document section |
| Article page | Title/topic/part, structured paragraph blocks, footnotes, cited entry groups; a topic with no article can show entries | Show source/entry context and stale/unwritten distinctions; support Contents return |
| Document page | Confirmed plan's document/sections, scope, sentence marks, footnotes and via entries | Section address scrolls to the named section; show unsourced, unverified and withdrawn content, with reasons |
| Footnote/source sheet | Original quote, record/repository locator, verdict, excerpt and original-object action | Open the original session record/task/project/file; Back returns to the same Wiki context |
| Entry page | Details, Sources, Anchors, Where it's used, History; badges for trust, anchor state, pinned, web derived | Reuse rich text/link/card primitives; retain ended entries and show ended styling |
| Entry Edit / Supersede / Retire / Copy link | Title+summary edit; replacement inherits kind/fields/topics/aliases/clean anchors; retirement requires reason; deployment Wiki URL | Preserve base revision and per-action idempotency; only send anchor input keys, never returned `check` |
| Active unreviewed entry | Confirm and Reject(reason) | Confirm only appears for `active + unreviewed` in iOS |
| Active auto entry | Reject(reason), no Confirm button | API permits broader confirm than actual iOS UI; do not silently expand the entrance |
| Home Review banner → Review | Pending ops across spaces, tabs All/Add/Amend/Retire, one-card pager, proposing session, source/diff context | Accept/Reject/Edit; retire proposal Keep/Retire; challenge Re-confirm/Amend/Retire; clamp pager after external changes |
| Review Edit | Owner title+summary over proposal | An amend carries through proposed fields/topics/aliases/anchors; challenge Amend sends changed fields only and forbids an unchanged submission |
| Recently changed → run | Changeset summary, applied/pending/refused ops, verification and source run | Revert run only when server-projected run is revertible; re-read authoritative state afterward |
| Home gear → Wiki settings | Manual/Tiered/Automatic, Automatic spot checks, automatic fallback reason | Settings stay inside Wiki; spot checks disabled outside Automatic |
| Wiki settings Maintenance Set up/Edit/Turn off | Workspace, provider, daily run limit, lookback | Lookback supports since-now `0`, positive days, all-history `null`; changing settings never rewinds an established cursor |
| Plan banner / Contents Plan | Current/draft/history versions, document and section detail, proposal diffs, job progress/held/failure | Actual iOS entrance exists; this must not be dropped merely because entry/review work is smaller |
| Plan mutations | Redraft with instructions; confirm draft; edit document/section; accept/reject plan proposal | Preserve base version; show `WIKI_PLAN_STALE`, gate `errors[]`, held workspace/provider or runner-offline reason; never fabricate generated text |

The fixed iOS entry toolbar presents Edit/Supersede/Retire and lets the server reject invalid status/kind/revision combinations. A decision is never amended by contract; it is superseded. A principle is owner-written. Owner-only user mutations must not inherit an acting-session header. A live unreviewed/tainted entry must not be presented as already sent to agents. Rejected/retired/superseded entries and source history are still readable audit records when the server permits them.

## Android implementation (A12 code)

Every Wiki route goes through `wiki/WikiDestination.kt` to a typed screen over the account's one `WikiStore` (`wiki/WikiStore.kt`, the port of iOS `WikiModel`), which reads and writes through `WikiClient` on A03's authenticated handle. Wire types, copy and derivations are ports of OrbitKit (`WikiWire.kt`, `WikiPlanWire.kt`, `WikiCopy.kt`, `WikiLogic.kt`, `WikiReadingLogic.kt`, `WikiPlanLogic.kt`) held to OrbitKit's own test cases over the same shared fixtures. Watch is `watch/` over one `WatchStore` (iOS `WatchesModel`) and the OrbitKit ports `WatchWire.kt`, `WatchLogic.kt`, `WatchProjection.kt`. A page binds its iOS toolbar title/actions into the shell's TopAppBar through `PageBar`; iOS sheets are `ModalBottomSheet`, alerts `AlertDialog`, the app toast `WikiToast`. No new drawer row or top-level page was added: the drawer keeps A05's Wiki row (now with iOS's amber count) and Following stays off the drawer.

| iOS (Swift) | Android (Kotlin) | Route / entry |
| --- | --- | --- |
| `CompactShell.wikiRow` (drawer row, amber proposals count) | `MainActivity` drawer item badge → `WikiDrawerCount` | drawer |
| `WikiHomeView`, `WikiHomePage`, `WikiHomePlaceholder` | `WikiHome.kt` `WikiHomeScreen` | `WIKI`; `orbit://wiki/<spaceId>` selects that space |
| `WikiContentsScreen`, `WikiContentsSheet` | `WikiChrome.kt` `WikiContentsSheet`, `wikiGo` | sheet |
| `WikiEntryView`, `WikiEntryPage`, `WikiEntryForm` | `WikiEntry.kt` `WikiEntryScreen` | `WIKI_ENTRY`; `orbit-wiki:<id>` |
| `WikiReviewView`, `WikiReviewPage`, `WikiReviewCard`, `WikiChallengeAmendForm`, `WikiProposalForm` | `WikiReview.kt` | `WIKI_REVIEW` |
| `WikiRunView`, `WikiRunPage` | `WikiRun.kt` | `WIKI_RUN` |
| `WikiArticleScreen`, `WikiTopicEntriesPage`, `WikiArticlePage`, `WikiFootnoteCard`, `WikiTagFlow` | `WikiArticles.kt`, `WikiArticlePage.kt` | `WIKI_ARTICLE` |
| `WikiBrowseScreen`, `WikiIndexScreen`, `WikiBrowsePage`, `WikiIndexPage`, `WikiDocsBrowsePage`, `WikiDocsIndexPage` | `WikiArticles.kt`, `WikiArticlePage.kt`, `WikiDocPage.kt` | `WIKI_BROWSE`, `WIKI_INDEX` |
| `WikiDocScreen`, `WikiDocPage`, `WikiDocMarkLabel`, `WikiDocMarkBubble`, `WikiDocFootnoteSheet` | `WikiDocs.kt`, `WikiDocPage.kt` | `WIKI_DOC` (section address scrolls once) |
| `WikiPlanScreen`, `WikiPlanPage`, `WikiPlanJobCardView`, `WikiPlanGateView`, `WikiPlanChangeCard`, `WikiPlanDocPage`, `WikiPlanSectionPage`, Redraft/Edit/Section-edit sheets | `WikiPlanScreens.kt`, `WikiPlanPage.kt`, `WikiPlanDocPages.kt`, `WikiPlanSheets.kt` | `WIKI_PLAN`, `WIKI_PLAN_DOC`, `WIKI_PLAN_SECTION` |
| `WikiSettingsView`, `WikiSettingsPage`, `WikiMaintenanceForm` | `WikiSettingsScreen.kt` | `WIKI_SETTINGS` |
| `FollowingListView`, `FollowingRow`, `FollowingPlaceholder` | `watch/FollowingView.kt` | `WATCH` (no id) |
| `WatchDetailView`, `WatchDetailContent`, `WatchTargetRow` | `watch/WatchDetail.kt` | `WATCH` (id); `orbit://watch/<id>` |
| `WatchingCardStack`, `TargetStanding` | `watch/WatchingStrip.kt` `SessionWatches` (above the composer in `SessionReader`) | session |

Where a press goes (`WikiNav`): a page a Wiki page opens is pushed on the stack the Wiki page is on, so Back returns to it. A document footnote's source opens the session at the quoted record (`OrbitRoute(SESSION, id, recordId)`, what `orbit://session/<id>?at=<record>` opens; the session alone when the record cannot be named, as iOS falls back); an entry's turn source opens the session and a task source the task, as iOS's entry page does. Contents' Home returns to the Wiki home under the page (iOS `popToRoot`); a plan version picked replaces the page on top (iOS `replaceTop`). A watch record not opened from Following gets Following under it on the same stack (iOS's `.watch(id)` opens the Following section with the record on top), so Back from a linked watch lands on Following and then on the link's source.

Refresh: the account stream reaches pages only as A04's `invalidationRevision`, so any account event (and every reconnect) nudges the Wiki/Watch re-read while one of their pages is up, debounced; iOS nudges the Wiki only on `wiki.changed` and watches only on session/approval/task events. Pull-to-refresh is where iOS has `.refreshable`.

### Deliberate platform differences

- Top-bar actions and titles live in the shell's TopAppBar; iOS principal title blocks (Review's count line) are a second title line. A bar title is one line ending in an ellipsis when the bar's buttons leave too little room, as iOS's inline titles are; the watch record's headline, cut first at large type, is also its overview section's header, as on iOS.
- Sheets are Material bottom sheets (the article footnote card can be dragged to full height); confirmation dialogs are `AlertDialog`s; iOS Menus/Pickers are `DropdownMenu`s; steppers are −/+ buttons; list reordering in the plan's Edit sheet is ↑/↓/remove buttons with TalkBack labels instead of drag handles.
- iOS's trailing swipe (a run's Reject) is a swipe that snaps back and asks for the reason, also reachable as a TalkBack custom action.
- The A–Z section index is a letter strip beside the list (letters jump; drag scrubs); each letter is a button for TalkBack.
- Touch targets are at least 48dp; the strip's letters are the one knowing exception (20dp tall so A–Z fits).
- A document opened at a section scrolls there once (no 300 ms delay) and keeps the reader's place on Back.
- The Wiki toast expires by elapsed time, so a toast posted by a popped page never reappears on the next page.
- Watch lists are decoded leniently (a row missing a field reads it empty; a row without an id is skipped), overlapping reads keep the newest, and a control's answer survives an older list read — iOS fails the whole list on one bad row and has that race.
- The Set up form's options are read with `GET /workspaces`, `/runners`, `/providers` when Settings opens (iOS uses its app-wide agents model), falling back to A05's directory data.

### Differences that belong to other modules (reported, not changed here)

- A08: `cards/SessionCards.kt` shows Pause/Resume/Stop cards for every watch whose observer is the session, beside A12's read-only Watching strip; iOS's session shows only the strip. The A08 watch-wake transcript card has no iOS "View watch" button (iOS routes it to `.watch(id)`; A12's WATCH route accepts it).
- A11: the task "Follow task" sheet and "Followed by" rows (iOS `TaskFollowSheet`) are implemented by A11 in `tasks/` and open `OrbitRoute(WATCH, id)`; A12 provides the WATCH destination, not a second subscription component.
- A05: `DirectoryRunner` does not decode `displayName`, so the maintenance "where" label uses the runner's `name` (iOS `displayName ?? name`).
- A04: event types are not exposed to pages (see Refresh above).

## Wiki API map

All paths are below `/api`; IDs must use the existing public-ID conversion, encoding and authenticated transport.

| Area | Endpoints |
| --- | --- |
| Home | `GET wiki/spaces`; `GET wiki/spaces/:id?include=usage`; `GET wiki/spaces/:id/entries?limit=200`; `GET wiki/spaces/:id/timeline`; `GET wiki/spaces/:id/health` |
| Search | `GET wiki/search?q=<query>&space=<spaceId>`; cancellable/debounced by the UI |
| Articles | `GET wiki/spaces/:id/articles`; `GET wiki/spaces/:id/articles/:slug[/:part]`; `GET wiki/spaces/:id/article-index`; `GET wiki/spaces/:id/topics/:slug` |
| Entry and review | `GET wiki/entries/:id?include=sources,history,exposure`; `GET wiki/review[?space=<id>]`; `GET wiki/changesets/:id`; `POST wiki/changesets/:id/decide`; `POST wiki/spaces/:id/changesets` |
| Owner confirmations/settings | `POST wiki/entries/:id/confirm`; `POST wiki/entries/:id/reject`; `POST wiki/changesets/:id/revert`; `PATCH wiki/spaces/:id` |
| Documents | `GET wiki/spaces/:id/docs`; `GET wiki/spaces/:id/docs/:slug`; `GET wiki/spaces/:id/doc-index` |
| Plan | `GET wiki/spaces/:id/plan`; `GET wiki/spaces/:id/plan/versions`; `GET wiki/spaces/:id/plan/versions/:version`; `POST wiki/spaces/:id/plan/redraft`; `POST wiki/spaces/:id/plan/versions/:version/confirm`; `POST wiki/spaces/:id/plan/edits`; `POST wiki/plan-proposals/:id/decide` |

Successful mutations re-read affected objects/home/review/settings. A 409 is a stale request, not a completed mutation. No optimistic success may survive a refused write. A cross-owner Wiki object/document is a plain 404 by contract; do not disclose its existence through an alternate name or cached body.

## Original-record navigation contract

`WikiDocFootnote` turn/event/tool_call carries both `sessionId` and `recordId`; `seq` is contextual metadata, not a deep-link identifier. `SessionRecordLink` carries `orbit://session/<id>?at=<record>` or the authenticated deployment's `/sessions/<id>?at=<record>`. Existing session reading resolves it with:

```text
GET /api/sessions/:sessionId/events/page?around=<recordId>&limit=<n>&maxPayload=<n>
→ { events, hasMore, before, after, anchor: { kind, id, seq } }
```

The record may be a turn, event or tool call, in public or UUID spelling. A record outside the named session returns 404; show the baseline message “That message is not in this session” and the existing session view. `before` and `after` page in both directions; Jump to latest exits the historical window. Malformed anchors fall back through existing route rules. Do not fork the reader projection or substitute a record ID for a session ID.

| Footnote kind | Original target |
| --- | --- |
| turn / event / tool_call | Session + exact record anchor |
| task / task_comment | Task; iOS comment action opens its task |
| approval / merge_receipt | Session |
| owner_decision | Project |
| code / design_doc / repository quote | Repository host at stored SHA and line range; GitHub file path escaped segment-by-segment |
| note / unknown / missing original | Display evidence and problem; no invented navigation |

Entry-source legacy shape can name the session in `ref` and the turn in `locator.turnId`; document sources use `sessionId`/`recordId`. Source states `live`, `trashed`, `deleted` and unresolved verdicts must not be collapsed into valid open actions. Source links must push over the originating Wiki route so return preserves selected space, article/document address, query and scroll context as supported by existing navigation state.

## Watch entrance and operation map

| Actual iOS entrance | Behavior | Acceptance boundary |
| --- | --- | --- |
| Session Watching strip | Live observer watches with `RESUME_SESSION`; target standing, collapsed/expanded rows and stale freshness | Read-only strip; open a target; no new top-level Watch drawer/tab |
| Existing watch link / alert / conversation navigation | Following list or exact Watch detail | CompactShell explicitly excludes Following from drawer rail |
| Following | Needs attention, Active, History | Merge four reads: newest, ACTIVE, PAUSED, needsAttention; deduplicate so old live/failing watches are not displaced by newest 100 |
| Detail | Condition, progress, action/observer, freshness, deadline, targets, every Match and end delivery | Older/deep-linked ID absent from list is individually fetched before “Watch not found” |
| ACTIVE detail | Pause, Stop | Stop asks confirmation and explains that cancellation wakes nobody |
| PAUSED detail | Resume, Stop | Pausing does not extend expiry; terminal states have no live controls |
| Terminal detail | Read audit record | MATCHED/EXPIRED/CANCELLED/REVOKED/UNRESOLVABLE never regain editable controls |
| WatchEditSheet source type | No actual iOS screen presents it; editing is parked pending agent notification semantics | Do not expose an Edit button just because PATCH and `WatchEditing` exist |
| Task → Followed by → Follow task | Single TASK condition + deadline + NOTIFY_USER | Implemented by A11 in its task detail (`tasks/TaskEditor.kt`), which opens A12's WATCH route; no general Watch-create screen; iOS does not expose RESUME_SESSION creation |
| Delivered/queued watch wake card | Structured reason/changed targets, View watch, folded original text | Reuse inherited A08 card; queued-only Withdraw wake uses its existing confirmation/queue mutation; no generic Wake now button |

Watch reads/mutations: `GET watches[?state=ACTIVE|PAUSED]`, `GET watches?needsAttention=true`, `GET watches/:id`, `POST watches`, `POST watches/:id/pause|resume|cancel`. `PATCH watches/:id` exists for condition/deadline only but has no presented iOS editor. Delivery redrive endpoints exist in the server contract, but these fixed iOS detail views have no redrive UI; do not add one under “wake operations.”

Watch permission/state checks remain server-authoritative. GONE targets do not open. Unknown predicates display the baseline “a condition this version of Orbit can't show” and are never rewritten into a known predicate. Unknown enums must not crash. State mismatch after a control re-reads the record and displays refusal.

Needs attention includes REVOKED/UNRESOLVABLE, unheard EXPIRED NOTIFY_USER, relevant dead letters, and delivery retries with attempts > 0; live stale/deleted-target hints are also visible. `WAKE_WITHDRAWN` is not retryable and does not need attention. A DELIVERED resume wake means queued, not necessarily taken by a runner. Ended/interrupted/withdrawn queued wakes can become DEAD_LETTER; the UI must not claim the agent ran from the delivery label alone.

## Empty, error, permission and invalidation cases

- Never show “empty” before a successful read. Home with no spaces, Review with no pending ops, empty search, unwritten article/doc and Following with no watches are distinct states.
- Initial errors show Retry; refresh errors must not masquerade as a successful empty response. Permission/account loss clears protected data according to inherited auth behavior.
- Watch list 404 means the server does not serve watches; a single missing watch is a resource lookup, not proof all watches are unsupported.
- Wiki entry/document/plan version/section absence keeps the caller's context and names the unavailable resource. A foreign owner's 404 is indistinguishable from absent.
- Anchor marks are unchecked/verified/changed/missing. Doc sentences are sourced/transition/unsourced/unverified/withdrawn; withdrawn remains visible with its reason until regeneration. A failed source check does not silently erase the claim.
- Owner mutations retain form values on refusal, prohibit duplicate in-flight writes, preserve revision/version identity and refresh on stale conflicts. Contract refusal text/code is retained; no locally generated success substitutes for it.

## Shared deterministic inputs

| File | SHA-256 |
| --- | --- |
| `contracts/wiki.contract.json` | `8eda2e330e9fbbf48e750c525880b1155a4bb8e92d2ad868c6ff5768cc341cfa` |
| `contracts/watch.contract.json` | `a51a14ce45fb5db07d06ac3138c5b408b060f7b060f20621e3421c222e1a2980` |
| `src/shared/src/wiki-articles.fixture.json` | `775d35b342358e2c360e21ebfdf07585ba704d04a190c83ec2db2d1324520c15` |
| `src/shared/src/wiki-docs.fixture.json` | `5aab2efe29730bfb6ca86afb59a42b44772d43c3f6382b2aecf41ea3375db3a3` |
| `src/shared/src/wiki-health.fixture.json` | `de926230c1aae8950bb97d2ed9c97f3ef0a4b4993226d3f6418551b667448d3d` |
| `src/shared/src/wiki-review-mode.fixture.json` | `d8ba067bcd12bbd11daf1a6a41003fa4f33b8e3236ee2b8a724944802694b931` |
| `src/shared/src/watch-strip.fixture.json` | `44862bacd7a88505a889a73f6387e77bb94b133e2726ee32daa22f80368240b7` |

These inputs prove repeatable source-model behavior only. Controlled HTTP journal/state evidence may prove the Android client sent the specified request and responded to the synthetic authority. It does not prove PostgreSQL transactions, actual iOS parity, real deployment ownership, runner execution, APNs/FCM delivery or physical-phone navigation/performance.

## Required result and gap accounting

The implementation report must list its actual modified paths separately from inherited merge paths, and enumerate any rows above not implemented or not locally exercised. In particular Plan, Review challenge/edit, source-anchor return, task Follow integration, wake withdrawal and maintenance lookback cannot disappear under a generic “Wiki/Watch implemented” claim.

After local Android gates and controlled tests, the remaining real-resource run must record: installed iOS version/build; Android APK/signature and physical GMS phone/API identity; deployed backend/shared SHA or image digest; same account/role, space and object IDs; before/after authoritative reads for each accepted/refused mutation; screen/navigation trace including source record highlight and Back; actual subscribed event/wake/delivery state. Use the approved S1/D09 cases and preserve earlier fixture identities. A01 is a static approved inventory, not evidence that this same-data matrix is frozen.

## A12 controlled HTTP fixture

`src/android/scripts/wiki-watch-fixture.py` binds `127.0.0.1:18770`. It imports A06's `transcript-fixture.py` for authentication, session pages and the historical record window. `GET /__ids` gives the exact test IDs; the original-record fixture lands at seq 110 in the 420-row REVIEW dataset. `GET /__stats` returns request method/path/body/status and committed synthetic state. `POST /__control` accepts `reset`, scoped `denial`/`conflict`/`offline`/`lostResponse`, `prefix`, `empty`, `docsPlan`, `entry`/`watch` patches, `record_denial`, `page_denial`, `snapshot_status`, `draft` and `proposals`.

The Wiki run/entry examples come from `wiki-review-mode.fixture.json`; docs and plan versions come from `wiki-docs.fixture.json`; article directory/index and health come from their named shared fixtures. IDs are explicitly remapped to valid test UUIDs, one source/target is linked to the inherited A06 session, and a small home/search/Watch response supplies the necessary HTTP context. The original corpus files remain unchanged. This fixture does not implement the real backend's full review policy, Watch evaluator, Wiki planning/generation or database transaction semantics. A request succeeding here cannot establish those properties. Missing fixture mutation routes return 404 rather than fabricate a successful business operation.
