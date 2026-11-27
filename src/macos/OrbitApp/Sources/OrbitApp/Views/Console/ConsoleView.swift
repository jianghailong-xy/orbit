import SwiftUI
import OrbitKit
#if os(iOS)
import UIKit
#endif

// The console page and its transcript list + scroll machinery. The row content lives beside this
// file: MessageBubbles.swift (user/assistant/thinking turns), AttachmentViews.swift (thumbnails /
// chips), ImageViewer.swift (full-screen viewers), ToolCards.swift (tool calls + diffs).

/// Console for one session: renders the reduced transcript (resumed from the local store) and the
/// interactive composer/approvals/worktree. The `ConsoleModel` is owned by `ConsoleRegistry`, not
/// this view, so switching sessions reuses a warm, cached console instead of rebuilding one.
struct ConsoleView: View {
    let sessionID: String
    var agentID: String? = nil
    let registry: ConsoleRegistry
    /// The transcript's one full-screen image viewer (see `SessionImagePreview`): the image it's open
    /// on, and the pages it was opened over.
    @Namespace private var imagePreviewNS
    @State private var imagePreviewTarget: ImagePreviewTarget?
    @State private var imagePreviewPages: [PreviewImage] = []
    @State private var fetchedToolImages = FetchedToolImages()
    // Routes to the run a message followed (`handedOverSessionID`) and to the one a refusal names
    // — both platforms — and, on iOS, the session the ⋯ menu acts on.
    @Environment(AppModel.self) private var appModel
    /// The public read-only link's sheet — opened from the nav bar on iOS, the window toolbar on macOS.
    @State private var showShare = false
    @State private var promotionReview: PromotionReviewTarget?
    @State private var promotionReceipt: PromotionReceiptTarget?
    @State private var ownerAnswerTold: OwnerAnswerTold?
    @State private var coordinatorDeliveryTold: CoordinatorDeliveryTold?
    @State private var approvalReview: ApprovalReviewTarget?
    @State private var evidenceFiles: EvidenceFilesTarget?
    @State private var approvalReviewDrafts = ApprovalReviewDrafts()
    /// Whether the reader has gone back far enough through the history for a phone's composer band to
    /// fold to its bar (`foldsBand`): written by the transcript's scroll tracker, off the same reading
    /// as the pin (`TailPinning.foldsBand`). Never set on the Mac.
    @State private var readingBack = false
    /// The band was opened where the reader is — its folded bar tapped, or the keyboard put away —
    /// and stays open until their next drag.
    @State private var bandOpened = false
    /// The folded pill comes and goes by fading alone under Reduce Motion.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// A wide shell: a task this conversation opens opens over it, not in the Tasks section
    /// (`opensTasksOverPage`, owner decision 2026-11-12).
    @Environment(\.opensTasksOverPage) private var opensTasksOverPage
    /// Move… — the ⋯ menu's on iOS, the window toolbar's on the Mac, and the region card's on both —
    /// and the session's workspace list the Move panel counts its folders over.
    @State private var movingSession: Session?
    @State private var moveListed: [Session] = []
    #if os(macOS)
    /// Agent Tools, from the window toolbar (docs/mocks/agent-tools board ⑤).
    @State private var showAgentTools = false
    #endif
    /// The session whose Settings sheet is open (`SessionSettingsSheet`), from Settings… in the ⋯ menu
    /// or the Mac toolbar.
    @State private var settingsSession: Session?
    #if os(iOS)
    /// The ⋯ menu's Rename… (web double-clicks its header title). Seeded from the session's own
    /// title — not `SessionHeader.title`, whose agent-name fallback would otherwise be typed in as if
    /// it were the name.
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var taggingSession: Session?
    @State private var confirmPurge = false
    /// Gates the "needs you" banner to the compact shell — see the `safeAreaInset` below.
    @Environment(\.horizontalSizeClass) private var hSize
    /// A phone's stack: the task or project the ⋯ menu opens goes over this console, so the back
    /// swipe returns here (`opensPagesOverConsole`).
    @Environment(\.opensPagesOverConsole) private var opensPagesOverConsole
    /// The project sessions sheet a phone's navigation bar button puts up (board 5), and what a
    /// press inside it opens once it has closed.
    /// Carried by the presentation itself (`.sheet(item:)`): a `.sheet(isPresented:)` whose content
    /// read the address from a second state built an empty sheet on its first press.
    @State private var projectSheet: ProjectSheetTarget?
    @State private var afterProjectSheet: (() -> Void)?
    #endif

    var body: some View {
        #if os(iOS)
        // A custom `.principal` toolbar item is measured at its ideal width instead of being given
        // the space left between the navigation buttons. Measure the actual detail column here so
        // the sticky question's capsule (`TranscriptView.stickyQuestion`) gets a finite proposal on
        // iPhone, after rotation, and in an iPad split view. Reserve 80 points on each side for
        // navigation chrome; 260 keeps it a capsule in wide columns instead of turning the
        // navigation bar into another content row.
        GeometryReader { geometry in
            consoleBody(navTitleWidth: min(max(geometry.size.width - 160, 0), 260))
        }
        #else
        consoleBody(navTitleWidth: 0)
        #endif
    }

    /// Gathers the session's pages when a thumbnail is tapped — never while the transcript renders or
    /// streams — and opens the viewer on the tapped one.
    /// Read through the observed model, so an Agent or Workflow card re-renders when the progress,
    /// the tray or a sub-agent's list moves — and no other row does.
    private func taskActivity(_ console: ConsoleModel) -> TaskActivityLookup {
        TaskActivityLookup(
            consoleID: ObjectIdentifier(console),
            progress: { console.state.taskProgress[$0] },
            isRunning: { id in console.state.background.contains { $0.id == id && $0.status == "running" } },
            subagentItems: { console.state.subagentItems[$0] ?? [] },
            subagentRun: { console.subagentRuns[$0] },
            workflowRun: { console.workflowRuns[$0] },
            workflows: { Array(console.workflowRuns.values) },
            reveal: { console.revealAgent($0) },
            parentEngine: appModel.session(id: console.sessionID)?.engine,
            fullPayload: { await console.fullPayload(seq: $0) })
    }

    private func sessionImagePreview(_ console: ConsoleModel) -> SessionImagePreview {
        let fetched = fetchedToolImages
        return SessionImagePreview(
            consoleID: ObjectIdentifier(console),
            sessionID: console.sessionID,
            ns: imagePreviewNS,
            open: { key, fallback, fallbackIndex in
                let pages = SessionPreviewImages
                    .collect(console.state.items,
                             isAttachmentImage: { console.attachments.image(for: $0) != nil }) {
                        fetched.byCard[$0.id] ?? $0.resultImages
                    }
                    .compactMap { PreviewImage($0) }
                if let index = pages.firstIndex(where: { $0.id == key }) {
                    imagePreviewPages = pages
                    imagePreviewTarget = ImagePreviewTarget(index: index, id: key)
                } else if fallback.indices.contains(fallbackIndex) {
                    imagePreviewPages = fallback
                    imagePreviewTarget = ImagePreviewTarget(index: fallbackIndex, id: key)
                }
            },
            rememberToolImages: { cardID, images in fetched.byCard[cardID] = images },
            toolImages: { fetched.byCard[$0] })
    }

    /// Screenshot bytes that open tool cards fetched back, by card. A reference, not state: filling it
    /// needn't re-render the console, only be there when the viewer next gathers its pages — and for a
    /// card the List has since recycled, to be there in the first place (see `ToolCardView.images`).
    private final class FetchedToolImages {
        var byCard: [String: [Data]] = [:]
    }

    /// Whether the conversation gets the screen while you type: on a phone (compact width), while
    /// the composer holds the keyboard. The band's cards, the bars under the nav bar and the nav bar
    /// itself fold away together, and come back when the keyboard goes. The wide shells keep all of it.
    private func foldsChrome(_ console: ConsoleModel?) -> Bool {
        #if os(iOS)
        hSize == .compact && console?.composerEditing == true
        #else
        false
        #endif
    }

    /// Whether a phone's composer band folds to its one-line bar (`FoldedBandBar`; the owner,
    /// 2026-10-16): the reader has gone back through the history — far enough that the folded band
    /// leaves them clear of the tail (`readingBack`), or into a window opened at a record — the
    /// composer doesn't hold the keyboard, and the reader hasn't just opened the band (`bandOpened`).
    /// Only where the band floats over the transcript, iOS 26 at a compact width; the wide shells and
    /// the Mac never fold.
    private func foldsBand(_ console: ConsoleModel) -> Bool {
        #if os(iOS)
        guard #available(iOS 26.0, *), hSize == .compact else { return false }
        return !console.composerEditing && !bandOpened && (readingBack || console.detached)
        #else
        false
        #endif
    }

