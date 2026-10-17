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
| Merge round, 2026-10-08 | `db13974a0`: the project tip `3eb8e8594` (A11b with main `4f695a286`, then A13) merged into A12 v2 `daef4abeb`, parents in that order |
| Server trees at that tip | `src/apiserver` `fbe271e6c219f180c80439ea0d6f5292409c9cc0`, `src/shared` `bb96d8a6566d907cfa5b95e76d87211970881ad1`, `src/runner-go` `5fa551c0c5f0706e284b242303ec087485b8c5ff` |

The merge round (coordinator comment 34c72iJ9kaNGjIb0DSyX5) brings main's later iOS, contract and server changes into the tree. The iOS baseline of this document stays the one read at the first merge: the iOS Wiki/Watch changes after it (A01b's increment list, for example `712c92e10` and `42d12db2b`) are ported by a task of their own, not in this round.

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
| Drawer Wiki → home (A12c: the documents) | Large title and the space by its repository's name; the line that says what the space holds; search under the title; the principles (three, then All N); the confirmed plan's documents by category with leads and new-since dots, unwritten ones folded; Browse by category · A–Z index | Preserve band order (`WikiLogic.HomeBand`), selected space, grey bars before the first read, the failure's Retry, the new space's card |
| Home bar → Activity (A12c) | Status line, the proposals' banner with other spaces' shares, plan banners per kind of thing waiting (and other spaces'), Recent decisions, Recently changed with "N new since you last looked", Agents used the wiki | Banners add up to the bar's and the drawer's "N waiting on you" (`WikiSpaceLogic.waiting`) |
| Home Contents button → sheet | Home, Browse, Index, Plan; category/topic/article hierarchy before a confirmed plan, category/document/section hierarchy after one | `docsDirectory.plan != null` selects documents, not an independently invented top-level page |
| Browse / index | `articles`, `article-index`, `topics/:slug`; or `docs`, `doc-index` | Alphabetical index and category browsing open the correct article part or document section |
| Article page | Title/topic/part, structured paragraph blocks, footnotes, cited entry groups; a topic with no article can show entries | Show source/entry context and stale/unwritten distinctions; support Contents return |
| Document page | Confirmed plan's document/sections, scope, sentence marks, footnotes and via entries | Section address scrolls to the named section; show unsourced, unverified and withdrawn content, with reasons |
| Footnote/source sheet | Original quote, record/repository locator, verdict, excerpt and original-object action | Open the original session record/task/project/file; Back returns to the same Wiki context |
| Entry page | Details, Sources, Anchors, Where it's used, History; badges for trust, anchor state, pinned, web derived | Reuse rich text/link/card primitives; retain ended entries and show ended styling |
| Entry Edit / Supersede / Retire / Copy link | Title+summary edit; replacement inherits kind/fields/topics/aliases/clean anchors; retirement requires reason; deployment Wiki URL | Preserve base revision and per-action idempotency; only send anchor input keys, never returned `check` |
| Active unreviewed entry | Confirm and Reject(reason) | Confirm only appears for `active + unreviewed` in iOS |
| Active auto entry | Reject(reason), no Confirm button | API permits broader confirm than actual iOS UI; do not silently expand the entrance |
| Activity's first banner → Review | Pending ops across spaces, tabs All/Add/Amend/Retire, one-card pager, proposing session, source/diff context | Accept/Reject/Edit; retire proposal Keep/Retire; challenge Re-confirm/Amend/Retire; clamp pager after external changes |
| Review Edit | Owner title+summary over proposal | An amend carries through proposed fields/topics/aliases/anchors; challenge Amend sends changed fields only and forbids an unchanged submission |
| Activity's Recently changed → run | Changeset summary, applied/pending/refused ops, verification and source run | Revert run only when server-projected run is revertible; re-read authoritative state afterward |
| Home gear → Wiki settings | Manual/Tiered/Automatic, Automatic spot checks, automatic fallback reason | Settings stay inside Wiki; spot checks disabled outside Automatic |
| Wiki settings Maintenance Set up/Edit/Turn off | Workspace, provider, daily run limit, lookback | Lookback supports since-now `0`, positive days, all-history `null`; changing settings never rewinds an established cursor |
| Activity's plan banner / Contents Plan | Current/draft/history versions, document and section detail, proposal diffs, job progress/held/failure | Actual iOS entrance exists; this must not be dropped merely because entry/review work is smaller |
| Plan mutations | Redraft with instructions; confirm draft; edit document/section; accept/reject plan proposal | Preserve base version; show `WIKI_PLAN_STALE`, gate `errors[]`, held workspace/provider or runner-offline reason; never fabricate generated text |

The fixed iOS entry toolbar presents Edit/Supersede/Retire and lets the server reject invalid status/kind/revision combinations. A decision is never amended by contract; it is superseded. A principle is owner-written. Owner-only user mutations must not inherit an acting-session header. A live unreviewed/tainted entry must not be presented as already sent to agents. Rejected/retired/superseded entries and source history are still readable audit records when the server permits them.

## Android implementation (A12 code)

Every Wiki route goes through `wiki/WikiDestination.kt` to a typed screen over the account's one `WikiStore` (`wiki/WikiStore.kt`, the port of iOS `WikiModel`), which reads and writes through `WikiClient` on A03's authenticated handle. Wire types, copy and derivations are ports of OrbitKit (`WikiWire.kt`, `WikiPlanWire.kt`, `WikiCopy.kt`, `WikiLogic.kt`, `WikiReadingLogic.kt`, `WikiPlanLogic.kt`) held to OrbitKit's own test cases over the same shared fixtures. Watch is `watch/` over one `WatchStore` (iOS `WatchesModel`) and the OrbitKit ports `WatchWire.kt`, `WatchLogic.kt`, `WatchProjection.kt`. A page binds its iOS toolbar title/actions into the shell's TopAppBar through `PageBar`; iOS sheets are `ModalBottomSheet`, alerts `AlertDialog`, the app toast `WikiToast`. No new drawer row or top-level page was added: the drawer keeps A05's Wiki row (now with iOS's amber count) and Following stays off the drawer.