    /// The transcript and the composer band. Pending approvals (incl. the AskUserQuestion form)
    /// render inline at the tail of the transcript — as the agent's latest turn, web-style — not in a
    /// fixed panel here. See TranscriptView.
    ///
    /// On iOS 26 the band floats over the transcript instead of standing below it (the owner,
    /// 2026-10-16: the bottom as clear as the top). The transcript runs on under it, the system's
    /// scroll-edge effect softens what passes beneath, and the band's cards are glass
    /// (`composerBandCard`). It is a safe-area bar, so the list's content is inset by its height:
    /// the tail and every follow stop above it, the pin reads the list net of it, and the follow
    /// hears it grow — the keyboard, a composer growing a line (`ScrollTracker`,
    /// `TailPinning.followsGeometry`).
    @ViewBuilder
    private func transcriptAndBand(_ console: ConsoleModel, navTitleWidth: CGFloat) -> some View {
        let transcript = TranscriptView(console: console, hidesStickyQuestion: foldsChrome(console),
                                        reviewingCard: approvalReview != nil || promotionReview != nil,
                                        questionWidth: navTitleWidth,
                                        readingBack: $readingBack, bandFolded: foldsBand(console),
                                        bandOpened: $bandOpened)
        #if os(iOS)
        if #available(iOS 26.0, *) {
            transcript.safeAreaBar(edge: .bottom, spacing: 0) {
                AnyView(composerBand(console).environment(\.floatsOverTranscript, true))
            }
        } else {
            VStack(spacing: 0) {
                transcript
                AnyView(composerBand(console))
            }
        }
        #else
        VStack(spacing: 0) {
            transcript
            composerBand(console)
        }
        #endif
    }

    /// The band under the transcript: its members, or — folded while the reader goes back through the
    /// history (`foldsBand`) — the one pill they stand behind (`ComposerBandFold`), centred and sunk
    /// below the band's foot to stand over the home indicator, as Safari's folded address bar does. A
    /// tap on the pill opens the band where the reader is.
    private func composerBand(_ console: ConsoleModel) -> some View {
        let folded = foldsBand(console)
        return ZStack(alignment: .bottom) {
            bandMembers(console)
                .modifier(ComposerBandFold(folded: folded))
            #if os(iOS)
            if #available(iOS 26.0, *), folded {
                FoldedBandBar(console: console, open: { bandOpened = true })
                    // The pill hugs what it says; this only caps it, and a long draft is what gives way.
                    .padding(.horizontal, 72)
                    // Its foot is off the screen's edge, not the safe area's: the band stands on the
                    // safe area, so the pill reaches down into it by the difference.
                    .padding(.bottom, .foldedBandPillFoot - windowBottomInset)
                    .transition(reduceMotion ? .opacity
                                : .opacity.combined(with: .scale(scale: 0.8, anchor: .bottom)))
            }
            #endif
        }
        .animation(.smooth(duration: 0.3), value: folded)
        // Putting the keyboard away leaves the band open where the reader is, as a tap on its bar
        // does, until their next drag. A drag is how the keyboard goes, and a fold in the same breath
        // landed in the middle of the keyboard's own layout: the list read as at its tail for a frame,
        // the band opened again, and the reader was carried back down (measured on the simulator).
        .onChange(of: console.composerEditing) { _, editing in
            if !editing { bandOpened = true }
        }
    }

    #if os(iOS)
    /// The screen's own bottom inset — the window's, which no bar or keyboard moves.
    private var windowBottomInset: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first?.safeAreaInsets.bottom ?? 0
    }
    #endif

    /// The session, when its runner's update or a full runner, run or batch holds what it queued: the
    /// tray's waiting rows say which (`PendingTrayView.held`).
    private func trayHeld(_ console: ConsoleModel) -> Session? {
        guard let session = appModel.session(id: console.sessionID),
              RunnerUpdating.holds(session) || QueuedCapacity.holds(session) || QueuedDiskLow.holds(session) else { return nil }
        return session
    }

    /// What the waiting card of a session its GitHub workspace's clone holds draws, or nil (web `useCloneWait`).
    private func cloneWaitCard(_ console: ConsoleModel) -> QueuedClone.Card? {
        guard let session = appModel.session(id: console.sessionID) else { return nil }
        return QueuedClone.card(session: session, workspace: console.cloneWorkspace,
                                heard: appModel.cloneLedger.heard(console.cloneWorkspace?.id),
                                storedAt: console.cloneWorkspaceReadAt)
    }

    private func bandMembers(_ console: ConsoleModel) -> some View {
        // Unread messages, error, background tray, git bar, composer — web's order
        // (`workspace-composer`). Staged attachments are not a member: they sit inside the
        // composer's card, above the text they go out with. The band owns the gutter and the
        // gaps; members only say whether they are on screen.
        ComposerBand {
            // Under a transcript that has content, the clone's wait stands as a note beneath it (web's compact card).
            if let card = cloneWaitCard(console), !console.state.items.isEmpty {
                CloneWaitCardView(card: card, machine: console.runnerName, compact: true)
                    .padding(.bottom, .composerBandGap)
            }
            // The reader's messages nothing has read yet: the conversation's next lines, so the
            // band's first card, right under the conversation and above the parking strip
            // (docs/mocks/pending-tray-above-parking, decided 2026-10-28). Not folded while
            // typing: they are about the message flow being typed into.
            PendingTrayView(console: console, rows: console.pendingTrayRows(
                turnRunning: (appModel.session(id: console.sessionID)?.effectiveRunStatus ?? console.state.status) == .running),
                            // Why none of them goes into the turn running now: Cursor CLI's would stop it.
                            note: console.engine == CursorRuntime.engine ? CursorRuntime.queueNote : nil,
                            held: trayHeld(console))
            // The managed runner's state while it is anything but ready, when this
            // console's runner is it (docs/managed-runner-design.md): about the runner the
            // message goes to, so it stays in sight while you type. Asleep is not a fault: one
            // calm line that sending wakes it, rather than the notice (board 3).
            if let managed = console.managed, managed.showsBanner {
                if managed.display.kind == .sleeping {
                    Text(ManagedRunnerCopy.Asleep.composer)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, .composerBandGap)
                        .accessibilityIdentifier("managed-asleep-composer")
                } else {
                    ManagedRunnerBanner(display: managed.display, runnerID: managed.runnerID)
                        .padding(.bottom, .composerBandGap)
                }
            }
            // Errors only, and sticky until the ✕ — this row is in flow, so anything that
            // comes and goes on a timer here shoves the composer around while the user is
            // typing in it. Confirmations belong in the toast host (see `showToast`).
            // Why this run produced nothing at all. Drawn first because it is about the
            // run itself rather than the message being sent, and drawn INSTEAD of the
            // two engine-repair cards below when it has something to say — one fact,
            // one card (an engine reason it does not claim is theirs, and the reverse).
            // A scheduled run that did not get under way in this session says so on its own card in the
            // transcript (board scheduled-run-not-started): none of these notes about this session, no composer.
            if console.scheduleRunCard != nil {
                EmptyView()
            } else if let runStart = console.runStart {
                SessionRunStartCardView(console: console, card: runStart, onMove: moveFromCard)
                    .padding(.bottom, .composerBandGap)
            } else if let repair = console.queuedDshRepair {
                DshRepairCardView(console: console, repair: repair)
                    .padding(.bottom, .composerBandGap)
            } else if let repair = console.queuedAntigravityRepair {
                AntigravityRepairCardView(console: console, repair: repair)
                    .padding(.bottom, .composerBandGap)
            }
            if let msg = console.statusMessage {
                HStack {
                    Text(msg).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(6)
                    Spacer()
                    Button { console.statusMessage = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.bottom, .composerBandGap)
            }
            // The message went somewhere — it just isn't here. Above the composer
            // because that is where the send was made from, and it carries the one
            // press that follows it.
            if let routed = console.handedOverSessionID {
                TaskRunHandedOverCard(
                    sessionID: routed,
                    onOpenRun: { appModel.route(to: .session($0)) },
                    onDismiss: { console.dismissRunConflict() })
                    .padding(.bottom, .composerBandGap)
            }
            // …and the refusals that used to be the server's English sentence in the
            // row above. Shown here rather than as a status line because each one
            // carries a way out that has to stay pressable.
            if let conflict = console.composerRunConflict {
                // A question is not dismissible into silence: `Keep it running` IS the
                // way to decline it, and an ✕ beside that would be a third answer that
                // leaves the message unsent with nothing on screen about why.
                let dismiss: (() -> Void)? = conflict.kind == .confirmSwitch
                    ? nil : { console.dismissRunConflict() }
                TaskRunHandoffCard(
                    conflict: conflict,
                    onOpenRun: { appModel.route(to: .session($0)) },
                    onStopAndContinue: { Task { await console.stopAndContinue() } },
                    onKeepRunning: { console.keepRunning() },
                    onDismiss: dismiss)
                    .padding(.bottom, .composerBandGap)
            }
            // The session's cards, which a phone folds while you type (`TypingFold`). The
            // one-off cards above stay: each is about the message being sent.
            VStack(spacing: 0) {
                // What this session waits on — a watch, not a process — above the real shells.
                WatchingCardStack(sessionID: console.sessionID)
                // The folded row by the shared rule; its names stop rotating while the band is folded.
                BackgroundTrayView(procs: console.state.background, progress: console.state.taskProgress,
                                   row: BackgroundRowRule.row(console.state.background, items: console.state.items,
                                                              lastAgentTurnStartedAt: console.state.agentTurnStartedAt,
                                                              sessionLive: console.isLive),
                                   paused: foldsChrome(console) || foldsBand(console),
                                   revealJob: { console.revealJob($0) },
                                   stopJob: { try await console.stopJob($0) })
                // The tasks this session's agent created, beside the code the bar below
                // carries — the session's two kinds of output, together.
                CreatedTasksCard(console: console)
                // Every Agent this session started: one line that opens their list.
                AgentsBandRow(console: console)
                WorktreeBar(console: console)
                // Where a forked task's run took its checkout from (SR18), beside the branch the
                // bar above names: the server's sentence, as it is.
                if let fork = console.sessionForkSource {
                    Text(fork)
                        .font(.orbitMeta).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, .composerBandGap)
                        .accessibilityIdentifier("session-fork-source")
                }
            }
            .modifier(TypingFold(folded: foldsChrome(console)))
            // The landing this conversation's work fed, at the session's own bottom (owner
            // 2026-10-19, board v4 06 e): absent from a session that produced no landing work.
            // A fix this task's session committed, queued to land again (revision 42; board
            // landing-fix-own-session 02 b ③): the one line the session gains.
            LandingFixAgainLine(console: console)
            SourceLandingChip(console: console)
            // A coordinator handing itself over (board 02): the note being written, the handover, or
            // its failure above the composer; the composer locked while it runs; and once it is done,
            // the way to the successor in the composer's place.
            let handoffSession = appModel.session(id: console.sessionID)
            let handoff = handoffSession?.coordinatorHandoff
            let handoffRow = CoordinatorHandoffRow.resolve(handoff, enginePhase: handoffSession?.enginePhase)
            if let handoffRow {
                if case .completed = handoffRow {} else {
                    CoordinatorHandoffStatusView(row: handoffRow, savedSuccessor: handoff?.successor,
                                                 choiceSources: console.choiceSources) { action, successor in
                        handoffPress(console, action, successor: successor)
                    }
                    .padding(.bottom, .composerBandGap)
                }
            }
            if console.scheduleRunCard != nil {
                EmptyView()
            } else if case .completed(let successor)? = handoffRow {
                CoordinatorHandedOverBanner { appModel.route(to: .session(successor)) }
            } else if CoordinatorContextActions.locksComposer(handoff) {
                CoordinatorHandoffLockedComposer()
            } else {
                ComposerView(console: console)
            }
            // What the provider pick standing in the composer will do, and WHEN — the
            // part that matters, because a run keeps its provider for its whole life.
            // In flow under the composer, and it stays for as long as the pick does.
            if let note = console.providerSwitchNote {
                Text(note).font(.orbitMeta).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
        }
    }

    /// A press on the handoff's row: Skip the note, Cancel handover, or a failure's way out. The
    /// project is the one this conversation coordinates — or, once it no longer does, belongs to.
    private func handoffPress(_ console: ConsoleModel, _ action: CoordinatorHandoffAction,
                              successor: CoordinatorHandoffSuccessor?) {
        let session = appModel.session(id: console.sessionID)
        guard let projectID = session?.projectId ?? session?.projectMembership?.projectId else { return }
        Task { await console.coordinatorHandoff(projectID: projectID, action, successor: successor) }
    }

    private func consoleBody(navTitleWidth: CGFloat) -> some View {
        Group {
            // A LANDING session is platform work, not a conversation (§2.9 LS6): the same frame
            // (`.console`, so every push, `orbit-session:` and `/sessions/<id>` link still lands
            // here) draws its project's Landings window focused on it (revision 28, owner
            // 2026-10-27) instead of a transcript, and nothing ever creates a console model for it.
            if let landing = appModel.session(id: sessionID), landing.isLanding {
                ProjectLandingsWindowView(
                    projectID: landing.landing.flatMap { $0.projectId.isEmpty ? nil : $0.projectId }
                        ?? landing.projectMembership?.projectId,
                    focusID: sessionID)
            } else if let console = registry.peek(sessionID) {
                // Erased on purpose: the two dozen modifiers below each wrapped the transcript and the
                // whole band's view type, and resolving and sizing that nested type at launch ran the
                // iPhone's 1 MB main-thread stack out (TestFlight 0.1.261 (13668), 2026-11-21).
                AnyView(transcriptAndBand(console, navTitleWidth: navTitleWidth))
                // The owner requests this conversation filed, each drawn where it was asked.
                .onChange(of: appModel.ownerRequests?.forSession(sessionID), initial: true) { _, requests in
                    console.adoptOwnerRequests(requests ?? [])
                }
                // Image cache for user-turn attachments, read by `UserBubbleView` down the tree.
                .environment(registry.attachments)
                // The tasks this conversation filed, which a watch's wake line names its targets by.
                .environment(console.createdTasks)
                // One full-screen viewer for the whole transcript: a thumbnail anywhere in it opens here
                // and pages across every image in the session, in transcript order (web parity).
                .environment(\.sessionImagePreview, sessionImagePreview(console))
                // The workspace's background agents and workflows, for the cards that draw them.
                .environment(\.taskActivity, taskActivity(console))
                // Settings › Translation: an answered question keeps the language its card was in.
                .environment(\.questionTranslations, console.questionTranslations)
                // Settings › Translation: what a translated message's foot can do (frames 4–6).
                .environment(\.translationActions, TranslationActions(
                    on: SessionTranslation.isOn(appModel.user),
                    bilingual: SessionTranslation.bilingual(appModel.user?.preferences),
                    agentLanguage: SessionTranslation.agentLanguage(appModel.user?.preferences),
                    retryTurn: { id in Task { await console.retryTurnTranslation(id) } },
                    sendAsWritten: { id in Task { await console.sendTurnAsWritten(id) } },
                    cancelTurn: { bubble in Task { await console.cancelUntranslated(bubble) } },
                    retryReply: { seq in Task { await console.retryReplyTranslation(seq) } }))
                // A task link in this conversation — prose on the Mac, a card's own button —
                // opens over the conversation on a wide shell (owner decision 2026-11-12). With
                // the flag false (every phone) this is the app's own door, word for word.
                .environment(\.openURL, OpenURLAction { url in
                    appModel.openOrbitLink(url, overPage: opensTasksOverPage) ? .handled : .leaving(url)
                })
                .environment(\.openPromotionReview, { promotionID in
                    promotionReview = PromotionReviewTarget(id: promotionID)
                })
                .sheet(item: $promotionReview) { target in
                    PromotionReviewSheet(source: console, promotionID: target.id)
                }
                .environment(\.openPromotionReceipt, { promotion in
                    promotionReceipt = PromotionReceiptTarget(promotion: promotion)
                })
                .sheet(item: $promotionReceipt) { target in
                    PromotionReceiptSheet(promotion: target.promotion)
                }
                // The words an answer's line stands for (`OwnerAnswerLineView`), hosted here for the
                // reason the receipt is: a recycled row cannot dismiss it.
                .environment(\.openOwnerAnswer, { told in
                    ownerAnswerTold = told
                })
                .sheet(item: $ownerAnswerTold) { told in
                    OwnerAnswerSheet(told: told)
                }
                // And the words a fact told to this session stands for (`CoordinatorDeliveryLineView`).
                .environment(\.openCoordinatorDelivery, { told in
                    coordinatorDeliveryTold = told
                })
                .sheet(item: $coordinatorDeliveryTold) { told in
                    CoordinatorDeliverySheet(told: told)
                }
                .environment(approvalReviewDrafts)
                .environment(\.openApprovalReview, { target in
                    approvalReview = target
                })
                .sheet(item: $approvalReview) { target in
                    ApprovalReviewSheet(console: console, target: target)
                        .environment(approvalReviewDrafts)
                }
                // What a card's file area opens, here for the reason the receipt's sheet is.
                .environment(\.openEvidenceFiles, { target in
                    evidenceFiles = target
                })
                .sheet(item: $evidenceFiles) { target in
                    EvidenceFilesPage(console: console, target: target)
                }
                .imagePreview($imagePreviewTarget, images: imagePreviewPages, ns: imagePreviewNS,
                              store: registry.attachments)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Only hydrate the cached model so the transcript renders warm. The live SSE stream is owned
        // by the ConsoleModel and started/stopped by the registry's focus() off app state (not this
        // view's lifecycle) — so backing out to the list reliably drops the connection even if SwiftUI
        // keeps this off-screen view cached, and at most one session ever streams.
        .task(id: sessionID) {
            // Platform work has no transcript to hydrate, and a console model for one would write
            // an empty store beside a page that never shows it.
            guard appModel.session(id: sessionID)?.isLanding != true else { return }
            _ = registry.model(for: sessionID, agentID: agentID)
        }
        .onChange(of: sessionID) { _, _ in
            promotionReview = nil
            promotionReceipt = nil
            ownerAnswerTold = nil
            coordinatorDeliveryTold = nil
            approvalReview = nil
            evidenceFiles = nil
            approvalReviewDrafts = ApprovalReviewDrafts()
            readingBack = false
            bandOpened = false
        }
        #if os(iOS)
        // No needs-you bar in a conversation (the owner, 2026-11-15,
        // docs/mocks/needs-you-capsule/07-console-one-capsule): what waits in OTHER conversations is
        // the lists' and the drawer's to say, and what waits in this one is said by the capsule in the
        // nav bar (`TranscriptView.waitingCapsule`). While you type the nav bar folds away
        // (`foldsChrome`), and a backdrop takes its place behind the status bar so the transcript
        // doesn't scroll under the clock.
        .needsYouTop {
            if hSize == .compact, foldsChrome(registry.peek(sessionID)) {
                Color.clear.frame(height: 0).background(.bar, ignoresSafeAreaEdges: .top)
            }
        }
        // Pushed onto the compact NavigationStack (and shown as the split detail on iPad), this page
        // carries no title, so iOS would reserve a *large* — and empty — title bar: a big blank band
        // at the top, above the transcript. Force the slim inline bar so the transcript starts
        // right under the back button. (The New-session compose page already does this; without it the
        // console reverts to the large bar the moment the session is created — the reported gap.)
        .navigationBarTitleDisplayMode(.inline)
        // …and none at all while a phone's composer holds the keyboard (`foldsChrome`): back, the
        // question and session menu come back when the keyboard goes.
        .toolbar(foldsChrome(registry.peek(sessionID)) ? .hidden : .automatic, for: .navigationBar)
        // No title: back, the ⋯ menu and, between them, the question the top of the screen answers —
        // a capsule the transcript puts there, as only it knows where the reader is
        // (`TranscriptView.stickyQuestion`). The session's name and its "state · when" line gave way
        // to reading space (the owner, 2026-10-15: the title is not needed). Rename… and the project
        // or task a session belongs to are in the menu; whether it runs, the composer's stop button
        // says.
        .toolbar {
            // The project's sessions, left of the ⋯ menu, on the coordinator's conversation and on
            // every member's (owner 2026-11-11, docs/mocks/project-sessions-column board 5). Only a
            // phone's stack: the iPad and the Mac keep the project's page in their own column.
            if opensPagesOverConsole,
               let projectID = SessionProjectSheet.projectID(of: appModel.session(id: sessionID)) {
                ToolbarItem(placement: .topBarTrailing) { projectSessionsButton(projectID) }
            }
            ToolbarItem(placement: .topBarTrailing) {
                // A landing session is platform work (LS6): its page carries the ⋯ menu the design
                // gives it, and none of the conversation's own actions — no rename, share, pin,
                // move or complete. The frame still shows Back, which is how a reader leaves.
                if appModel.session(id: sessionID)?.isLanding != true {
                    if let session = appModel.session(id: sessionID) {
                        sessionMenu(session)
                    } else {
                        Button {} label: { Image(systemName: "ellipsis") }
                            .disabled(true)
                            .accessibilityLabel("Session actions")
                    }
                }
            }
        }
        .sessionRenameAlert(isPresented: $renaming, draft: $renameDraft, sessionID: sessionID)
        // The project's sessions page read as the conversation opens, so the button's count is the
        // one the sheet will show before the sheet is ever opened (`projectSessionCount`). Its
        // members, landing line and merge are then polled as the page polls them, so the button's
        // spinner (`projectActive`) follows them with the sheet closed. While the sheet is open the
        // page polls them itself, so these stop, and read again when it closes.
        .task(id: projectButtonReadAddress) {
            if let address = projectButtonReadAddress { await appModel.loadProjectSessions(address) }
            guard let address = projectButtonReadAddress else { return }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { @MainActor in
                    await ViewPoll.run(appModel, every: 4, inFlight: { 4 }) {
                        await appModel.pollProjectSessions(address)
                    }
                }
                group.addTask { @MainActor in
                    await appModel.loadProjectIntegration(address)
                    await ViewPoll.run(appModel, every: 15, hints: { appModel.projectHints },
                                       inFlight: { appModel.projectSessionsLandingRunning ? 4 : nil }) {
                        await appModel.loadProjectIntegration(address)
                    }
                }
                group.addTask { @MainActor in
                    await appModel.loadProjectMerge(address)
                    await ViewPoll.run(appModel, every: 15, hints: { appModel.projectHints },
                                       inFlight: { appModel.projectSessionsMergeRunning ? 4 : nil }) {
                        await appModel.loadProjectMerge(address)
                    }
                }
            }
        }
        .sheet(item: $projectSheet, onDismiss: {
            let action = afterProjectSheet
            afterProjectSheet = nil
            action?()
        }) { target in
            NavigationStack {
                SessionProjectPage(address: target.address, leaveSheet: { action in
                    afterProjectSheet = action
                    projectSheet = nil
                })
            }
            .environment(appModel)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $taggingSession) { session in
            SessionTagSheet(session: session)
                .environment(appModel)
                .task { await appModel.loadSessionTags() }
        }
        #else
        // The same link on macOS, from the window toolbar: a detail pane's own actions sit at
        // `.primaryAction` there, as the project and task pages' menus do.
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                // No Share on a landing session (LS6): it is platform work, not a conversation,
                // and its page's own ⋯ menu is the whole of what it offers.
                if appModel.session(id: sessionID)?.isLanding != true {
                    Button { showShare = true } label: {
                        Label("Share session", systemImage: "square.and.arrow.up")
                    }
                    .help("Share a read-only link to this session")
                }
            }
            // Move…, the iPhone's ⋯ menu item, beside Share: the same Move panel the list's rows
            // open. None on a landing session (LS6), nor in Trash, where there is nothing to file.
            ToolbarItem(placement: .primaryAction) {
                if let session = appModel.session(id: sessionID), session.isLanding != true,
                   session.effectiveLifecycleState != .trash {
                    Button { openMove(session) } label: {
                        Label("Move…", systemImage: "folder")
                    }
                    .help("Move this session to a folder or another workspace")
                    .disabled(sessionWorkspace(session) == nil)
                }
            }
            // Settings…, the iPhone's ⋯ menu item after Tags…: the same sheet. None on a landing
            // session (LS6), which has no engine to set up.
            ToolbarItem(placement: .primaryAction) {
                if let session = appModel.session(id: sessionID), session.isLanding != true {
                    Button { settingsSession = session } label: {
                        Label(SessionSettingsPanel.menuItem, systemImage: "gearshape")
                    }
                    .help("Session settings: labels, public link, environment, notifications and info")
                }
            }
            // Agent Tools (docs/mocks/agent-tools board ⑤): what the agent here can reach in Orbit and what
            // it was told, read-only. None on a landing session (LS6), which runs no engine.
            ToolbarItem(placement: .primaryAction) {
                if appModel.session(id: sessionID)?.isLanding != true {
                    Button { showAgentTools = true } label: {
                        Label(AgentToolsCopy.title, systemImage: "puzzlepiece.extension")
                    }
                    .help(AgentToolsCopy.sessionLead)
                }
            }
        }
        .sheet(isPresented: $showAgentTools) {
            let session = appModel.session(id: sessionID)
            ConsoleAgentToolsSheet(
                worktree: registry.peek(sessionID)?.worktree,
                engine: session?.engine,
                // The mode the server resolves for the session: its own, else the account's default.
                permissionMode: AgentDefaults.resolvePermissionMode(
                    session: session?.permissionMode,
                    accountDefault: appModel.user?.preferences?.defaultPermissionMode).rawValue,
                // Settings' reading of the switch: absent is on.
                orchestrationOn: appModel.user?.preferences?.enableOrchestration ?? true,
                onDone: { showAgentTools = false })
        }
        #endif
        // Settings… (docs/mocks/session-settings native.html ①–④), on every platform.
        .sheet(item: $settingsSession) { session in
            if let baseURL = appModel.baseURL {
                SessionSettingsSheet(sessionID: session.id,
                                     api: APIClient(baseURL: baseURL, tokenStore: appModel.tokenStore))
                    .environment(appModel)
            }
        }
        // The Move panel, from Move… or the region card (docs/session-folders-move-design.md §4).
        .sheet(item: $movingSession) { session in
            if let workspace = sessionWorkspace(session) {
                SessionMoveSheet(session: session, workspace: workspace, listed: moveListed)
                    .environment(appModel)
                    .task {
                        await appModel.loadSessionFolders()
                        let view: SessionView = session.effectiveLifecycleState == .completed ? .completed : .open
                        if let baseURL = appModel.baseURL {
                            let api = APIClient(baseURL: baseURL, tokenStore: appModel.tokenStore)
                            if let listed = try? await api.listSessions(view: view), !Task.isCancelled {
                                moveListed = listed.filter { ($0.agent?.id ?? $0.agentId) == workspace.id }
                            }
                        }
                    }
            }
        }
        .sheet(isPresented: $showShare) {
            if let baseURL = appModel.baseURL {
                ShareSheet(kind: .session, rootID: sessionID, baseURL: baseURL, tokenStore: appModel.tokenStore,
                           guests: appModel.session(id: sessionID).map { .of($0, agents: appModel.agents) })
            }
        }
    }

    /// The region card's Move to another machine: Move… (`SessionMoveSheet`), on every platform.
    private var moveFromCard: (() -> Void)? {
        guard let session = appModel.session(id: sessionID), sessionWorkspace(session) != nil else { return nil }
        return { openMove(session) }
    }

    #if os(iOS)
    /// The sessions page this conversation's button reads and opens, on a phone's stack, for a
    /// session with a project; nil anywhere else.
    private var projectSheetAddress: SessionProjectAddress? {
        guard opensPagesOverConsole else { return nil }
        let session = appModel.session(id: sessionID)
        return SessionProjectSheet.projectID(of: session).map { appModel.projectSheetAddress($0, session: session) }
    }

    /// What the conversation reads for its project sessions button: the sheet's address, while the
    /// sheet is closed. Open, the page in it reads the same things.
    private var projectButtonReadAddress: SessionProjectAddress? {
        projectSheet == nil ? projectSheetAddress : nil
    }

    /// The project sessions sheet's subject, as `.sheet(item:)` needs it.
    private struct ProjectSheetTarget: Identifiable {
        let address: SessionProjectAddress
        var id: SessionProjectAddress { address }
    }

    /// The project glyph and the project's session count ("⊞ 11"); while anything the sheet shows is
    /// active the glyph gives its place to the session rows' spinner, in the accent (owner
    /// 2026-11-17, docs/mocks/project-sessions-button-running, option C). A press puts the
    /// project's sessions page up as a sheet, opening at medium height.
    private func projectSessionsButton(_ projectID: String) -> some View {
        let count = appModel.projectSessionCount(projectID)
        let active = appModel.projectActive(projectID)
        return Button {
            projectSheet = ProjectSheetTarget(
                address: appModel.projectSheetAddress(projectID, session: appModel.session(id: sessionID)))
        } label: {
            HStack(spacing: 4) {
                if active {
                    SpinnerGlyph(color: .accentColor).frame(width: 20, height: 20)
                } else {
                    Image(systemName: SessionProjectSheet.glyph)
                }
                if let count { Text("\(count)").monospacedDigit() }
            }
        }
        .accessibilityLabel(SessionProjectSheet.buttonLabel)
        .accessibilityValue([count.map { "\($0) sessions" }, active ? "Active" : nil]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("project-sessions-button")
    }
    #endif

    private func sessionWorkspace(_ session: Session) -> Agent? {
        appModel.agents?.items.first { $0.id == (session.agent?.id ?? session.agentId) }
    }

    /// Move…, from the ⋯ menu or the region card: the sheet opens on the folder counts the app already
    /// holds for the session's workspace, which its own read then replaces.
    private func openMove(_ session: Session) {
        let listed = session.effectiveLifecycleState == .completed
            ? (appModel.agents?.agentSessions ?? []) : appModel.sessions
        moveListed = listed.filter {
            ($0.agent?.id ?? $0.agentId) == (session.agent?.id ?? session.agentId)
        }
        movingSession = session
    }

    #if os(iOS)
    private func sessionMenu(_ session: Session) -> some View {
        Menu {
            if session.effectiveLifecycleState == .trash {
                Button { appModel.moveSessionToOpen(session.id) } label: {
                    Label("Move to Open", systemImage: "tray.and.arrow.up")
                }
                .disabled(session.capabilities?.canRestore == false)
                Divider()
                Button(role: .destructive) { confirmPurge = true } label: {
                    Label("Delete Permanently", systemImage: "trash.slash")
                }
            } else {
                Section {
                    Button { showShare = true } label: {
                        Label(SharePanelCopy.share, systemImage: "square.and.arrow.up")
                    }
                    if let url = appModel.sessionWebURL(session.id) {
                        Button {
                            PlatformPasteboard.copyString(url.absoluteString)
                            appModel.showToast(SharePanelCopy.linkCopied)
                        } label: {
                            Label(SharePanelCopy.copyLink, systemImage: "link")
                        }
                    }
                }
                Section {
                    Button {
                        renameDraft = session.title ?? ""
                        renaming = true
                    } label: {
                        Label("Rename…", systemImage: "pencil")
                    }
                    Button { appModel.setPinned(session, pinned: session.pinnedAt == nil) } label: {
                        Label(session.pinnedAt == nil ? "Pin" : "Unpin",
                              systemImage: session.pinnedAt == nil ? "pin" : "pin.slash")
                    }
                    Button { openMove(session) } label: {
                        Label("Move…", systemImage: "folder")
                    }
                    .disabled(sessionWorkspace(session) == nil)
                    Button { taggingSession = session } label: {
                        Label("Tags…", systemImage: "tag")
                    }
                    Button { settingsSession = session } label: {
                        Label(SessionSettingsPanel.menuItem, systemImage: "gearshape")
                    }
                }
                if let taskID = session.taskId {
                    Section {
                        Button {
                            appModel.openFromConversation(.task(taskID), overConsole: opensPagesOverConsole,
                                                          overPage: opensTasksOverPage)
                        } label: {
                            Label("Open Task", systemImage: "arrow.up.right")
                        }
                    }
                } else if let projectID = session.projectId {
                    Section {
                        Button {
                            appModel.openProjectFromConversation(projectID, overConsole: opensPagesOverConsole)
                        } label: {
                            Label("Open Project", systemImage: "arrow.up.right")
                        }
                    }
                }
                Section {
                    if session.effectiveLifecycleState == .completed {
                        Button { appModel.moveSessionToOpen(session.id) } label: {
                            Label("Move to Open", systemImage: "tray.and.arrow.up")
                        }
                        .disabled(session.capabilities?.canRestore == false)
                    } else if session.effectiveLifecycleState == .open {
                        Button { appModel.completeSession(session.id) } label: {
                            Label("Complete Session", systemImage: "checkmark.circle")
                            if session.effectiveRunState.isLive { Text("Stops the current run") }
                        }
                        .disabled(session.capabilities?.canComplete == false)
                    }
                }
                Section {
                    Button(role: .destructive) { appModel.deleteSession(session.id) } label: {
                        Label("Move to Trash", systemImage: "trash")
                        if session.effectiveRunState.isLive { Text("Stops the current run") }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Session actions")
        // Raised by this menu, so it hangs off the menu rather than off the page: the panel opens
        // against the ⋯ that was pressed.
        .orbitConfirmation("Delete permanently?", isPresented: $confirmPurge) {
            Button("Delete Permanently", role: .destructive) { appModel.purgeSession(sessionID) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This session and its full transcript will be permanently deleted. This can't be undone.")
        }
    }
    #endif
}

#if os(macOS)
/// The console's Agent Tools sheet. The sheet holds values only; this reads the one that moves: the session's
/// report, off the detail (GET /sessions/:id) the worktree bar keeps current while the session runs, read once
/// more as the sheet opens, since a settled session's bar does not poll and its runner may have reported since.
private struct ConsoleAgentToolsSheet: View {
    let worktree: WorktreeModel?
    let engine: String?
    let permissionMode: String
    let orchestrationOn: Bool
    let onDone: () -> Void

    var body: some View {
        AgentToolsSheet(
            mode: .session(report: worktree?.detail?.agentTools, engine: engine, permissionMode: permissionMode,
                           orchestrationOn: orchestrationOn, now: Date()),
            onDone: onDone)
            .task { await worktree?.loadDetail() }
    }
}
#endif

/// The band's cards while a phone's composer holds the keyboard (`foldsChrome`): folded to no
/// height, not removed, so an open list, the branch bar's sheet host and a "View tasks ›" press made
/// meanwhile all keep their state, and the cards come back as they were when the keyboard goes.
/// The wide shells never fold, and macOS doesn't take the modifier at all.
///
/// The stack is cut to its own frame only while it folds and while it is folded. Open, the cut
/// stands `glassBleed` clear of it. On iOS 26 the cards are glass, which draws its rim and its
/// shadow past its own edge. A cut at the frame sheared both off: the tray and the git bar lost
/// their rim along the sides and the top, and the tray's shadow was left in the gap below it as a
/// grey slab with square ends (the owner, 2026-10-16).
private struct TypingFold: ViewModifier {
    let folded: Bool
    /// Clear of the deepest shadow a card's glass casts, which is an open tray's: the tallest card.
    private static let glassBleed: CGFloat = 40

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .frame(height: folded ? 0 : nil, alignment: .top)
            .clipShape(Rectangle().inset(by: folded ? 0 : -Self.glassBleed))
            .opacity(folded ? 0 : 1)
            .allowsHitTesting(!folded)
            .accessibilityHidden(folded)
        #else
        content
        #endif
    }
}

/// The cards a page's chat hangs under the conversation's turns (`TranscriptChatCard`), and how the page draws one:
/// a Drive chat's change groups and overwrite questions (board drive-chat 02). Nil everywhere else.
struct TranscriptChatCards {
    let cards: [TranscriptChatCard]
    let render: (String) -> AnyView
}

private struct TranscriptChatCardsKey: EnvironmentKey {
    static let defaultValue: TranscriptChatCards? = nil
}

extension EnvironmentValues {
    var transcriptChatCards: TranscriptChatCards? {
        get { self[TranscriptChatCardsKey.self] }
        set { self[TranscriptChatCardsKey.self] = newValue }
    }
}

struct TranscriptView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openApprovalReview) private var openApprovalReview
    @Environment(\.transcriptChatCards) private var chatCards
    @Environment(\.openPromotionReview) private var openPromotionReview
    let console: ConsoleModel
    /// The sticky "↑ Your question" header folds away while a phone's composer holds the keyboard,
    /// with the rest of the console's chrome (`ConsoleView.foldsChrome`).
    var hidesStickyQuestion = false
    /// Keep the preview's place while its sheet refreshes or the conversation keeps streaming.
    var reviewingCard = false
    /// The nav bar's centre slot on iOS, which the sticky question's capsule truncates within — a
    /// `.principal` item is otherwise sized to its ideal width (`ConsoleView.body`). Unused on macOS.
    var questionWidth: CGFloat = 0
    /// Written for `ConsoleView.foldsBand`: whether the reader has gone back far enough through the
    /// history for a phone's composer band to fold to its bar (`TailPinning.foldsBand`).
    var readingBack: Binding<Bool> = .constant(false)
    /// The band is folded to its pill (`FoldedBandBar`): the floating disc stands down until it opens.
    var bandFolded = false
    /// The bar was tapped open; the reader's next drag folds the band again.
    var bandOpened: Binding<Bool> = .constant(false)
    @State private var reviewSessionID: String?
    /// The settled-items folds the reader opened, by their first card's row id (D1 = A).
    @State private var settledFoldsOpen: Set<String> = []
    /// Which session's Recap card has stepped aside for this visit. It is set once that conversation
    /// starts a new turn, because the reader is in it now and a card arriving under each answer
    /// would push the answer up. It is cleared when this view opens another session: the Mac and
    /// iPad split keep one console view across sessions (`AgentsView`), so a plain flag would carry
    /// one conversation's choice into the next.
    @State private var recapAsideFor: String?
    /// The recaps this device hid with the card's × this run, by session (`RecapCard.hideKey`); the
    /// rest are read from UserDefaults as their session is shown. A hidden recap stays hidden in its
    /// conversation until the server writes a newer one (the owner, 2026-11-01, 06-hide).
    @State private var hiddenRecaps: [String: String] = [:]
    private let bottomID = TranscriptRow.bottom.id
    // Mirrors web's `atBottom` (AgentView.tsx): flips false once the user scrolls up off the live
    // tail. Drives the floating jump-to-latest button AND gates the auto-follow below, so reading
    // history isn't yanked back down by streaming updates. Maintained by `ScrollTracker` (macOS 15+);
    // on the macOS 14 floor it stays true — the view keeps the unconditional follow and hides the button.
    @State private var atBottom = true
    /// The row this conversation was opened at, held in place while the rest of it lands: the waiting
    /// card a project row's tap opened it on (`console.cardRequest`), or the record a link named
    /// (`console.recordRequest`). Put back on every publish and every change in the content's height,
    /// and dropped on the reader's own scroll, a jump to the latest, a send, or another session
    /// (`TranscriptLanding`; web `landingRef`).
    @State private var landing: TranscriptLanding?
    // Whether more than `TailPinning.nearBottom` of content sits below the viewport right now, for any
    // reason. `atBottom` can't say: it un-pins on a scroll UP alone, so a pinned transcript whose tail
    // left the view some other way — a row that grew under it (a card opened, an image or link card
    // landing), the keyboard, a follow that fell short — still read as at the bottom, and the
    // jump-to-latest button never showed. Maintained by `ScrollTracker` beside `atBottom`.
    @State private var tailOutOfView = false
    // Pinned, but come to rest with the tail out of view: the button's other reason to show. Decided by
    // the `.task(id: strandKey)` in `body`, so a gap the next follow is about to close never flashes it.
    @State private var stranded = false
    // Id of the user turn the sticky header names — the newest question above the fold — or nil at the
    // very top where none is. Derived from the top anchor + the message list by `recomputeStuck`.
    @State private var stuckID: String?
    // The scroll state the header derives from. A reference type held in @State: rows and the scroll
    // tracker mutate it every frame WITHOUT invalidating the view — only `stuckID`, assigned when the
    // answer changes, redraws. Its ONLY scroll input is `topAnchorID`: the id of the item currently
    // under the viewport top, always set by a row that IS on screen. That's the key to robustness — the
    // header is a pure function of (top anchor, message list), recomputed each scroll, so it can't
    // accumulate the corruption a per-row crossing set did (a recycling List destroys a row the instant
    // it clears the top edge, so "I scrolled above" can never be observed; an accumulating set only
    // grew and the header died). See `recomputeStuck` / `QuestionRuler`.
    @State private var ruler = QuestionRuler()
    // A scroll asked for from OUTSIDE a SwiftUI update — the main-queue hop after a tap halts the coast,
    // or after a link's page lands — carried into the next update, which makes it (the
    // `.onChange(of: heldScroll)` in `body`). `proxy.scrollTo` picks the row's index path when it is
    // called but scrolls when the List next updates; called from out here, a publish landing in between
    // can remove rows, and UIKit is handed an index past the end: NSInternalInconsistencyException out of
    // `_validateScrollingTargetIndexPath`, SIGABRT — the 0.1.2 (4028) TestFlight crash. Inside an update
    // both halves see the same rows.
    @State private var heldScroll: HeldScroll?
    #if os(iOS)
    // Handle to the List's UIScrollView (populated by `ScrollTouchConfigurator`) so the jump-to-latest
    // action can force a scroll to the bottom even while the list is coasting.
    @State private var transcriptScroll = TranscriptScroll()
    #endif

    /// The transcript's scroll observer, carrying the iOS-only UIKit handle where there is one.
    /// A helper rather than a `#if` in the call's argument list: conditional compilation does not
    /// parse there (`expected ')' in expression list`), which is what the first version of this
    /// landed as — two red compile gates.
    private func tracker(ruler: QuestionRuler) -> some ViewModifier {
        #if os(iOS)
        return ScrollTracker(atBottom: $atBottom, tailOutOfView: $tailOutOfView, ruler: ruler,
                             recompute: recomputeStuck, follow: repinAfterResize, scroll: transcriptScroll,
                             readingBack: readingBack,
                             dragged: { if bandOpened.wrappedValue { bandOpened.wrappedValue = false } },
                             readerScrolled: { landing = nil; console.readerTookOver() },
                             landingHolds: { landingHolds(offset: $0, resizedTo: $1) })
        #else
        return ScrollTracker(atBottom: $atBottom, tailOutOfView: $tailOutOfView, ruler: ruler,
                             recompute: recomputeStuck, follow: repinAfterResize,
                             readerScrolled: { landing = nil; console.readerTookOver() },
                             landingHolds: { landingHolds(offset: $0, resizedTo: $1) })
        #endif
    }

    /// The viewport changed size under a pinned transcript — the keyboard rising, the composer
    /// growing a line, the chrome folding away — or the scroll geometry moved its tail without
    /// anybody scrolling (`ScrollTracker`: rows measured to a new height, the sticky header pushing
    /// them down), and the tail is asked for, the way a tap on the jump-to-latest disc asks for it
    /// (`heldScroll`: this arrives off a layout report, so the rows it names are the ones the next
    /// update has, not whatever this frame holds).
    private func repinAfterResize() {
        // A window opened at a record ends at a gap, a preview's place is held while its sheet is up,
        // and so is a row the transcript was opened at: none follows the tail, so none follows a
        // resize to it.
        guard !console.detached, !reviewingCard, landing == nil else { return }
        #if os(iOS)
        // A lazy List's `contentSize` is an estimate until it lays out again, and a programmatic
        // scroll is CLAMPED to it: asked in the same update that grew the composer, the scroll
        // stops wherever the estimate ended, one line short of the tail. Settle the layout first.
        DispatchQueue.main.async {
            transcriptScroll.view?.layoutIfNeeded()
            holdScroll(to: bottomID, anchor: .bottom, animated: false)
        }
        #else
        holdScroll(to: bottomID, anchor: .bottom, animated: false)
        #endif
    }

    /// The scroll geometry changed under a held row (`ScrollTracker.landingHolds`). The reading's
    /// offset first settles whether the last put-back moved the list, which is what restarts the
    /// quiet wait (`TranscriptLanding.read`). Then the row is put back when the content took a new
    /// height, and the answer is whether it is still held. This arrives off a layout report, so the
    /// put-back is a held scroll (`heldScroll`), as `repinAfterResize`'s is.
    private func landingHolds(offset: Double, resizedTo height: Double?) -> Bool {
        guard var held = landing else { return false }
        held.read(offset: offset, at: Date())
        guard held.keep(in: console.sessionID, contentHeight: height, at: Date()) else {
            landing = nil
            return false
        }
        if held != landing { landing = held }
        if height != nil { holdScroll(to: held.rowID, anchor: landingAnchor(held), animated: false, putsBack: true) }
        return true
    }

    /// A publish under a held row: put it back, inside this update, and say whether it is still held.
    private func keepLanding(_ proxy: ScrollViewProxy) -> Bool {
        guard var held = landing else { return false }
        guard held.keep(in: console.sessionID, contentHeight: nil, at: Date()) else {
            landing = nil
            return false
        }
        held.puttingBack(from: Double(ruler.contentOffset))
        if held != landing { landing = held }
        proxy.scrollTo(held.rowID, anchor: landingAnchor(held))
        return true
    }

    private func landingAnchor(_ held: TranscriptLanding) -> UnitPoint {
        switch held.place {
        case .top: return .top
        case .center: return .center
        }
    }

    /// What `stranded` is re-decided on: the tail leaving or entering the view, the pin, and every
    /// publish — whose follow may yet close the gap.
    private var strandKey: String { "\(tailOutOfView)|\(atBottom)|\(console.stateRevision)" }

    /// Whether the load-earlier row is offered at all. Gated to the same floor as `ScrollTracker`:
    /// below it `atBottom` can never leave true, so the follow-on publish of a prepended page would
    /// yank the reader straight back to the live tail — worse than today's no-paging. The legacy
    /// floor keeps the pre-paging behavior (the loaded tail is all you can scroll).
    private var canPageOlder: Bool {
        guard #available(iOS 18, macOS 15, *) else { return false }
        return console.state.hasMoreOlder
    }

    var body: some View {
        // `List` is NSTableView-backed on macOS → true row recycling, so a long transcript stays
        // cheap to lay out. (A `LazyVStack` paired with `scrollPosition(id:anchor:)` /
        // `scrollTargetLayout()` re-measured and re-placed *every* row on each streamed update and
        // froze the UI — never reintroduce those here.)
        //
        // `.defaultScrollAnchor(.bottom)` only positions the bottom on *first* appearance; it does
        // not follow new content. So an explicit, non-animated `scrollTo` on every content change
        // keeps the latest message — and a streaming reply — in view, and re-pins the bottom when
        // you switch sessions (the view is reused, only `console` swaps). This is cheap on a
        // recycling List: a single one-shot scroll per change, not the per-frame *animated* scroll
        // that froze the old LazyVStack build.
        ScrollViewReader { proxy in
            chrome(follows(rowsList, proxy), proxy)
        }
        // Held by its runner's update (board 5 of docs/mocks/runner-update-drain): the foot row of
        // the reader's last message says so, or, before there is one, the queued page does.
        .environment(\.runnerUpdatingFoot, runnerUpdatingFoot)
        // …and where that message is one no runner has taken, Cancel beside the tag (`HeldCancel`).
        .environment(\.heldCancel, { [console] bubble in Task { await console.cancelHeld(bubble) } })
        .overlay { runnerUpdatingPage }
        // macOS shows the session state in this band. iOS gave the state up with the nav-bar title,
        // for reading space (see `ConsoleView`'s toolbar), so the band is retired there.
        #if os(macOS)
        .safeAreaInset(edge: .top, spacing: 0) { statusBar }
        #endif
    }

    /// The session as the list holds it, when its runner's update is what holds it — or a full runner,
    /// run or batch, which is said in the same places by the same rules (docs/mocks/queued-card-runner-full).
    private var runnerUpdatingSession: Session? {
        guard let session = app.session(id: console.sessionID),
              RunnerUpdating.holds(session) || QueuedCapacity.holds(session) || QueuedDiskLow.holds(session) else { return nil }
        return session
    }

    /// Whether a waiting turn is what the update holds — on the queued tail, whose line says so
    /// (`runnerUpdatingQueued`), or in the tray, whose row does (`PendingTrayView.held`): then neither
    /// the last message nor the queued page does (web `tailHeld`).
    private var runnerUpdatingTailHeld: Bool { RunnerUpdating.tailHolds(console.state.queued) }

    private var runnerUpdatingFoot: RunnerUpdatingFoot? {
        guard let session = runnerUpdatingSession, !runnerUpdatingTailHeld,
              let id = RunnerUpdating.footBubbleID(console.state.items, accepted: console.state.accepted) else { return nil }
        return RunnerUpdatingFoot(bubbleID: id, session: session, machine: console.runnerName, runnerID: console.runnerID)
    }

    /// The tag a queued-tail turn the update holds reads in place of `Queued`.
    private func runnerUpdatingQueued(_ bubble: UserBubble) -> RunnerUpdatingFoot? {
        guard let session = runnerUpdatingSession, RunnerUpdating.holdsQueued(bubble) else { return nil }
        return RunnerUpdatingFoot(bubbleID: bubble.id, session: session, machine: console.runnerName, runnerID: console.runnerID)
    }

    @ViewBuilder private var runnerUpdatingPage: some View {
        if let session = app.session(id: console.sessionID), console.state.items.isEmpty,
           let card = QueuedClone.card(session: session, workspace: console.cloneWorkspace,
                                       heard: app.cloneLedger.heard(console.cloneWorkspace?.id),
                                       storedAt: console.cloneWorkspaceReadAt) {
            CloneWaitCardView(card: card, machine: console.runnerName)
        }
        if let session = runnerUpdatingSession, RunnerUpdating.holds(session), !runnerUpdatingTailHeld,
           RunnerUpdating.footBubbleID(console.state.items, accepted: console.state.accepted) == nil {
            RunnerUpdatingQueuedView(session: session, machine: console.runnerName, runnerID: console.runnerID,
                                     onOpenSession: { app.route(to: .session($0)) })
        }
    }

    /// Split out of `body`, and out of each other, because as one expression this chain is long
    /// enough that the iOS type-checker gives up on it — "unable to type-check this expression in
    /// reasonable time; try breaking up the expression into distinct sub-expressions",
    /// ConsoleView.swift:627, which is how v0.1.2-beta.174's iOS archive failed. Each piece declares
    /// `some View`, so the checker works on it alone and one more modifier stays cheap.
    /// The transcript itself: one flat `ForEach` over the pre-assembled rows, with the row-level
    /// preferences that must sit on the outermost row view.
    private var rowsList: some View {
        // One build of the rows, and the settled-items folds among them (D1 = A).
        let folded = foldedRows
        let rows = folded.rows
        return List {
            ForEach(rows) { row in
                transcriptRow(row, folds: folded.folds)
                    // Row-level preferences must sit OUT here, not inside `transcriptRow`'s
                    // switch (or inside `AnchorRow`'s `if #available`): `listRow*` set inside a
                    // `_ConditionalContent` branch aren't hoisted to the List on iOS — the
                    // separators leaked back in. On the outermost row view they propagate
                    // reliably (a chat flow, no hairlines).
                    .listRowInsets(rowInsets(row))
                    .listRowSeparator(.hidden)
                    // The record a link opened (`SessionRecordLink`), marked for a moment.
                    .listRowBackground(row.id == console.highlightedRowID
                                       ? Color.accentColor.opacity(0.14) : Color.clear)
            }
        }
        .listStyle(.plain)
        // A transcript row is content, not a table cell, so drop the 44pt floor a List applies
        // by default. That floor is why a folded tool card appeared to jump upward on the tap
        // that opened it: folded, the card is ~32pt and the List padded the cell to 44 and
        // centred it, sitting the header ~6pt low; expanded, the row is far past the floor, so
        // the header snapped back to where it always belonged. Nothing above it moved, which is
        // what ruled out a scroll. Every short row in the transcript was paying the same 12pt —
        // including the 1pt scroll-anchor row at the tail.
        .environment(\.defaultMinListRowHeight, 0)
        // The ended questions this conversation holds: a turn handing one's answer to the coordinator
        // is that question's card — in the transcript and on the queue alike (`OwnerAnswerLineView`).
        .environment(\.answeredQuestions, console.answeredQuestions)
        // The item a record link or a search hit asked for: a long message from another session opens to it.
        .environment(\.revealedItemID, console.revealedItemID)
        // A SubAgent's end turns, joined to their cards by run id: what the agent read, and a queued one's
        // Don't send (`SubagentCardEnd`).
        .environment(\.subagentWakes, console.subagentWakes)
        .environment(\.subagentQueuedWakes, console.subagentQueuedWakes)
        // A bg_run job's card: its runner reports, its wake turns and a queued one's Don't send, joined by
        // job id, and where it reads its tail and asks to stop it (`JobCardView`).
        .environment(\.jobCardHost, console.jobCardHost(place: app.session(id: console.sessionID)?.agent?.name))
        .scrollContentBackground(.hidden)   // show the window background, not the List's own
        #if os(iOS)
        // Turn OFF the scroll view's touch delay so an in-list control (the jump-to-latest disc, the
        // sticky header) registers a tap even while the list is still coasting. With the default
        // (`delaysContentTouches == true`) the scroll view delays and consumes that first touch to
        // halt deceleration, so the control only fired once the list settled. No public SwiftUI API.
        .background { ScrollTouchConfigurator(scroll: transcriptScroll) }
        #endif
        .scrollDismissesKeyboard(.interactively)   // iOS: swipe the transcript to lower the keyboard
        .defaultScrollAnchor(.bottom)
        .modifier(tracker(ruler: ruler))
        .modifier(ViewportResize(atBottom: atBottom, onResize: repinAfterResize))
        // The transcript viewport's top edge in global space — the line `AnchorRow` tests each row
        // against to find the one under the top. Stable during a scroll (only shifts on layout, e.g.
        // the keyboard), so reading it here doesn't churn.
        .background {
            GeometryReader { g in
                Color.clear.onChange(of: g.frame(in: .global).minY, initial: true) { _, y in ruler.viewportTop = y }
            }
        }
        // On the list alone, under `chrome`, so the jump-to-latest disc floating over it stays solid.
        .meetsComposerBand()
        .noTopEdgeEffect()
        // Follow new/streaming content only while pinned at the bottom (web's smart auto-scroll):
        // if the user has scrolled up to read, don't drag them back. A session switch always
        // re-pins. One-shot, non-animated scrollTo — never the per-frame animated scroll that froze
        // the old build. Keyed on `stateRevision`, not `state.items`: the revision is an O(1)
        // compare bumped once per published snapshot, where the items array would be
        // Equatable-compared in full on every publish just to learn "something changed".
    }

    /// Split out of `body`, and out of each other, because as one expression this chain is long
    /// enough that the iOS type-checker gives up on it — "unable to type-check this expression in
    /// reasonable time; try breaking up the expression into distinct sub-expressions",
    /// ConsoleView.swift:627, which is how v0.1.2-beta.174's iOS archive failed. Each piece declares
    /// `some View`, so the checker works on it alone and one more modifier stays cheap.
    /// Everything that follows what the console publishes: the scrolls, the re-pins and the reading
    /// position, in the order they were written.
    private func follows(_ content: some View, _ proxy: ScrollViewProxy) -> some View {
        content
        .onChange(of: console.stateRevision) {
            // A prepend published: re-pin the row under the viewport top so what the user is
            // reading stays put (web's layout-effect scroll compensation). `ruler.topAnchorID`
            // still holds its PRE-prepend reading here (row geometry re-fires only after the
            // new layout), i.e. exactly the row to hold steady — even if the user scrolled
            // away from the trigger while the fetch was in flight. Fallback: the row that was
            // the window's first (the model's anchor; the spinner row above it carries no
            // AnchorRow, so it never claims the top). Always consumed; while pinned at the
            // bottom the follow below wins instead — a short transcript auto-fills upward and
            // must not yank the user off the live tail.
            let prependAnchor = console.takePrependAnchor()
            // A window opened at a record ends at a gap, so its bottom is never the live tail to
            // follow — pinning there would only walk the window down page by page.
            if keepLanding(proxy) {
                // Opened at a waiting card or a record: a publish while it is held puts it back.
            } else if atBottom && !console.detached && !reviewingCard {
                proxy.scrollTo(bottomID, anchor: .bottom)
            } else if let prependAnchor {
                proxy.scrollTo(ruler.topAnchorID ?? prependAnchor, anchor: .top)
            }
            recomputeStuck()   // a new turn — or one measured for the first time — can change the answer
        }
        // An Orbit link card is a reading of a live object, so the links this transcript is
        // showing are asked for again as the console refreshes — one write per publish that
        // costs a request only for what has gone stale, and no poll of the cards' own.
        .onChange(of: console.stateRevision) { app.linkCards?.refreshStale() }
        // The in-memory window cap trims the HEAD of the transcript, so it may only run while
        // the reader is pinned at the live tail — see `ConsoleModel.setReadingHistory`.
        // `initial: true` so a console opened (or switched to) already at the bottom is capped
        // without waiting for a scroll that may never come.
        .onChange(of: atBottom, initial: true) { _, pinned in
            console.setReadingHistory(!pinned)
        }
        .onChange(of: reviewingCard, initial: true) {
            if reviewingCard {
                reviewSessionID = console.sessionID
                atBottom = false
            } else {
                if reviewSessionID == console.sessionID { atBottom = false }
                reviewSessionID = nil
            }
        }
        .onChange(of: console.sessionID) {
            atBottom = true; stranded = false; ruler.reset(); stuckID = nil; landing = nil
            console.setReadingHistory(false)
            // The reader's place went with the transcript that was on screen: the new one has
            // not been laid out yet, and the bar's direction word must not answer for the
            // session that just left.
            console.noteTopVisible(nil)
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
        // A message the user just sent forces the transcript back to the live tail — even if
        // they'd scrolled up to read history (the stateRevision follow above only re-pins while
        // already at the bottom). Web parity: onSend re-pins atBottom on send (AgentView.tsx).
        .onChange(of: console.localSendTick) {
            atBottom = true; landing = nil; console.readerTookOver()
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
        // A local command is an explicit new tail item, so reveal it even when the reader had
        // scrolled up. This matches a normal local send and web's `pinToBottom()` behavior.
        .onChange(of: console.localStatusCards.count) {
            atBottom = true; landing = nil
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
        // The "N open questions below" bar, pressed. It sits outside this reader (it is an
        // inset of the whole console, above the nav bar's content), so the request crosses on
        // the model — with a tick, so pressing it twice scrolls twice. `.center` rather than
        // `.top`: a decision card is an object to read whole, not a place to resume reading
        // from.
        .onChange(of: console.scrollRequest) { _, request in
            guard let request else { return }
            atBottom = false
            landing = nil   // the reader chose another card to read
            #if os(iOS)
            // Same coast fix as the jump-to-latest disc: cancel the momentum first, or the
            // deceleration swallows the scroll.
            transcriptScroll.halt()
            #endif
            DispatchQueue.main.async {
                holdScroll(to: request.rowID, anchor: .center, opensReview: true)
            }
        }
        // An owner request a link, a push's action or the Later reminder named: its card's row. The
        // press can arrive before this transcript first appears, and the card is drawn from the
        // account's request read a moment later, so the request is only spent once its row exists —
        // `initial: true` follows one held by a console the press created.
        .onChange(of: console.ownerRequestRequest, initial: true) { _, request in
            guard let request, rows.contains(where: { $0.id == request.rowID }) else { return }
            atBottom = false
            console.ownerRequestRequestFollowed()
            #if os(iOS)
            transcriptScroll.halt()
            #endif
            DispatchQueue.main.async { holdScroll(to: request.rowID, anchor: .center) }
        }
        // A link to one record (`SessionRecordLink`): scroll to its row. The reader is taken off
        // the live tail first, said outright as the sticky header's jump says it — a programmatic
        // jump is no drag the scroll tracker could read, and the next publish would pull them back.
        // `initial: true` because the page can land before this transcript first appears; the
        // console consumes the request once followed, so reappearing does not jump back to it.
        // Held where it lands (`landing`): the rows still arriving around it must not carry it off.
        .onChange(of: console.recordRequest, initial: true) { _, request in
            guard let request else { return }
            atBottom = false
            console.recordRequestFollowed(request)
            #if os(iOS)
            transcriptScroll.halt()
            #endif
            let sessionID = console.sessionID
            DispatchQueue.main.async {
                landing = TranscriptLanding(rowID: request.rowID, sessionID: sessionID, place: .center, at: Date())
                holdScroll(to: request.rowID, anchor: .center)
            }
        }
        // A conversation opened from a project row that says it is waiting on you (owner
        // 2026-11-14): the top of its waiting card, header and title, rather than the transcript's
        // end. Off the live tail first, as above; set on the next turn of the run loop with the
        // scroll, after the session switch's own re-pin (`console.sessionID` above) has run. `initial`
        // because the request is made before this transcript appears; consumed once followed. Then
        // held there (`landing`): a self-sizing List places a row it has not laid out by estimates,
        // which put the card's first landing far above it, and the rest of the conversation, its
        // cards and images keep landing above it after that.
        .onChange(of: console.cardRequest, initial: true) { _, request in
            guard let request else { return }
            console.cardRequestFollowed()
            #if os(iOS)
            transcriptScroll.halt()
            #endif
            let sessionID = console.sessionID
            DispatchQueue.main.async {
                atBottom = false
                landing = TranscriptLanding(rowID: request.rowID, sessionID: sessionID, place: .top, at: Date())
                holdScroll(to: request.rowID, anchor: .top, animated: false)
            }
        }
        // The scrolls `heldScroll` carried here, made inside this update — after the List has taken
        // its rows, so the index path SwiftUI picks for the row is one UIKit has.
        .onChange(of: heldScroll) { _, held in
            guard let held, held.sessionID == console.sessionID else { return }
            if held.opensReview {
                guard let row = rows.first(where: { $0.id == held.rowID }) else { return }
                // Settle the preview's position before presenting; an animation could be
                // interrupted by the sheet and leave its row off-screen on return.
                proxy.scrollTo(held.rowID, anchor: held.anchor)
                openReview(for: row)
            } else if held.animated {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(held.rowID, anchor: held.anchor)
                }
            } else {
                // A held row put back: the next geometry reading says whether this moved the list
                // (`TranscriptLanding.read`), measured from the offset the last reading left.
                if held.putsBack, var row = landing, row.rowID == held.rowID {
                    row.puttingBack(from: Double(ruler.contentOffset))
                    landing = row
                }
                proxy.scrollTo(held.rowID, anchor: held.anchor)
            }
        }
        .onAppear { proxy.scrollTo(bottomID, anchor: .bottom); recomputeStuck() }
    }

    /// Split out of `body`, and out of each other, because as one expression this chain is long
    /// enough that the iOS type-checker gives up on it — "unable to type-check this expression in
    /// reasonable time; try breaking up the expression into distinct sub-expressions",
    /// ConsoleView.swift:627, which is how v0.1.2-beta.174's iOS archive failed. Each piece declares
    /// `some View`, so the checker works on it alone and one more modifier stays cheap.
    /// What sits over the list rather than in it: the jump-to-latest disc, the stranded-off-tail task,
    /// the sticky question header and their animations.
    private func chrome(_ content: some View, _ proxy: ScrollViewProxy) -> some View {
        content
        // Floating jump-to-latest button (web's `.scroll-to-bottom`): shown while scrolled up, and
        // while the tail is out of view for any other reason (`stranded`).
        .overlay(alignment: .bottom) {
            // While the composer band is folded only its pill stands there (the owner, 2026-11-11):
            // the jump comes back with the band.
            if !bandFolded, !atBottom || console.detached || stranded {
                scrollToBottomButton(proxy: proxy)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        // One observer for both, so a switch to a session that is already working is decided in one
        // step: the card is back for a newly opened session, and away once it starts a turn.
        .onChange(of: RecapVisit(sessionID: console.sessionID, rests: recapRests), initial: true) { old, new in
            if old.sessionID != new.sessionID { recapAsideFor = nil }
            if !new.rests { recapAsideFor = new.sessionID }
        }
        // Whether a pinned transcript is stranded off its tail, decided once it has sat that way for
        // a moment. A publish restarts the wait: the follow it triggers lands a frame or two after
        // the rows grew, and the gap read in between — the normal state while a reply streams (see
        // `TailPinning`) — must not flash the button on every update. A transcript the reader
        // scrolled up isn't decided here: `!atBottom` shows the button already.
        .task(id: strandKey) {
            guard atBottom, tailOutOfView else { stranded = false; return }
            try? await Task.sleep(for: .milliseconds(400))
            if !Task.isCancelled { stranded = true }
        }
        // Sticky "↑ Your question" header (web's `.chat-sticky-question`): pin the newest question
        // *above the fold* to the top so it stays in view during a long reply, and tap it to jump
        // back; it steps back through earlier questions as you scroll up (see `recomputeStuck`) and
        // hides only at the very top where no question is above. iOS 18+/macOS 15+ (needs the
        // scroll/row geometry); on the earlier floor `stuckID` never updates, so this stays hidden.
        #if os(iOS)
        // On iOS it is the nav bar's centre piece, not a band under the bar (the owner, 2026-10-15:
        // the band and the title above it took too much of the screen). Up there it moves nothing,
        // and a `scrollTo(anchor: .top)` lands the target just under the bar. It shows only while
        // the reader is off the live tail — scrolled up into the history, or reading a window opened
        // at a record — the same "off the tail" the jump-to-latest disc answers to: at the tail the
        // reader is following the answer to what they just asked (the owner, the same day).
        .toolbar {
            ToolbarItem(placement: .principal) {
                // One capsule up here (the owner, 2026-11-15, 07-console-one-capsule, B): what waits
                // on the reader in this conversation takes it while its card is out of sight — above
                // them, or anywhere once they are off the tail (at the tail the card is the tail);
                // otherwise the question above the fold, as before. A coordinator handing itself over
                // takes it over both, at the tail and off it, while the note is written and the
                // replacement runs (the owner, 2026-11-15, coordinator-context-actions board 04, A).
                // The switch between them is one capsule changing (08-motion ⑤): the old words
                // leave upward, the new come in from below, the width eases between them.
                let handingOver = !hidesStickyQuestion
                    && CoordinatorContextActions.locksComposer(app.session(id: console.sessionID)?.coordinatorHandoff)
                let here = hidesStickyQuestion ? nil : console.waitingBelow
                let saysWaiting = !handingOver
                    && (here.map { $0.side == .above || !atBottom || console.detached } ?? false)
                Group {
                    if handingOver {
                        handingOverCapsule
                            .frame(maxWidth: questionWidth)
                            .transition(reduceMotion ? .opacity : .push(from: .bottom))
                    } else if saysWaiting, let here {
                        waitingCapsule(here)
                            .frame(maxWidth: questionWidth)
                            .transition(reduceMotion ? .opacity : .push(from: .bottom))
                    } else {
                        principalQuestion(proxy)
                            .transition(reduceMotion ? .opacity : .push(from: .bottom))
                    }
                }
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.26), value: saysWaiting)
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.26), value: handingOver)
            }
        }
        #else
        // Shown whenever such a question exists — including at the bottom — exactly like web, not
        // gated on `atBottom`. In-flow inset (not an overlay) so it pushes content down like web: a
        // `scrollTo(anchor: .top)` then lands the target just *below* the header, not hidden under it.
        .safeAreaInset(edge: .top, spacing: 0) {
            if #available(iOS 18, macOS 15, *), !hidesStickyQuestion, let q = stuckBubble {
                stickyQuestion(q, proxy: proxy)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        #endif
        .animation(.easeOut(duration: 0.15), value: atBottom)
        .animation(.easeOut(duration: 0.15), value: stranded)
        // Only fires when the header appears/disappears (not on every text swap), so animating it
        // can't churn during a scroll.
        .animation(.easeOut(duration: 0.15), value: stuckID == nil)
    }

    // Which question is "stuck" to the top = the last user turn that sits ABOVE the item currently under
    // the viewport top (`topAnchorID`). Everything before that anchor item is above the fold, so the last
    // user turn among them is web's `.chat-user` bottom-above-top answer — and it steps back through
    // earlier questions as the anchor moves up. Pure data: we only read the anchor id (set by an on-screen
    // row) and the message list, so nothing here can be left stale by recycling. If no row has claimed the
    // top yet (freshly opened, before the first geometry callback) but we're scrolled below the top, fall
    // back to naming the last question so the header shows at once; at the very top / short transcripts it
    // stays nil. Queued turns are skipped (web's `:not(.chat-queued)`) — they haven't been asked yet — and
    // so is a watch's wake, a background job's news, a wakeup coming due or the owner's answer handed to
    // the coordinator, a line inside an answer rather than the head of one (`StickySummary.isAnchor`;
    // web's line carries no `data-orbit-round`).
    //
    // Which turns are questions is read once per published state (`StickyQuestions`, kept on the
    // ruler), so a scroll is a lookup rather than a walk re-reading every turn's text.
    private func recomputeStuck() {
        // Where the reader is, for the console: the needs-you bar's direction word points at a card
        // and has to say which way it is. Reported here rather than read off the ruler by the bar,
        // which is an inset of the whole console and has no ruler of its own.
        console.noteTopVisible(ruler.topAnchorID)
        let questions = ruler.questions(console) { StickyQuestions($0.state.items, isQuestion: namesAQuestion) }
        var found: String? = nil
        // Both answers are held (`StickyQuestionHold`): the header moves the list by its own height,
        // so a reading taken with it shown and one taken with it hidden can disagree, and a single
        // threshold between them flips the header on every frame.
        if let anchor = ruler.topAnchorID {
            found = StickyQuestionHold.named(found: questions.above(anchor), anchor: anchor, showing: stuckID)
        } else if StickyQuestionHold.fallbackNames(contentOffset: Double(ruler.contentOffset),
                                                   showing: stuckID != nil) {
            found = questions.last
        }
        if found != stuckID { stuckID = found }
    }

    /// A turn the bar may point back at: asked already, and the head of a round rather than a line inside one.
    private func namesAQuestion(_ b: UserBubble) -> Bool {
        !b.queued && StickySummary.isAnchor(text: b.text, note: b.note, itemCard: b.itemCard,
                                            taskStart: b.taskStart, startedCard: b.startedCard,
                                            sessionMessage: b.sessionMessage, ownerAnswer: b.ownerAnswer,
                                            coordinatorDelivery: b.coordinatorDelivery,
                                            hasAttachments: !b.attachments.isEmpty)
    }

    private var stuckBubble: UserBubble? {
        guard let id = stuckID else { return nil }
        for item in console.state.items.reversed() {
            if case .user(let b) = item, b.id == id { return b }
        }
        return nil
    }

    /// The List's rows, assembled from ONE read of each source so the snapshot the List diffs is
    /// always internally consistent (`console.state` publishes on a 200ms coalescing timer while
    /// `localStatusCards` / `showWorkingIndicator` publish immediately).
    private var rows: [TranscriptRow] { foldedRows.rows }

    /// The rows drawn, and the settled-items folds among them by their first card's row id.
    /// Settled exception cards directly above an open one fold into one row on a phone (board
    /// owner-card-ios-text, D1 = A): `settledFoldRow` draws it in the first one's place.
    private var foldedRows: (rows: [TranscriptRow], folds: [String: SettledExceptionFold.Run]) {
        let built = builtRows
        #if os(iOS)
        let runs = SettledExceptionFold.runs(built) { console.settledFoldStanding($0) }
        guard !runs.isEmpty else { return (built, [:]) }
        return (SettledExceptionFold.fold(built, runs: runs, expanded: settledFoldsOpen),
                Dictionary(uniqueKeysWithValues: runs.map { ($0.headID, $0) }))
        #else
        return (built, [:])
        #endif
    }

    private var builtRows: [TranscriptRow] {
        TranscriptRows.build(state: console.state,
                             statusCards: console.localStatusCards,
                             canPageOlder: canPageOlder,
                             showWorkingIndicator: console.showWorkingIndicator,
                             running: console.state.status == .running,
                             decisionCards: console.decisionCards,
                             clocks: console.receiptClocks,
                             conversationCreatedAt: app.session(id: console.sessionID)?.createdAt,
                             recap: recapCard,
                             watchName: watchWakeName,
                             handoffReceived: app.session(id: console.sessionID)?.coordinatorHandoffReceived,
                             createdWorkspace: console.createdWorkspaceLine,
                             chatCards: chatCards?.cards ?? [])
    }

    /// The name a folded watch turn gives its one target (`OrbitExchangeFold.orbitTurn`): the watch's
    /// own record of it first, then the session this client holds — what `WatchWakeCardView` names
    /// it by.
    private func watchWakeName(_ wake: WatchWake, _ target: WatchWakeTarget) -> String? {
        let key = PublicID.storageKey(target.id)
        if let title = app.watches?.watch(wake.watchId)?.targets
            .first(where: { PublicID.storageKey($0.targetResourceId) == key })?.targetTitle,
            !title.isEmpty {
            return title
        }
        return target.kind == .session ? app.session(id: target.id)?.title : nil
    }

    /// What places a folded Orbit turn under its task: which task a session runs, off the session rows
    /// this client holds, and which tasks a task waits on, off the project's dependency graph — read
    /// only once a group is opened (`ConsoleModel.wantExchangeTree`).
    private var exchangeTreeLookup: ExchangeTreeLookup {
        let graph = OrbitExchangeFold.upstream(from: console.exchangeGraph)
        var taskBySession: [String: String] = [:]
        for session in app.sessions {
            if let taskId = session.taskId, !taskId.isEmpty { taskBySession[PublicID.storageKey(session.id)] = taskId }
        }
        let runs = taskBySession
        let title = graph.taskTitle
        return ExchangeTreeLookup(
            taskOfSession: { id in runs[PublicID.storageKey(id)].map { ($0, title($0)) } },
            upstreamOf: graph.upstreamOf,
            taskTitle: graph.taskTitle)
    }

    /// The conversation's last row while it is at rest (`RecapCard`), unless it stepped aside for
    /// this visit or this device hid it. Read off the session the list and the header read, under the
    /// account's Session recaps switch, which governs the list row's recap too.
    private var recapCard: RecapCard? {
        guard recapAsideFor != console.sessionID, let session = app.session(id: console.sessionID) else { return nil }
        let hidden = hiddenRecaps[console.sessionID]
            ?? UserDefaults.standard.string(forKey: RecapCard.hiddenDefaultsKey(session: console.sessionID))
        return RecapCard.make(for: session, recaps: app.user?.preferences?.showRecaps ?? true, hidden: hidden)
    }

    /// The card's ×: this recap, in this conversation, on this device. The list row keeps it.
    private func hideRecap() {
        guard let session = app.session(id: console.sessionID),
              let text = session.recapText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
        else { return }
        let key = RecapCard.hideKey(recapAt: session.recapAt, text: text)
        UserDefaults.standard.set(key, forKey: RecapCard.hiddenDefaultsKey(session: console.sessionID))
        hiddenRecaps[console.sessionID] = key
    }

    /// Whether this conversation is at rest for its card right now (`RecapCard.rests`); a session
    /// not loaded yet counts as at rest, so nothing steps aside before there is a session.
    private var recapRests: Bool {
        app.session(id: console.sessionID).map(RecapCard.rests) ?? true
    }

    /// Only the load-earlier spinner and the tail row differ from the chat-flow insets.
    private func rowInsets(_ row: TranscriptRow) -> EdgeInsets {
        switch row {
        case .loadOlder: return EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)
        case .bottom:    return EdgeInsets()
        case .turnHead:  return EdgeInsets(top: 0, leading: 16, bottom: 4, trailing: 16)
        default:         return EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16)
        }
    }

    /// Where a transfer card's "Show in Drive" goes: the file in its folder on the Mac's Drive page. The phone
    /// has no Drive page, so its card has no such press.
    private var showInDrive: ((String) -> Void)? {
        #if os(macOS)
        guard app.drive?.shown == true else { return nil }
        return { app.revealDocument($0) }
        #else
        return nil
        #endif
    }

    /// The words of a message at the tail that never reached the engine, back in the composer
    /// (`ConsoleModel.putBack`): the row goes, and a receipt is discarded with it.
    private func putBack(_ bubble: UserBubble) -> (() -> Void)? {
        guard SteerDelivery.offersPutBack(bubble) else { return nil }
        return { Task { await console.putBack(bubble) } }
    }

    @ViewBuilder
    private func transcriptRow(_ row: TranscriptRow,
                               folds: [String: SettledExceptionFold.Run] = [:]) -> some View {
        switch row {
        case .createdWorkspace(let line):
            // No `AnchorRow`: what the conversation made is no "Your question".
            CreatedWorkspaceLineView(line: line, console: console)
        case .handoffReceived(let received):
            // The note this coordinator opened with, linking back to the one that wrote it.
            CoordinatorHandoffNoteCardView(
                received: received,
                counts: console.coordinatorHistoryCounts(
                    createdAt: app.session(id: console.sessionID)?.createdAt)) {
                app.route(to: .session(received.handoffFromSessionId))
            }
        case .loadOlder:
            // List laziness keeps this un-materialized — and the fetch un-fired — while the user
            // stays at the tail.
            HStack {
                Spacer()
                ProgressView().controlSize(.small)
                Spacer()
            }
            .onAppear { Task { await console.loadOlder() } }
        case .item(let item):
            TranscriptItemView(item: item, fullPayload: console.fullPayload, console: console,
                               openSession: { app.route(to: .session($0)) })
                .modifier(AnchorRow(itemID: item.id, ruler: ruler, recompute: recomputeStuck))
        case .turnHead(let line):
            // No `AnchorRow`: the head belongs to the message above it, which is the anchor.
            TurnHeadRowView(line: line)
        case .steps(let items):
            // No `AnchorRow`: a steps line is never the "Your question" the sticky header names,
            // so it has no business moving that anchor.
            // Live while the turn is at work (docs/mocks/session-compact-steps: a call in flight sits
            // under the line until it answers; once the turn is over it joins the line). Read off the
            // session row, as Stop and "Working for…" are: the stream status never returns to
            // `.running` — no event says a turn started, and an earlier turn's `turn_end` leaves it
            // `.awaitingInput` — so it folded a second turn's running call into "Ran 2 shell commands".
            StepsRowView(items: items,
                         live: app.session(id: console.sessionID)?.isGenerating ?? (console.state.status == .running),
                         fullPayload: console.fullPayload)
        case .agents(let cards):
            // No `AnchorRow`, for the steps line's reason: a group of Agents is no "Your question".
            AgentGroupView(cards: cards, fullPayload: console.fullPayload)
        case .transfer(let kind, let cards):
            // No `AnchorRow`, for the steps line's reason. Live as the steps line is, off the session row.
            DriveTransferCardView(
                kind: kind, cards: cards,
                live: app.session(id: console.sessionID)?.isGenerating ?? (console.state.status == .running),
                showInDrive: showInDrive)
        case .exchanges(let turns):
            // No `AnchorRow`, for the steps line's reason: a fold over turns Orbit opened is no
            // "Your question". Opened, it draws each turn's rows through this same function.
            OrbitExchangeFoldView(
                exchanges: turns, reveal: console.revealedItemID, lookup: exchangeTreeLookup,
                want: { console.wantExchangeTree(projectID: app.session(id: console.sessionID)?.projectId) },
                render: { AnyView(transcriptRow($0)) })
        case .statusCard(let card):
            SessionStatusCardView(card: card)
        case .decisionCard(let card):
            // No `AnchorRow`: a question about the project's ruler isn't a "Your question" the
            // sticky header names. Unlike an approval it stops no turn, so later messages render
            // BELOW it — which is why the bar at the top of this console points down at it.
            #if os(iOS)
            if let run = folds[card.id] {
                settledFoldRow(run, card: card).orbitCardWidth()
            } else {
                DeliveredDecisionCardView(console: console, card: card).orbitCardWidth()
            }
            #else
            DeliveredDecisionCardView(console: console, card: card).orbitCardWidth()
            #endif
        case .approval(let approval):
            // No `AnchorRow`: an approval isn't a "Your question" the sticky header names.
            ApprovalCard(console: console, approval: approval).orbitCardWidth()
        case .chatCard(let card):
            // No `AnchorRow`: drawn by the page whose chat hangs it here.
            if let chatCards { chatCards.render(card.id).orbitCardWidth() }
        case .recap(let card):
            // No `AnchorRow`: the recap sums the conversation up; it asks nothing.
            RecapCardView(card: card, onHide: hideRecap)
        case .working:
            WorkingIndicatorView()
        case .queued(let bubble):
            // No `AnchorRow` — a queued turn hasn't been asked yet, so it's never the sticky
            // "Your question" (web's `:not(.chat-queued)`).
            //
            // Drawn by the row the transcript draws the same turn with once a runner takes it, so a
            // turn that is a card is that card from the moment it is queued — off the cards the
            // projection carried (`QueuedTurnInfo.cards`), never out of its words — and keeps its
            // shape when it lands; the queue adds only its own controls. A steer the server still
            // holds is taken back by its own Withdraw instead, as it is once a runner has it.
            UserTurnRow(bubble: bubble, queued: QueuedControls(bubble: bubble) {
                Task { await console.cancelQueued(bubble) }
            }, steer: SteerControls(bubble: bubble, withdrawing: console.withdrawingSteers) {
                Task { await console.withdrawSteer(bubble) }
            }, putBack: putBack(bubble),
               revealItemCard: { console.revealOpenItemCard($0) })
            .environment(\.runnerUpdatingQueued, runnerUpdatingQueued(bubble))
        case .bottom:
            // Both shapes end in the room the list's fade lies over (`fadesIntoComposerBand`), so a list
            // at its tail has nothing in the fade. In the row's content, not its insets: every follow and
            // jump lands on this row (`bottomID`), and room held in its insets would stay below the fold.
            if console.detached {
                // A window opened at a record ends at a gap: reaching its bottom pulls in the newer page.
                HStack {
                    Spacer()
                    ProgressView().controlSize(.small)
                    Spacer()
                }
                .padding(.vertical, 8)
                .padding(.bottom, .composerBandFade)
                .accessibilityLabel(SessionRecordLink.Copy.loadingNewer)
                .onAppear { Task { await console.loadNewer() } }
            } else {
                Color.clear.frame(height: CGFloat.composerBandFade + 1)
            }
        }
    }

    #if os(iOS)
    /// "✓ 2 sent back to the coordinator · Show": the settled exception cards above an open one, in
    /// one row that opens in place (board owner-card-ios-text, D1 = A). Opened, the first card is
    /// drawn under it here and the others in their own rows.
    @ViewBuilder private func settledFoldRow(_ run: SettledExceptionFold.Run,
                                             card: DeliveredDecisionCard) -> some View {
        let open = settledFoldsOpen.contains(run.headID)
        VStack(alignment: .leading, spacing: 8) {
            Button {
                PlatformHaptics.tap()
                withAnimation(.smooth(duration: 0.25)) {
                    if open { settledFoldsOpen.remove(run.headID) } else { settledFoldsOpen.insert(run.headID) }
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("✓ \(run.line)")
                        .font(.subheadline).foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(open ? SettledExceptionFold.hide : SettledExceptionFold.show)
                        .font(.subheadline).foregroundStyle(.tint)
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Color.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.22)) }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settled-fold")
            if open {
                DeliveredDecisionCardView(console: console, card: card)
            }
        }
    }
    #endif

    /// Carry a scroll into the next update rather than making it from here (see `heldScroll`). A new
    /// tick each time, so asking twice for the same row scrolls twice.
    private func holdScroll(to rowID: String, anchor: UnitPoint, opensReview: Bool = false, animated: Bool = true, putsBack: Bool = false) {
        heldScroll = HeldScroll(rowID: rowID, anchor: anchor, tick: (heldScroll?.tick ?? 0) &+ 1,
                                sessionID: console.sessionID, opensReview: opensReview, animated: animated,
                                putsBack: putsBack)
    }

    /// The bar opens the same review as tapping a preview. Inline cards remain scroll-only.
    private func openReview(for row: TranscriptRow) {
        guard case .decisionCard(let card) = row else { return }
        switch card.kind {
        case .promotionApproval(let promotionID):
            openPromotionReview(promotionID)
        case .criteriaDecision, .acceptanceConfirmation, .startProject, .criteriaChange,
             .ownerConfirmation, .coordinatorQuestion, .crossingBatch, .projectDone:
            openApprovalReview(.delivered(card))
        default:
            break
        }
    }

    // Sticky header that names the turn above the fold and scrolls back to it — web's
    // `.chat-sticky-question` (muted `StickySummary.yourQuestion` + the question on one ellipsized line):
    // a band under the toolbar on macOS, a capsule in the nav bar on iOS (see `chrome`).
    // `anchor: .top` lands the bubble just under either (the band is a safe-area inset, so the
    // scroll region starts below it).
    private func stickyQuestion(_ bubble: UserBubble, proxy: ScrollViewProxy) -> some View {
        // Only the person's question reaches here: over a round Orbit opened the bar is hidden
        // (`StickySummary.isOrbits`), and a wake is no turn (`isAnchor`). A translated turn shows the
        // words the person wrote, not the English the agent got (Settings › Translation).
        let shown = SessionTranslation.shownUserText(bubble.text, bubble.translation, flipped: false)
        // `CoastingButton` (not a plain `Button`) so the tap fires even while the List is still coasting.
        return CoastingButton {
            landing = nil   // the reader's own jump: a row held in place lets go
            #if os(iOS)
            // The person moving the transcript themselves, said outright rather than inferred: this
            // client decides "a reader did that" from the platform's own drag reports, and an
            // animated jump to a row is not one — without this line the next publish would drag them
            // back to the tail.
            atBottom = false
            // Same coast fix as the jump-to-latest disc: cancel the momentum so `proxy.scrollTo` isn't
            // swallowed by the deceleration, then scroll to the question row on the next runloop.
            transcriptScroll.halt()
            DispatchQueue.main.async { holdScroll(to: bubble.id, anchor: .top) }
            #else
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bubble.id, anchor: .top) }
            #endif
        } label: { _ in
            #if os(iOS)
            questionCapsule(shown)
            #else
            HStack(spacing: 8) {
                // Priority, not `fixedSize()`: the label is served first, so the line beside it is
                // what gives way.
                Text(StickySummary.yourQuestion)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail).layoutPriority(1)
                Text(shown)
                    .font(.orbitSubtext).foregroundStyle(.primary)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            // Wrap the rule in a stack so it draws as a horizontal bottom hairline: a bare `Divider()`
            // in an overlay has no stack axis and instead renders as a vertical line down the row's center.
            .overlay(alignment: .bottom) { VStack(spacing: 0) { Divider() } }
            .contentShape(Rectangle())
            #endif
        }
        .accessibilityLabel("Jump to your last question")
        .help("Jump to your last question")
    }

    #if os(iOS)
    /// The sticky question in the nav bar: the turn's words in a capsule between back and the ⋯ menu,
    /// their height and their glass. The line is the band's and gives way the same way, labelled by
    /// the arrow alone: the capsule has no room to say whose words they are, and needs none.
    @ViewBuilder private func principalQuestion(_ proxy: ScrollViewProxy) -> some View {
        if #available(iOS 18, macOS 15, *), !hidesStickyQuestion, !atBottom || console.detached,
           let q = stuckBubble {
            stickyQuestion(q, proxy: proxy)
                .frame(idealWidth: questionWidth, maxWidth: questionWidth)
        }
    }

    /// What waits in this conversation, in the nav bar's capsule: the needs-you mark in amber, the
    /// bar's own words ("1 waiting below", "1 open question above") and the way the card lies, drawn
    /// as the "Changes committed" toast pill is (`ToastPill`): its surface (`toastGlass`), a bare
    /// filled glyph, no ring, hugging its words. A press scrolls to the card, as the bar's did.
    private func waitingCapsule(_ here: WaitingBelow) -> some View {
        CoastingButton {
            PlatformHaptics.tap()
            atBottom = false
            transcriptScroll.halt()
            console.requestScroll(to: here.rowID)
        } label: { _ in
            HStack(spacing: 8) {
                Image(systemName: here.glyph.symbol)
                    .font(.title3)
                    .foregroundStyle(.orange)
                Text(here.text)
                    .font(.orbitSubtext.weight(.semibold)).foregroundStyle(.primary)
                    .lineLimit(1).truncationMode(.tail)
                Image(systemName: here.side == .above ? "chevron.up" : "chevron.down")
                    .font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.leading, 10)
            .padding(.trailing, 16)
            // The nav bar's height (questionGlass's), on the toast's own surface.
            .frame(height: Self.waitingCapsuleHeight)
            .toastGlass(Capsule(), tint: nil)
            .contentShape(Capsule())
        }
        .accessibilityLabel(here.text)
        .accessibilityHint("Shows what is waiting in this conversation")
    }

    private static var waitingCapsuleHeight: CGFloat {
        if #available(iOS 26.0, *) { return 44 } else { return 32 }
    }

    /// "Handing over" in the nav bar's capsule while the handoff locks the composer (board 04): the
    /// web and Mac headers' word, in the question capsule's glass. Nothing to press — the row in the
    /// transcript carries the handoff's actions and its clock.
    private var handingOverCapsule: some View {
        Text(CoordinatorHandoffCopy.badgeHandingOver)
            .font(.orbitSubtext.weight(.medium)).foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.tail)
            .padding(.horizontal, 14)
            .questionGlass()
            .accessibilityIdentifier("handing-over-capsule")
    }

    private func questionCapsule(_ text: String) -> some View {
        HStack(spacing: 6) {
            Text(StickySummary.arrow.trimmingCharacters(in: .whitespaces))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail).layoutPriority(1)
            Text(text)
                .font(.orbitSubtext).foregroundStyle(.primary)
                .lineLimit(1).truncationMode(.tail)
        }
        .padding(.horizontal, 14)
        .questionGlass()
        .contentShape(Capsule())
    }
    #endif

    // Circular "scroll to latest" control (ChatGPT parity). Wrapped in `CoastingButton` so the tap lands
    // even while the List is still coasting, and so a press springs the disc ~1.2× larger (ChatGPT's
    // feel — the shadow deepens with it). The disc rests at 40pt inside a 44pt hit target
    // (near-filling it, with a hair of margin); it sits 6 above the list's fade, so it floats just above
    // the composer.
    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        CoastingButton {
            jumpToLatest(proxy)
        } label: { pressed in
            Image(systemName: "arrow.down")
                // A 15pt arrow, close in weight to web's `ArrowDownOutlined`. Fixed size (like
                // `orbitHeroGlyph`): a control mark, not body text, so it shouldn't ride Dynamic Type.
                .font(.orbitControlGlyph)
                // Full contrast, not the old muted grey: the reference glyph is a crisp near-black
                // mark, and `.secondary`-on-glass washed out against the transcript behind it.
                .foregroundStyle(.primary)
                .frame(width: 40, height: 40)
                // A solid puck, not glass, and borderless: the backdrop blur let transcript text ghost
                // through the disc and dropped its contrast to near-nothing on a light transcript,
                // where the reference is an opaque surface whose edge is drawn by the shadow alone.
                // `floatingDiscSurface` is white here and a *raised* grey in dark mode — reusing the
                // transcript's own near-black there would make the disc vanish into the backdrop.
                .background { Circle().fill(Color.floatingDiscSurface) }
                .overlay { Circle().fill(.primary.opacity(pressed ? 0.07 : 0)) }
                // Wider and slightly deeper than before, since the shadow is now the only thing
                // lifting an opaque white disc off an off-white transcript.
                .shadow(color: .black.opacity(pressed ? 0.20 : 0.14), radius: pressed ? 10 : 7, y: pressed ? 3 : 2)
                .scaleEffect(pressed ? 1.2 : 1)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .animation(.spring(response: 0.28, dampingFraction: 0.6), value: pressed)
        }
        // 6 above the room the tail row keeps under the list, which ends at the composer.
        .padding(.bottom, CGFloat.composerBandFade + 6)
        .accessibilityLabel(console.detached ? SessionRecordLink.Copy.jumpToLatest : "Scroll to latest")
        .help(console.detached ? SessionRecordLink.Copy.jumpToLatest : "Scroll to latest")
    }

    /// The jump to the latest: the floating disc's.
    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        landing = nil   // the reader asked for the latest: a row held in place lets go
        // A window opened at a record ends at a gap: the latest message is past it, so reaching it
        // re-seeds the window from the tail (`jumpToLatest`), after which the follow pins the bottom.
        if console.detached {
            atBottom = true
            Task { await console.jumpToLatest() }
            return
        }
        #if os(iOS)
        // Two steps, because neither alone reaches the true bottom while coasting: (1) cancel the
        // momentum in place via UIKit — otherwise `proxy.scrollTo` is swallowed by the deceleration —
        // then (2) on the next runloop scroll to the real bottom *row*. Target `bottomID`, not a
        // computed offset: a lazy List's `contentSize` is only an estimate, so an offset undershoots
        // the end (it scrolled, but stopped short of the bottom).
        transcriptScroll.halt()
        DispatchQueue.main.async { holdScroll(to: bottomID, anchor: .bottom) }
        #else
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
        #endif
        atBottom = true
    }

    #if os(macOS)
    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle().fill(console.connected ? .green : .orange).frame(width: 7, height: 7)
            headerStatusLine
                .font(.caption)
            if let session = app.session(id: console.sessionID) {
                SessionCoordinatorBadge(session: session)
            }
            Spacer()
            if !console.state.pendingApprovals.isEmpty {
                Label("\(console.state.pendingApprovals.count) pending", systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            // No count of background processes here: the Background processes tray above the
            // composer already says how many, and it is the one that opens them.
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
        .background(.bar)
        // The band is a shade off the transcript's white; the hairline is what says where it ends.
        // Wrapped in a stack so the bare `Divider()` draws horizontally (see `stickyQuestion`).
        .overlay(alignment: .bottom) { VStack(spacing: 0) { Divider() } }
    }

    /// "run state · lifecycle · when", the run state leading in the colour the session's status
    /// glyph has in the list (amber when it needs a decision, red when it failed, …) and semibold,
    /// so the one word that says what to do next is not the same faint grey as the timestamp.
    private var headerStatus: Text {
        let watching = app.watches?.summary(for: console.sessionID)
        let now = Date()
        // The machine by name: a session held for the Claude region says Anthropic is unavailable there.
        guard let session = app.session(id: console.sessionID),
              let subtitle = SessionHeader.subtitle(for: session, watching: watching, now: now,
                                                    machine: console.runnerName) else {
            // A status word this build does not know reads as the neutral ended wording.
            let status = console.state.status
            return Text(status == .unknown ? "Ended"
                        : status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                .foregroundColor(.secondary)
        }
        let word = SessionHeader.headerWord(for: session, watching: watching, now: now, machine: console.runnerName)
        guard subtitle.hasPrefix(word) else { return Text(subtitle).foregroundColor(.secondary) }
        let tone = SessionStatusGlyph.make(for: session, watching: watching, now: now, machine: console.runnerName).tone
        return Text(word).fontWeight(.semibold).foregroundColor(Self.statusWordColor(tone))
            + Text(subtitle.dropFirst(word.count)).foregroundColor(.secondary)
    }

    /// With the session facts: the state word from `phase`, its marks, then "lifecycle · when"
    /// (`SessionDisplay`). From an older server, `headerStatus` as it always was.
    @ViewBuilder private var headerStatusLine: some View {
        let watching = app.watches?.summary(for: console.sessionID)
        let now = Date()
        if let session = app.session(id: console.sessionID),
           let state = SessionDisplay.state(session.displayFacts),
           let subtitle = SessionHeader.subtitle(for: session, watching: watching, now: now,
                                                 machine: console.runnerName) {
            SessionHeaderStateLine(session: session, state: state, subtitle: subtitle,
                                   word: SessionHeader.headerWord(for: session, watching: watching, now: now,
                                                                  machine: console.runnerName))
        } else {
            headerStatus
        }
    }

    private static func statusWordColor(_ tone: SessionStatusGlyph.Tone) -> Color {
        switch tone {
        case .brand:   return .blue
        case .success: return .green
        case .warning: return .orange
        case .error:   return .red
        case .neutral: return .primary
        }
    }
    #endif
}

#if os(macOS)
/// The status bar's line with the session facts: the state word from `phase` (blue while Running), its marks, then
/// "lifecycle · when" (`SessionDisplay`).
struct SessionHeaderStateLine: View {
    let session: Session
    let state: SessionDisplayState
    let subtitle: String
    let word: String

    var body: some View {
        HStack(spacing: 4) {
            Text(word).fontWeight(.semibold)
                .foregroundColor(word == state.word && state == .running ? .blue : .primary)
            SessionMarkPills(marks: SessionDisplay.marks(session.displayFacts) ?? [])
            Text(subtitle.hasPrefix(word) ? String(subtitle.dropFirst(word.count)) : subtitle)
                .foregroundColor(.secondary)
        }
    }
}
#endif

private extension View {
    /// No iOS 26 scroll-edge effect at the top: the transcript runs on up behind the nav bar as it
    /// is, capsule or not. The hard style (a frosted strip and a hairline, which the phone chose on
    /// its own with the question's capsule in the bar) was ruled out by the owner on 2026-10-16, and
    /// the soft style's blur-to-clear gradient on 2026-11-11.
    @ViewBuilder func noTopEdgeEffect() -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) { scrollEdgeEffectHidden(true, for: .top) } else { self }
        #else
        self
        #endif
    }

    /// How the transcript meets the composer band: it ends at the band and fades into it — except
    /// where the band floats over it (iOS 26, `ConsoleView.transcriptAndBand`), and the list runs on
    /// under the band, where the system's scroll-edge effect is the fade.
    @ViewBuilder func meetsComposerBand() -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) { self } else { fadesIntoComposerBand() }
        #else
        fadesIntoComposerBand()
        #endif
    }
}

#if os(iOS)
private extension View {
    /// The top of a conversation, under the nav bar: on iOS 26 a safe-area BAR, so the transcript
    /// runs on under it as under the composer band below (the owner, 2026-10-16). Since 2026-11-15
    /// (07-console-one-capsule) it holds only the backdrop that stands in for the nav bar while a
    /// phone's composer types; the needs-you bar no longer stands here.
    @ViewBuilder func needsYouTop<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26.0, *) {
            let content = bar()
            safeAreaBar(edge: .top, spacing: 0) { content.environment(\.floatsOverTranscript, true) }
        } else {
            safeAreaInset(edge: .top, spacing: 0, content: bar)
        }
    }

    /// The sticky question's capsule: iOS 26's Liquid Glass at the height of the back and ⋯ buttons
    /// beside it. Earlier systems draw those as bare glyphs in a 44-point bar, so there it is a
    /// smaller capsule of system fill, as a search field is.
    @ViewBuilder func questionGlass() -> some View {
        if #available(iOS 26.0, *) {
            frame(height: 44).glassEffect(.regular.interactive(), in: .capsule)
        } else {
            frame(height: 32).background(Color(uiColor: .tertiarySystemFill), in: Capsule())
        }
    }
}
#endif

/// A tap target that still fires while the enclosing `List` is coasting (momentum scroll) — the whole
/// reason these controls aren't plain `Button`s. On iOS the scroll view's stop-on-tap arbitration eats
/// that first touch, so a SwiftUI `Button`/`onTapGesture`/`DragGesture` does nothing until the list
/// settles (what "滚动中点击无效" was). The iOS interactive layer is instead a raw UIKit
/// `UILongPressGestureRecognizer` (min duration 0) that recognizes *simultaneously* with the scroll and
/// owns its own touch, so it fires on that first tap mid-coast; `minimumPressDuration: 0` also gives an
/// instant press signal. macOS has no such arbitration, so a plain drag gesture suffices there.
///
/// The `label` closure is handed the live `pressed` state to drive press feedback (e.g. the disc's
/// magnify). A swipe that merely begins on the control is treated as a scroll, not a tap — a
/// small-movement check on iOS, near-zero drag translation on macOS. Trade-off: because the iOS layer
/// owns the touch, a drag that *starts* on the control won't scroll the List (a dead-zone the size of
/// the control) — fine for the small disc and the thin sticky bar.
private struct CoastingButton<Label: View>: View {
    private let action: () -> Void
    private let label: (Bool) -> Label
    @State private var pressed = false