| iOS (Swift) | Android (Kotlin) | Route / entry |
| --- | --- | --- |
| `CompactShell.wikiRow` (drawer row, the amber number waiting on the owner; no row when the wiki is off) | `MainActivity` drawer item through `WikiDrawerRow`, badge `WikiDrawerCount` | drawer |
| `WikiHomeView`, `WikiHomePage`, `WikiHomePlaceholder`, `WikiSpacePicker`, `WikiActivityGlyph`, `WikiDocRow`, `WikiDocFoldedRow`, `WikiDisabledNote` | `WikiHome.kt` `WikiHomeScreen`, `WikiSpacePicker`, `WikiActivityButton`; `WikiPlanPage.kt` `WikiDocRow`, `WikiDocFoldedRow` | `WIKI`; `orbit://wiki/<spaceId>` selects that space |
| `WikiActivityView`, `WikiActivityPage`, `WikiBandRows` | `WikiActivity.kt` `WikiActivityScreen`, `WikiActivityPage` | `WIKI_ACTIVITY` |
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

Refresh, as iOS's `AppModel` routes the account stream: the Wiki re-reads what it has loaded on `wiki.changed` and on every (re)connect of the stream, which replays nothing; the watches re-read on `session.created/updated/ended`, `approval.requested/resolved` and `task.changed` (only while one is live, 2 s debounce), on every reconnect, and on the 30 s floor. Other events read nothing. The event types come from A04's `RealtimeState.accountEvents` (per-type counts) and `controlConnects` — an additive A04 change made for this (see below). A re-read never overlaps another: nudges queue (conflated) behind the one running, and one that comes during the debounce is covered by the read about to start. Every read lands only while it is the newest one asked for its part (spaces, home, review, an entry, a run, the plan, the documents…), and a write outdates the reads already on their way, so an older answer — a review queue that still lists an op just answered — is never adopted over a newer one. Pull-to-refresh is where iOS has `.refreshable`.