    init(action: @escaping () -> Void, @ViewBuilder label: @escaping (Bool) -> Label) {
        self.action = action
        self.label = label
    }

    var body: some View {
        interactive
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { action() }
    }

    @ViewBuilder private var interactive: some View {
        #if os(iOS)
        label(pressed).overlay { CoastingTapCatcher(pressed: $pressed, action: action) }
        #else
        label(pressed)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !pressed { pressed = true } }
                    .onEnded { value in
                        pressed = false
                        if abs(value.translation.width) < 12, abs(value.translation.height) < 12 { action() }
                    }
            )
        #endif
    }
}

/// Structured inline rendering for the app-handled `/status` command. Shared by live transcripts
/// and the New Session draft so both platforms use one compact, wrapping layout.
struct SessionStatusCardView: View {
    let card: LocalStatusCard

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "info.circle.fill")
                    .font(.orbitGlyph)
                    .foregroundStyle(.blue)
                Text("Status")
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                ForEach(Array(card.rows.enumerated()), id: \.offset) { _, row in
                    GridRow(alignment: .firstTextBaseline) {
                        Text(row.label)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 82, alignment: .leading)
                        Text(row.value)
                            .font(.orbitLabel)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .frame(maxWidth: ConversationCardWidth.max, alignment: .leading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color.primary.opacity(0.14))
        }
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.blue).frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Session status")
    }
}

/// A transcript scroll waiting for the next update to make it (`TranscriptView.heldScroll`).
private struct HeldScroll: Equatable {
    let rowID: String
    let anchor: UnitPoint
    let tick: Int
    let sessionID: String
    let opensReview: Bool
    /// Glide to the row or land on it at once. A tap gets the glide; a re-pin for a viewport that is
    /// still moving does not — an animated scroll is aimed at the layout of the frame it starts in,
    /// and a composer growing under it left the tail a line short of the bottom.
    var animated = true
    /// The put-back of a row held in place (`TranscriptView.landing`), whose effect on the offset
    /// decides whether the hold's quiet wait starts again.
    var putsBack = false
}

#if os(iOS)
/// The iOS interactive layer for `CoastingButton`: a transparent UIKit view whose
/// `UILongPressGestureRecognizer` (min duration 0) recognizes alongside the List's scroll and owns the
/// touch, so a tap registers even mid-coast. Recognizer wiring mirrors `KeyboardDismissInstaller`.
private struct CoastingTapCatcher: UIViewRepresentable {
    @Binding var pressed: Bool
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(pressed: $pressed, action: action) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let press = UILongPressGestureRecognizer(
            target: context.coordinator, action: #selector(Coordinator.handle(_:)))
        press.minimumPressDuration = 0
        press.delegate = context.coordinator
        press.cancelsTouchesInView = false
        view.addGestureRecognizer(press)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.pressed = $pressed
        context.coordinator.action = action
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var pressed: Binding<Bool>
        var action: () -> Void
        private var start: CGPoint?

        init(pressed: Binding<Bool>, action: @escaping () -> Void) {
            self.pressed = pressed
            self.action = action
        }

        @objc func handle(_ gesture: UILongPressGestureRecognizer) {
            switch gesture.state {
            case .began:
                start = gesture.location(in: gesture.view)
                pressed.wrappedValue = true
            case .changed:
                if !isTap(gesture) { pressed.wrappedValue = false }
            // Fire on ANY terminal state, not just .ended. While the List is coasting the scroll view
            // grabs the touch to halt deceleration and CANCELS this recognizer (.began → .cancelled)
            // before the finger lifts — so a mid-coast tap never reached .ended and was silently lost
            // (the touch DID arrive: the press-magnify fired). Treat a stationary cancelled/failed press
            // as the tap too; a real drag that began here moved past isTap's threshold and is filtered.
            case .ended, .cancelled, .failed:
                let tap = isTap(gesture)
                pressed.wrappedValue = false
                if tap { action() }
            default:
                break
            }
        }

        // A tap = the finger never wandered far from where it landed; a longer drag is a scroll that
        // merely began on the control, so it must not fire the action.
        private func isTap(_ gesture: UILongPressGestureRecognizer) -> Bool {
            guard let start else { return true }
            let p = gesture.location(in: gesture.view)
            return abs(p.x - start.x) <= 12 && abs(p.y - start.y) <= 12
        }

        // Recognize alongside the List's scroll — never block it (mirrors KeyboardDismissInstaller).
        func gestureRecognizer(_ gesture: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

/// Holds the transcript List's `UIScrollView`, located by `ScrollTouchConfigurator`. The jump-to-latest
/// action uses it to cancel the list's deceleration so the follow-up `proxy.scrollTo(bottomID)` — which
/// the momentum would otherwise swallow — actually reaches the bottom row.
final class TranscriptScroll {
    weak var view: UIScrollView?

    /// Cancel any in-flight deceleration (the coast) in place, so a follow-up `proxy.scrollTo` lands
    /// instead of being swallowed by the momentum. No-op until the scroll view is located.
    func halt() {
        guard let v = view else { return }
        v.setContentOffset(v.contentOffset, animated: false)
    }
}

/// Reaches the transcript List's underlying `UIScrollView` to (1) set `delaysContentTouches = false` so
/// an in-list control registers a tap even while the list is coasting (the default delays and consumes
/// that first touch to halt deceleration), and (2) hand the scroll view to `TranscriptScroll` so the
/// jump-to-latest action can force-scroll to the bottom mid-coast. No public SwiftUI API exposes either,
/// so an inert probe walks the UIKit hierarchy to the scroll view.
private struct ScrollTouchConfigurator: UIViewRepresentable {
    let scroll: TranscriptScroll
    func makeUIView(context: Context) -> ProbeView { ProbeView(scroll: scroll) }
    func updateUIView(_ uiView: ProbeView, context: Context) { uiView.apply() }

    final class ProbeView: UIView {
        let scroll: TranscriptScroll
        init(scroll: TranscriptScroll) {
            self.scroll = scroll
            super.init(frame: .zero)
            isUserInteractionEnabled = false   // inert: only introspects, never intercepts touches
        }
        required init?(coder: NSCoder) { fatalError("not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        func apply() {
            guard let scrollView = findScrollView() else { return }
            scrollView.delaysContentTouches = false
            scroll.view = scrollView
        }

        // Walk up from the probe; at each ancestor also scan its subtree, so the List's scroll view is
        // found whether it sits above this background probe or beside it.
        private func findScrollView() -> UIScrollView? {
            var node: UIView? = superview
            while let current = node {
                if let scrollView = current as? UIScrollView { return scrollView }
                if let scrollView = Self.firstScrollView(in: current) { return scrollView }
                node = current.superview
            }
            return nil
        }

        private static func firstScrollView(in view: UIView) -> UIScrollView? {
            for sub in view.subviews {
                if let scrollView = sub as? UIScrollView { return scrollView }
                if let scrollView = firstScrollView(in: sub) { return scrollView }
            }
            return nil
        }
    }
}
#endif

/// The transcript's viewport changing size — the keyboard rising, the composer growing a line, a
/// phone's chrome folding away. `ScrollTracker` cannot answer this one: `onScrollGeometryChange`
/// reports the scroll view scrolling (and the insets a keyboard moves), and the List's frame
/// changing for any other reason is no sample of it — measured here, the composer growing a line
/// reported nothing at all while the last message slid under it. A pinned transcript follows the
/// resize anyway (see `TailPinning.followsResize`, web's ResizeObserver); the ask crosses to the
/// transcript, which owns the scroll.
private struct ViewportResize: ViewModifier {
    /// The pin as of the last update — the rule's `wasPinned`. A reader away from the tail keeps
    /// their place through a resize, however the viewport moved.
    let atBottom: Bool
    let onResize: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18, macOS 15, *) {
            content.onGeometryChange(for: Double.self) { Double($0.size.height) } action: { was, now in
                if TailPinning.followsResize(wasPinned: atBottom, from: was, to: now) { onResize() }
            }
        } else {
            content
        }
    }
}

/// The single scroll observer: drives the jump-to-latest button's `atBottom` and `tailOutOfView`,
/// carries a pinned transcript back to its tail when the geometry moves the tail out of view
/// (`follow`), AND feeds the sticky header by stashing the live content offset into `ruler` and
/// asking for a recompute each frame.
/// `onScrollGeometryChange` (macOS 15+/iOS 18+) is read-only — unlike `scrollPosition(id:)` +
/// `scrollTargetLayout()` it registers no per-row scroll targets, so it won't re-break `List`
/// virtualization (see the transcript-freeze history). On the earlier floor it's a no-op, leaving
/// `atBottom` true and the header hidden. `atBottom` mirrors web's `measure()`: pin while near the
/// bottom, un-pin only on an *upward* scroll — a downward content-growth delta must never strand the view.
private struct ScrollTracker: ViewModifier {
    @Binding var atBottom: Bool
    /// The gap alone, with the pin's slack — not whether the transcript still follows its tail, which
    /// is `atBottom`'s question. See `TranscriptView.tailOutOfView`.
    @Binding var tailOutOfView: Bool
    let ruler: QuestionRuler
    let recompute: () -> Void
    /// Asks the transcript for its tail (`TranscriptView.repinAfterResize`): the geometry moved it
    /// out of view under a pinned reader — the sticky header pushing the rows down as it arrives,
    /// rows measured taller than they were estimated. See `TailPinning.followsGeometry`.
    let follow: () -> Void
    #if os(iOS)
    /// The List's own `UIScrollView`, for the one fact UIKit knows better than any geometry: whether
    /// a finger is on it. See `readerIsMoving`.
    let scroll: TranscriptScroll
    /// Whether the reader has gone back far enough for a phone's composer band to fold to its bar
    /// (`TailPinning.foldsBand`), decided off the same reading as the pin.
    var readingBack: Binding<Bool> = .constant(false)
    /// A finger put on the list: a band its bar opened folds again.
    var dragged: () -> Void = {}
    #endif
    /// The reader started moving the list themselves — a finger on iOS, the trackpad or wheel on
    /// macOS (`.interacting`; a `scrollTo` the app makes never reports it): a held row lets go
    /// (`TranscriptView.landing`).
    var readerScrolled: () -> Void = {}
    /// Whether a row the transcript was opened at is held in place (`TranscriptView.landingHolds`),
    /// handed this reading's offset, and the content's height when this reading changed it, so the
    /// row is put back. The tail is not pinned while one is held (web: `measure()` reads
    /// `!landingRef.current`).
    var landingHolds: (_ offset: Double, _ resizedTo: Double?) -> Bool = { _, _ in false }
    /// Whether the reader is the one moving the list: a finger on it, or the momentum of one.
    /// `.animating` is SwiftUI moving it (a jump-to-latest, the sticky header) and `.idle` is it
    /// sitting still while content is re-laid-out underneath — neither is a reader. `TailPinning`
    /// needs the difference to tell a drag up from the clamp a row that shrank forces.
    @State private var readerDriven = false
    /// Whether the platform reports anything moving the list, SwiftUI's own animated scrolls included
    /// where it reports them (a List's animated `scrollTo` read `idle` throughout on iOS 26): the
    /// geometry is followed only under a list at rest. See `TailPinning.followsGeometry`.
    @State private var scrolling = false

    /// What the platform can say about that — see `TailPinning.ReaderEvidence`. iOS reports drags,
    /// measured with a synthesized one on the simulator: `interacting` for the finger and
    /// `decelerating` for its coast, each with the offset following it. macOS keeps the geometry
    /// rule, where a fall over content that did not resize is the only evidence of a reader there
    /// is.
    #if os(iOS)
    private static let evidence = TailPinning.ReaderEvidence.reported
    #else
    private static let evidence = TailPinning.ReaderEvidence.inferred
    #endif

    /// The reader's own movement, from the phase plus — on iOS — UIKit's unambiguous "a finger is
    /// down", so a drag is never missed because SwiftUI happened to be animating something else.
    private var readerIsMoving: Bool {
        if readerDriven { return true }
        #if os(iOS)
        guard let v = scroll.view else { return false }
        return v.isTracking || v.isDragging
        #else
        return false
        #endif
    }

    func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content
                .onScrollPhaseChange { _, phase in
                    readerDriven = phase != .idle && phase != .animating
                    scrolling = phase != .idle
                    if phase == .interacting { readerScrolled() }
                    #if os(iOS)
                    if phase == .interacting { dragged() }
                    #endif
                }
                .onScrollGeometryChange(for: TailScrollSample.self) { geo in
                    // The gap is to the bottom of what the reader can see, net of the content's
                    // bottom inset: where the composer band floats over the list (iOS 26) the list
                    // runs on under it, and counting that strip as "in view" would pin a reader who
                    // had scrolled up by less than the band is tall. The inset itself is read too:
                    // the keyboard and a growing composer lift it, and the follow has to hear that
                    // (`TailPinning.followsGeometry`). Zero where the list ends at its band.
                    TailScrollSample(offset: Double(geo.contentOffset.y),
                                     contentHeight: Double(geo.contentSize.height),
                                     bottomGap: Double(geo.contentSize.height + geo.contentInsets.bottom
                                                       - geo.visibleRect.maxY),
                                     topInset: Double(geo.contentInsets.top),
                                     bottomInset: Double(geo.contentInsets.bottom))
                } action: { was, now in
                    let held = landingHolds(now.offset, now.contentHeight != was.contentHeight ? now.contentHeight : nil)
                    let pinned = !held && TailPinning.pinned(wasPinned: atBottom, from: was, to: now,
                                                             readerDriven: readerIsMoving,
                                                             evidence: Self.evidence)
                    atBottom = pinned
                    tailOutOfView = now.bottomGap > TailPinning.nearBottom
                    #if os(iOS)
                    // What the folded band keeps over the list: its pill and its foot, which is off the
                    // screen's own edge (`ConsoleView.composerBand`).
                    let foldedInset = CGFloat.foldedBandPill + .foldedBandPillFoot
                    let back = TailPinning.foldsBand(pinned: pinned, sample: now, foldedInset: Double(foldedInset))
                    if readingBack.wrappedValue != back { readingBack.wrappedValue = back }
                    #endif
                    ruler.contentOffset = CGFloat(now.offset)
                    recompute()
                    if TailPinning.followsGeometry(pinned: pinned, from: was, to: now,
                                                   moving: scrolling || readerIsMoving) {
                        follow()
                    }
                }
        } else {
            content
        }
    }
}