Writes: every owner write (Review's decide, an entry's Edit/Supersede/Retire, Confirm/Reject, the settings, Revert, the plan's Redraft/Confirm/Edit/Accept/Reject) runs on the store's own scope to its answer, so leaving the page — Back, a link, the drawer — never cancels the request (A03's AuthSession cancels a request whose caller is cancelled). A sheet with a write on its way cannot be closed — no swipe, scrim tap or Back, its Cancel disabled — until the answer (iOS `.interactiveDismissDisabled`). The answer goes to the sheet or page that asked while it is there; when it is gone, the next Wiki page shows it in a banner at the top until dismissed (`wiki-notice`). Plan Accept is two writes — the proposal's decide, then the confirm of the draft it made — run together to the end; a confirm refused after the accept says so ("Accepted into draft vN, but it was not confirmed: …"), and the draft waits on the plan page with its Confirm.

Decide's answer: the server returns the changeset with each op's recorded `decision`. `conflict` (an amend/supersede/retire whose entry has moved past its base revision, or a challenge whose entry is no longer active) and `withdrawn` applied nothing, and Android says so as a refusal ("Nothing was applied: the entry changed after this was proposed." / "…the entry is no longer active." / "…the proposal was withdrawn."). One exception: Retire on a challenge retires the entry and withdraws every op still waiting on it, the challenge it answers included, so the server records that challenge `withdrawn` (`wiki-anchors.pg.spec.ts`); that is the Retire done ("Retired"). The baseline iOS `WikiModel.decide` did not read the answer and showed the action's toast ("Accepted") for these; the iOS/web fix 700dfa781 (task 34c3QcoXIiyb7KKKOQTqG) reads it with the same rule and the same three sentences (OrbitKit `WikiLogic.decisionRefusal(_:op:action:)`, `WikiCopy.conflictRefused/inactiveRefused/withdrawnRefused`).

Opened again: a Wiki or Watch page's saved state belongs to its navigation frame. MainActivity drops it once the route has left every stack (as A13 does for its settings and runner pages), so a document opened again at a section scrolls there, a watch's earlier refusal is not shown on the next visit; and a link's arrival is a frame of its own (`OrbitRoute.entry`, stamped by `OrbitNavigation.receive` for Wiki/Watch routes), so a second notification for the same space selects it again even while an equal page is up. A link to a space the account does not have — deleted, or another account's — says "That space is not available." and shows no other space's home; an entry the server answers 404 for is withdrawn from the page ("That entry is no longer in this space.").

### Deliberate platform differences

The account owner accepted these on card 34bs0PdYUHHwiKHYn3rCp (2026-10-07T16:10:54Z): the bar's title and actions with Review's count as a second line; Material bottom sheets with a draggable footnote card; dropdown menus and −/+ steppers; the A–Z letter strip (under 48 dp on purpose); a run row's snap-back swipe with a TalkBack action. The plan's Edit sheet reorders by dragging, with ↑/↓ kept as TalkBack actions (the same decision).

- Top-bar actions and titles live in the shell's TopAppBar; iOS principal title blocks (Review's count line) are a second title line. A bar title is one line ending in an ellipsis when the bar's buttons leave too little room, as iOS's inline titles are; the watch record's headline, cut first at large type, is also its overview section's header, as on iOS.
- Sheets are Material bottom sheets (the article footnote card can be dragged to full height); confirmation dialogs are `AlertDialog`s; iOS Menus/Pickers are `DropdownMenu`s; steppers are −/+ buttons. The plan's Edit sheet moves a section by dragging its handle, as iOS's list in edit mode; TalkBack, which cannot drag, has the row's Move up / Move down actions.
- iOS's trailing swipe (a run's Reject) is a swipe that snaps back and asks for the reason, also reachable as a TalkBack custom action.
- The A–Z section index is a letter strip beside the list (letters jump; drag scrubs); each letter is a button for TalkBack.
- Touch targets are at least 48dp; the strip's letters are the one knowing exception (20dp tall so A–Z fits).
- A document opened at a section scrolls there once (no 300 ms delay) and keeps the reader's place on Back.
- The Wiki toast expires by elapsed time, so a toast posted by a popped page never reappears on the next page.
- A watch row missing a field the server always sends (OrbitKit `Watch`'s non-optional properties), or holding another kind of value there, is left out of the list rather than drawn as a watch out of defaults; a value this version does not know still reads, as unknown. Overlapping reads keep the newest, and a control's answer survives an older list read — iOS fails the whole list on one bad row and has that race.
- The Set up form's options are read with `GET /workspaces`, `/runners`, `/providers` when Settings opens (iOS uses its app-wide agents model), falling back to A05's directory data.

### Differences that belong to other modules (reported, not changed here)

- A08: `cards/SessionCards.kt` shows Pause/Resume/Stop cards for every watch whose observer is the session, beside A12's read-only Watching strip; iOS's session shows only the strip. The A08 watch-wake transcript card has no iOS "View watch" button (iOS routes it to `.watch(id)`; A12's WATCH route accepts it).
- A11: the task "Follow task" sheet and "Followed by" rows (iOS `TaskFollowSheet`) are implemented by A11 in `tasks/` and open `OrbitRoute(WATCH, id)`; A12 provides the WATCH destination, not a second subscription component.
- A05: `DirectoryRunner` does not decode `displayName`, so the maintenance "where" label uses the runner's `name` (iOS `displayName ?? name`).
- A04: `RealtimeState` gained `accountEvents: Map<String, Long>` (how many events of each type the handle's stream delivered; pings excluded) and `controlConnects: Long` (how many times it connected), set in `RealtimeStore`'s control stream beside `invalidationRevision`, which is unchanged. Counts only grow, so a conflated read of the state never loses an event. Core test: `RealtimeStoreTest.accountEventsAreCountedByTypeAndTheConnectIsCounted`.

## Wiki API map

All paths are below `/api`; IDs must use the existing public-ID conversion, encoding and authenticated transport.

| Area | Endpoints |
| --- | --- |
| Home (A12c) | `GET wiki/spaces` (pendingOps, planWaiting, workspaceIds, docs); `GET wiki/spaces/:id/entries?kind=principle&limit=200`; `GET wiki/spaces/:id/docs` (each document's lead); `GET wiki/spaces/:id/articles` |
| Activity (A12c) | `GET wiki/spaces/:id?include=usage`; `GET wiki/spaces/:id/entries?limit=200`; `GET wiki/spaces/:id/entries?kind=decision&limit=4`; `GET wiki/spaces/:id/timeline`; `GET wiki/spaces/:id/health`; `GET wiki/spaces/:id/plan` of the space and of every other space with planWaiting; `GET projects/:id` (coordinatorWorkspaceId) when the Wiki is entered from a project's page |
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

`src/android/scripts/wiki-watch-fixture.py` binds `127.0.0.1:18770`. It imports A06's `transcript-fixture.py` for authentication, session pages and the historical record window. `GET /__ids` gives the exact test IDs; the original-record fixture lands at seq 110 in the 420-row REVIEW dataset. `GET /__stats` returns request method/path/body/status and committed synthetic state. `POST /__control` accepts `reset`, scoped `denial`/`conflict`/`offline`/`lostResponse`, `prefix`, `empty`, `docsPlan`, `entry`/`watch` patches, `record_denial`, `page_denial`, `snapshot_status`, `draft`, `proposals` and (A12c) `wikiDisabled`, which answers every `/api/wiki` route 404 WIKI_DISABLED. Since A12c the entries read answers by `kind` and `limit` as `WikiService.listEntries` does (four owner principles and two decisions are added to the run's pitfalls), each space row carries `planWaiting`, `workspaceIds` and `docs`, every written document has a lead, Review's ops carry `entryTitle`, and a second space `a12-notes` (github.com/example/notes, unbound, no confirmed plan) has a draft plan waiting on the owner.

The Wiki run/entry examples come from `wiki-review-mode.fixture.json`; docs and plan versions come from `wiki-docs.fixture.json`; article directory/index and health come from their named shared fixtures. IDs are explicitly remapped to valid test UUIDs, one source/target is linked to the inherited A06 session, and a small home/search/Watch response supplies the necessary HTTP context. The original corpus files remain unchanged. This fixture does not implement the real backend's full review policy, Watch evaluator, Wiki planning/generation or database transaction semantics. A request succeeding here cannot establish those properties. Missing fixture mutation routes return 404 rather than fabricate a successful business operation. A plan edit is stored in the shape the server stores (the kept sections keep their ids, positions follow the order sent, session projects carry their titles), so the app decodes the draft it made; the gate's checks are not run.

## A12 device journeys

`src/android/scripts/wiki-watch-device-test.sh APP_APK TEST_APK EVIDENCE_DIR SERIAL|API29..API35` holds `/var/lib/orbit/android/ui.lock` for the whole run, installs both APKs, clears the app, sets `A12_FONT_SCALE`/`A12_NIGHT`, starts the fixture behind `adb reverse tcp:18770`, runs `WikiWatchDeviceTest` (15 journeys since A12c) and restores font, night mode and the reverse afterwards. It drives emulators only (`ro.kernel.qemu` is checked); `APInn` boots `orbit-ui-apiNN` on port 5556 inside the hold and shuts it down in cleanup. Each journey writes its identity (source SHA, link, login path), journal, captures and, on failure, its stack trace before the scenario closes.

Only `aSpaceLinkOpensItsHomeThroughLoginAndRecreation` signs in on the login form (the link waits on the login across recreation, which is what it checks). The other journeys sign in with `AuthSession.login` before the Activity starts, and every journey signs out after its Activity is closed. `AuthSession` publishes SignedIn/SignedOut from its own thread; under the Compose test rule the effect dispatcher is an unconfined test dispatcher, so a live composition collecting that state can recompose on that thread (`CalledFromWrongThreadException`, then a `SlotWriter` crash while the half-applied composition is disposed). It was seen twice at dark/200% on emulator-5554 before this arrangement. The app's own dispatcher resumes on the main thread, so production is not exposed, but every device suite that signs in on the form under a Compose rule shares the hazard. A screenshot the starved device cannot take is retried; one still missing is counted in `result.txt` and leaves its semantics tree.

## A12 live journeys on an isolated stack

`src/android/scripts/a12-stack` (see its README) runs the apiserver and runner of the revision its `setup.sh` pins — `0f98546a5` (the first merge) for the 2026-10-07 runs, the project tip `3eb8e8594` since the 2026-10-08 merge round — on the host's loopback with their own PostgreSQL. It seeds them through the HTTP API alone and reads the server back after every write: an owner and a second account, a Manual space with owner-written entries, a fresh and a stale pending proposal from the agent door (the stack runner's token and a session it hosts), a run that Tiered applied, and a task with a NOTIFY_USER watch. `WikiWatchLiveTest` (twelve journeys since A12c) opens each journey from its link on the emulator, acts through the screens, and reads the server back with the acting account's own token:

- search finds an entry, and its page opens;
- Review's Accept is recorded `accepted`;
- Accept of the stale op is recorded `conflict`, the entry is unchanged, and the refusal shows;
- Edit adds one revision;
- the review mode changes, and changes back;
- Pause, Resume and Stop;
- the other account opens the owner's entry, space and watch: a 404 on the server, a withdrawn page, and none of the owner's titles;
- Revert takes back the run;
- (A12c) the home's line, principles and documents band are what the server's own docs, articles and principle reads make them; Activity's badge and the drawer say the server's pendingOps + planWaiting, its first banner the server's proposals, its status line the health read's count, its decisions and changes the server's reads.

`cycle.sh` seeds the stack once per evidence directory and resumes a run that was cut off.

On 2026-10-07 UTC (emulator-5554, API 36), with the product tree of `1052be908`, 8 of 10 passed: the app said "Accepted" for the conflict, and the owner's space link opened the other account's own space. With the review-1 fix (`9095a638f`) merged, all 10 passed. The stack cannot show a maintenance-origin run or a plan draft: both need a model engine on a runner, and the stack's engine is a fake that calls none. It also says nothing about iOS, a physical phone or production.

## A12 TalkBack check

`WikiWatchTalkBackTest` walks seven pages with TalkBack 16 on emulator-5554 (API 36): home with Review, Wiki settings, an entry, Contents → a document → a footnote's sheet, the plan, a watch with Following, and a session's Watching strip. `wiki-watch-device-test.sh … A12_TALKBACK=1` grants TalkBack its notification permission, makes the test APK's silent `TalkBackSpeechRecorder` the speech engine and turns TalkBack on, all inside the lock hold, and puts every setting back afterwards (before, during and after in `talkback-settings.txt`; the run fails if anything differs). Gestures go through the emulator console's touchscreen, because touches injected by the test bypass TalkBack. On each page the test lists what TalkBack can reach, walks the swipe order, checks that touching each main control gives it TalkBack's focus, and double-taps one control and reads the effect back: a page or sheet opens, a POST or PATCH reaches the fixture, the switch reads On, Pause becomes Resume. The recorder gives what TalkBack handed to the voice, not how a voice pronounces it. A touch or swipe TalkBack lets go by is made once more and noted.

The first run found real problems on five pages, fixed in semantics alone and guarded by `WikiTalkBackWordsTest` on the JVM. Lone glyphs (ⓘ, 💬, ◎, ⚠, •, ✓, ⑂, —) are now hidden or read as words. A footnote's quote reads "quote verified", "quote not found" or "no quote". An entry's section headers and the home's bands are headings with their counts. The plan's version menu reads "v2, Draft", and the home's review banner and space picker are read once.

Swiping does not scroll a long page: on the entry and document pages TalkBack reaches the rows on screen, then the bar, then wraps to the top, so an entry's History and a document's later sections are reached by touch after a scroll. `lazyListControl` shows this is the environment. A bare LazyColumn of 40 rows behaves the same, and so do the variants under Scaffold with TopAppBar, inside PullToRefreshBox, with rows grouped in cards, and after one item taller than the screen: the first visible row stays 0 (TalkBack 16.0, API 36, Compose UI 1.9.0). Not covered: other TalkBack or Compose versions, the plan's document and section pages, the run, browse, index and article pages, and the edit sheets (the plan's Edit sheet moves sections with the row's Move up / Move down actions, checked on the JVM). Glyphs inside words ("⚠ Pitfall", "fetched 1×") are read as they are. "1 proposals to review" is iOS's and the web's copy too.

## A12c: the home is the documents, Activity, one number waiting (A12-1/2/3)

The A01b list's three Wiki items (part 4/6), ported from the iOS commits on main: b85473546 (A12-1), 42d12db2b with c6e66aaef's decoding (A12-2), 712c92e10 with 8a3453b63's words (A12-3). The iPad and Mac middle column of 712c92e10 is not followed: the first release promises phones only.

- **A12-1 · reads and words.** The home's principles and Activity's decisions read their own kind (`?kind=principle&limit=200`, `?kind=decision&limit=4`) instead of being picked out of the 200 newest entries. "1 proposal to review" is singular. A Review card names its entry by the `entryTitle` Review's read carries. A 404 WIKI_DISABLED is an answer: the drawer draws no Wiki row (`WikiDrawerRow`, as iOS's `shown`), and the home and an entry link say "The wiki is not switched on for this account.". 712c92e10 took the empty Principles line away again: no principle, no band.
- **A12-2 · Activity.** The home's bar is Contents · Activity · Settings. Activity (`WIKI_ACTIVITY`) draws the management blocks in `WikiLogic.ActivityBand`'s order. One number waits on the owner: every space's pendingOps plus planWaiting. The drawer's row and the bar's badge say it "N waiting on you", and the amber banners add up to it. The home moves the space's seen stamp as it opens, and Activity reads what it said before (`WikiSeenLog`), marking new rows with a blue dot and "N new since you last looked". Spaces are called by their repository's last segment (`WikiSpaceLogic.names`). One space is a grey label; several are a menu with the repository, the documents, the amber number and Manage spaces. Entering the Wiki from another section opens the space bound to the workspace the reader was in (or the project's coordinator workspace), else the one last looked at, else the most written. The names, defaults and numbers are held to `src/shared/src/wiki-space.fixture.json` (`WikiSpaceLogicTest`).
- **A12-3 · the home is the documents.** `WikiLogic.HomeBand` sets the order: the line (`35 documents · 5 written`, the topic articles before a plan, `No documents yet`), the search, the principles (three, then All N), the documents by category, and the foot. Each written document shows its number, title, two lines of lead (`docs.lead`) and the blue dot of what was written since the reader last looked. Unwritten documents fold into one row (`+3 not written yet`, `3 documents · Not written yet`) that opens to their titles. A new space shows one card and Set up maintenance. Grey bars stand in until the first read answers, and a failed read says so with Retry. The plan page's document rows are the same row (`WikiDocRow`), as on iOS. The home's words and readings are `wiki-docs.fixture.json`'s (`WikiHomeDocsTest`).

Deliberate differences: iOS's bar also has a Share globe; it comes from share-links (2ba6765d9), which is after the A01b range, so it is A01c's to list. The grey bars are drawn shapes, because Compose has no `.redacted`. The picker's amber number is a badge of any size, where iOS uses SF Symbols' numbered circles up to 50, and TalkBack says it "N waiting". TalkBack reads "All N" without its chevron. The blue dots are silent to TalkBack; the heading says how many are new. Seen stamps live in the account's own cache (A03's per-account store), not the device's defaults, as the project keeps caches apart by server and account. From a project's page, the coordinator's workspace is read with `GET /projects/:id`; iOS uses its projects store.