/// Publishes the id of the item currently under the transcript's top edge (`ruler.topAnchorID`). Every
/// row carries this — the anchor can be any kind of turn — and the one whose frame straddles the viewport
/// top claims it. Because that row is by definition on screen, the anchor is always read from live
/// geometry and never has to survive recycling; the header then derives the last question above it purely
/// from the message list (see `recomputeStuck`). `.global` (not the List-ambiguous `.scrollView`) gives
/// an unambiguous screen frame, compared against the viewport top the parent captures. Passive
/// `onGeometryChange` observers, not the per-row scroll-target tracking that froze the List — and the
/// action fires only on the rare frame a row crosses the top line, not every frame. iOS 18+/macOS 15+.
private struct AnchorRow: ViewModifier {
    let itemID: String
    let ruler: QuestionRuler
    let recompute: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18, macOS 15, *) {
            content.onGeometryChange(for: Bool.self) { proxy in
                let f = proxy.frame(in: .global)
                return f.minY <= ruler.viewportTop && ruler.viewportTop < f.maxY
            } action: { straddlesTop in
                if straddlesTop, ruler.topAnchorID != itemID { ruler.topAnchorID = itemID; recompute() }
            }
        } else {
            content
        }
    }
}

/// Backing store for the sticky header (see `TranscriptView.recomputeStuck`). A plain reference type,
/// held in `@State`: the rows and the scroll tracker mutate it every frame without invalidating the
/// view; only the recomputed `stuckID` drives redraws.
final class QuestionRuler {
    var viewportTop: CGFloat = 0      // transcript viewport's top edge, in global space
    var contentOffset: CGFloat = 0    // scroll offset (from onScrollGeometryChange) — only for the initial fallback
    var topAnchorID: String?          // id of the item straddling the viewport top — the header's sole scroll input
    // The questions of one console's published state, rebuilt only when that state moves.
    private var questionsCache: (console: ObjectIdentifier, revision: Int, questions: StickyQuestions)?

    func reset() { topAnchorID = nil; contentOffset = 0 }

    @MainActor
    func questions(_ console: ConsoleModel, read: (ConsoleModel) -> StickyQuestions) -> StickyQuestions {
        let key = ObjectIdentifier(console)
        if let cached = questionsCache, cached.console == key, cached.revision == console.stateRevision {
            return cached.questions
        }
        let questions = read(console)
        questionsCache = (key, console.stateRevision, questions)
        return questions
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem
    /// Refetch for a tool card the server clipped to a preview (ConsoleModel.fullPayload).
    var fullPayload: (@MainActor (Int) async -> JSONValue?)? = nil
    /// The owning console, for the rows that can act on the session — the sign-in card signs this
    /// session's runner back in and re-sends the message its failure ate.
    var console: ConsoleModel? = nil
    /// Open another session's conversation, for the row that names the agent fixing a warning. Nil
    /// where there is no router (a preview, a guest page), which leaves the link out.
    var openSession: ((String) -> Void)? = nil
    var body: some View {
        switch item {
        case .user(let b):
            // Which card a user turn is — or the owner's bubble — is decided in one place, for the
            // transcript and the queued tail alike (`UserTurnRow`).
            UserTurnRow(bubble: b, steer: steerControls(b), putBack: putBack(b), revealItemCard: { console?.revealOpenItemCard($0) ?? false })
        case .assistant(let b): AssistantBubbleView(bubble: b)
        case .thinking(let b):  ThinkingView(block: b)
        case .toolCall(let c) where c.name == WorkflowBlock.toolName:
            // An Orbit workflow: its own block, opening to its calls by phase (board subagent-workflow part 4).
            WorkflowBlockView(card: c, fullPayload: fullPayload)
        case .toolCall(let c) where BgJobCard.drawsCard(c):
            // A bg_run call is its job's card from start to end (board A1); one refused, or whose answer
            // names no job, stays a call.
            JobCardView(card: c)
        case .toolCall(let c) where DriveSyncCard.drawsCard(c):
            // A drive_sync call is its sync's card, live after the turn ends (board drive-sync-card); an
            // answer that names no sync, from an older runner, stays a call.
            DriveSyncCardView(syncID: DriveSyncCard.syncID(c.result) ?? "")
        case .toolCall(let c):
            // The owner's "Chat about this" reply to one of Orbit's own cards: their message, drawn as
            // theirs under the call rather than left inside its result (`OwnerChatReply`).
            if let words = OwnerChatReply.words(of: c) {
                VStack(alignment: .leading, spacing: 12) {
                    ToolCardView(card: c, fullPayload: fullPayload)
                    UserBubbleView(bubble: UserBubble(id: "owner-chat-\(c.id)", text: words, pending: false))
                }
            } else {
                ToolCardView(card: c, fullPayload: fullPayload)
            }
        case .interrupt(_, _, let runnerRestart, let runnerUpdate):
            if let runnerUpdate {
                // The owner's Update Now cut it: the web's line, its ⊘ included (D4).
                Text(RunnerPageCopy.runnerUpdateInterruptedLine(version: runnerUpdate.targetVersion))
                    .font(.orbitLabel).foregroundStyle(.secondary)
            } else {
                // Nobody pressed Stop on a turn the runner's restart cut off: the row says what did (web parity).
                Label(runnerRestart ? "Interrupted — the runner restarted" : "Interrupted", systemImage: "stop.circle")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        case .error(_, let message):
            if let console, console.executesDsh, let repair = DshRuntime.repair(message) {
                DshRepairCardView(console: console, repair: repair).orbitCardWidth()
            } else if let repair = EngineAuth.antigravityRepair(message), let console, console.executesAntigravity {
                AntigravityRepairCardView(console: console, repair: repair).orbitCardWidth()
            } else if let summary = ToolFailureSummary.parse(message) {
                ToolFailureCardView(message: message, summary: summary).orbitCardWidth()
            } else {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red).textSelection(.enabled)
            }
        case .authError(let id, let message):
            if let console {
                AuthErrorCardView(console: console, message: message, settled: console.settlement.auth[id]).orbitCardWidth()
            } else {
                // No console to act through (a preview / detached render): the diagnosis alone,
                // which is what the runtime said in the first place.
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange).textSelection(.enabled)
            }
        case .autoRetry(let notice):
            if let console {
                AutoRetryCardView(console: console, notice: notice).orbitCardWidth()
            } else {
                // Same as above: with no session to read the armed retry off, or to retry through,
                // what's left is the runtime's own sentence.
                Label(notice.message, systemImage: "clock.fill")
                    .foregroundStyle(.secondary).textSelection(.enabled)
            }
        case .notice(let id, let message, _):
            // A heads-up, not a failure — web's `.chat-notice`: the warning tone at label size,
            // behind the triangle. An account switch the conversation has moved past is history,
            // muted with the sign-in card it came with.
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.orbitLabel)
                .foregroundStyle(console?.settlement.settledNotices.contains(id) == true ? Color.secondary : Color.orange)
                .textSelection(.enabled)
        case .diagnostic(let notice):
            DiagnosticNoticeRow(notice: notice, console: notice.isSandboxMissing ? console : nil,
                                openSession: openSession)
        case .mainCheckout(let item):
            // The main checkout's card (board 01) or one action's line (board 03). Without a console to
            // act through, the event's own sentence, as the notice it used to be.
            if let console, let changed = item.changed {
                MainCheckoutCardView(console: console, item: item, notice: changed).orbitCardWidth()
            } else if let console, let result = item.result {
                MainCheckoutResultRow(console: console, result: result)
            } else {
                Label(item.notice, systemImage: "exclamationmark.triangle.fill")
                    .font(.orbitLabel).foregroundStyle(.orange).textSelection(.enabled)
            }
        }
    }

    /// A steer the reader typed offers to take it back while nothing has read it, through the
    /// console — which a list drawn without one (a sub-agent's) has none of.
    private func steerControls(_ bubble: UserBubble) -> SteerControls? {
        guard let console else { return nil }
        return SteerControls(bubble: bubble, withdrawing: console.withdrawingSteers) {
            Task { await console.withdrawSteer(bubble) }
        }
    }

    /// The words of a message in the conversation that never reached the engine, back in the
    /// composer (`ConsoleModel.putBack`); the bubble itself stays.
    private func putBack(_ bubble: UserBubble) -> (() -> Void)? {
        guard let console, SteerDelivery.offersPutBack(bubble) else { return nil }
        return { Task { await console.putBack(bubble) } }
    }
}

/// A recoverable runtime diagnostic, drawn as web draws `.chat-notice.chat-diagnostic`: only the mark
/// keeps the warning tone; the label is dim, the engine's words are in the secondary text colour, and
/// the repeats folded into the row are a dimmed count after them. The whole logged line, stamp and
/// module included, is the row's help text, as it is web's tooltip.
struct DiagnosticNoticeRow: View {
    let notice: DiagnosticNotice
    /// The session's console, on the one diagnostic a reader can act on: Codex's missing bubblewrap.
    var console: ConsoleModel? = nil
    /// Open the fixing agent's session; nil where there is no router.
    var openSession: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                if !notice.label.isEmpty {
                    Text(notice.label).font(.orbitMeta).monospacedDigit().foregroundStyle(.tertiary)
                }
                Text(notice.text).foregroundStyle(.secondary).textSelection(.enabled)
                if notice.repeats > 1 {
                    Text("×\(notice.repeats)").font(.orbitMeta).monospacedDigit()
                        .foregroundStyle(Color.orange.opacity(0.7))
                }
            }
            .font(.orbitLabel)
            .help(notice.message)
            if notice.isSandboxMissing, let console {
                SandboxFixActionView(console: console, openSession: openSession)
            }
        }
    }
}

/// Fix with an agent under the transcript's sandbox warning (web parity: Transcript.tsx's
/// `SandboxFixAction`): the button and where its session runs, the agent at work, or the one that
/// already finished with the row — a transcript is history, so a handled row offers no second agent.
struct SandboxFixActionView: View {
    let console: ConsoleModel
    var openSession: ((String) -> Void)? = nil

    var body: some View {
        if let state = RunnerAgentFixLogic.sandboxState(console.runnerAgentFix) {
            VStack(alignment: .leading, spacing: 6) {
                switch state {
                case .ready(let hint):
                    Button(RunnerPageCopy.AGENT_FIX_BUTTON) { Task { await console.fixSandbox() } }
                        .buttonStyle(RunnerCapsuleButtonStyle())
                        .disabled(console.sandboxFixStarting)
                    hintLine(hint)
                case .blocked(let reason):
                    Button(RunnerPageCopy.AGENT_FIX_BUTTON) {}
                        .buttonStyle(RunnerCapsuleButtonStyle())
                        .disabled(true)
                    hintLine(reason)
                case .fixing(let entry):
                    HStack(spacing: 6) {
                        Circle().fill(Color.accentColor).frame(width: 6, height: 6)
                        Text(RunnerPageCopy.agentFixFixing(workspace: entry.workspaceName))
                            .foregroundStyle(.secondary)
                        openLink(entry.sessionId)
                    }
                    .font(.orbitLabel)
                case .handled(let sessionId, let workspaceName):
                    HStack(spacing: 6) {
                        Text(RunnerPageCopy.agentFixFixed(workspace: workspaceName))
                            .foregroundStyle(.secondary)
                        openLink(sessionId)
                    }
                    .font(.orbitLabel)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.02)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.25)))
        }
    }

    @ViewBuilder private func hintLine(_ text: String?) -> some View {
        if let text {
            Text(text).font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private func openLink(_ sessionId: String) -> some View {
        if let openSession {
            Button(RunnerPageCopy.AGENT_FIX_OPEN_SESSION) { openSession(sessionId) }
                .linkButtonStyle()
        }
    }
}

/// What `TranscriptView` watches to decide its Recap card's step-aside: which session it shows, and
/// whether that conversation is at rest for the card.
private struct RecapVisit: Equatable {
    let sessionID: String
    let rests: Bool
}

// The wiki chat's initializer lives beside `TranscriptView`'s private state rather than in
// `WikiChatViews.swift`: a custom init in another file leaves the private `@State` default-value
// expressions unresolved at link time under Xcode 27.0's Swift 6.4 IRGen (the symbol is emitted
// file-private but referenced from the other file).
extension TranscriptView {
    init(wikiChat console: ConsoleModel) {
        self.console = console
        self.hidesStickyQuestion = true
    }
}
