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
    // — both platforms. On iOS it also builds the nav-bar title (session name + "state · when"),
    // mirroring how web's console header reads `selected` off the cached session list; macOS shows
    // that status in the in-transcript `statusBar` instead.
    @Environment(AppModel.self) private var appModel
    /// The public read-only link's sheet — opened from the nav bar on iOS, the window toolbar on macOS.
    @State private var showShare = false
    @State private var promotionReview: PromotionReviewTarget?
    @State private var approvalReview: ApprovalReviewTarget?
    @State private var approvalReviewDrafts = ApprovalReviewDrafts()
    #if os(iOS)
    /// Tapping the nav-bar title renames the session (web double-clicks its header title). Seeded
    /// from the session's own title — not `SessionHeader.title`, whose agent-name fallback would
    /// otherwise be typed in as if it were the name.
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var taggingSession: Session?
    @State private var movingSession: Session?
    @State private var moveListed: [Session] = []
    @State private var confirmPurge = false
    /// Gates the "needs you" banner to the compact shell — see the `safeAreaInset` below.
    @Environment(\.horizontalSizeClass) private var hSize
    /// A phone's stack: the project a coordinator's title opens goes over this console, so the back
    /// swipe returns here (`opensPagesOverConsole`).
    @Environment(\.opensPagesOverConsole) private var opensPagesOverConsole
    #endif

    var body: some View {
        #if os(iOS)
        // A custom `.principal` toolbar item is measured at its ideal width instead of being given
        // the space left between the navigation buttons. Measure the actual detail column here so
        // the title gets a finite proposal on iPhone, after rotation, and in an iPad split view.
        // Reserve 80 points on each side for navigation chrome; 260 keeps it title-like in wide
        // columns instead of turning the navigation bar into another content row.
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

    private func consoleBody(navTitleWidth: CGFloat) -> some View {
        Group {
            if let console = registry.peek(sessionID) {
                VStack(spacing: 0) {
                    TranscriptView(console: console, hidesStickyQuestion: foldsChrome(console),
                                   reviewingCard: approvalReview != nil || promotionReview != nil)
                    // Pending approvals (incl. the AskUserQuestion form) render inline at the tail of
                    // the transcript now — as the agent's latest turn, web-style — not in a fixed panel
                    // here. See TranscriptView.
                    // Error, background tray, git bar, composer — web's order (`workspace-composer`).
                    // Staged attachments are not a member: they sit inside the composer's card, above
                    // the text they go out with. The band owns the gutter and the gaps; members only
                    // say whether they are on screen.
                    ComposerBand {
                        // Errors only, and sticky until the ✕ — this row is in flow, so anything that
                        // comes and goes on a timer here shoves the composer around while the user is
                        // typing in it. Confirmations belong in the toast host (see `showToast`).
                        if let repair = console.queuedDshRepair {
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
                            BackgroundTrayView(procs: console.state.background, progress: console.state.taskProgress)
                            // The tasks this session's agent created, beside the code the bar below
                            // carries — the session's two kinds of output, together.
                            CreatedTasksCard(console: console)
                            WorktreeBar(console: console)
                        }
                        .modifier(TypingFold(folded: foldsChrome(console)))
                        ComposerView(console: console)
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
                // Image cache for user-turn attachments, read by `UserBubbleView` down the tree.
                .environment(registry.attachments)
                // One full-screen viewer for the whole transcript: a thumbnail anywhere in it opens here
                // and pages across every image in the session, in transcript order (web parity).
                .environment(\.sessionImagePreview, sessionImagePreview(console))
                // The workspace's background agents and workflows, for the cards that draw them.
                .environment(\.taskActivity, taskActivity(console))
                .environment(\.openPromotionReview, { promotionID in
                    promotionReview = PromotionReviewTarget(id: promotionID)
                })
                .sheet(item: $promotionReview) { target in
                    PromotionReviewSheet(console: console, promotionID: target.id)
                }
                .environment(approvalReviewDrafts)
                .environment(\.openApprovalReview, { target in
                    approvalReview = target
                })
                .sheet(item: $approvalReview) { target in
                    ApprovalReviewSheet(console: console, target: target)
                        .environment(approvalReviewDrafts)
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
            _ = registry.model(for: sessionID, agentID: agentID)
        }
        .onChange(of: sessionID) { _, _ in
            promotionReview = nil
            approvalReview = nil
            approvalReviewDrafts = ApprovalReviewDrafts()
        }
        #if os(iOS)
        // "Another session needs you", below the nav bar and above the transcript. Compact only:
        // the regular-width split keeps the session list on screen beside this console, and that
        // list carries the bar — showing it in both columns would state one fact twice.
        // …and, when this session is itself holding a question that does NOT stop its turn, the same
        // bar pointing down into this transcript instead of away from it. See `NeedsYouBannerView`.
        // While you type the bar folds away with the nav bar (`foldsChrome`), and a backdrop takes the
        // nav bar's place behind the status bar so the transcript doesn't scroll under the clock.
        .safeAreaInset(edge: .top, spacing: 0) {
            if hSize == .compact {
                let console = registry.peek(sessionID)
                if foldsChrome(console) {
                    Color.clear.frame(height: 0).background(.bar, ignoresSafeAreaEdges: .top)
                } else {
                    NeedsYouBannerView(
                        excluding: sessionID,
                        below: console?.waitingBelow,
                        onOpenBelow: { rowID in console?.requestScroll(to: rowID) })
                }
            }
        }
        // Pushed onto the compact NavigationStack (and shown as the split detail on iPad), this page
        // carries no title, so iOS would reserve a *large* — and empty — title bar: a big blank band
        // at the top, above the transcript. Force the slim inline bar so the transcript starts
        // right under the back button. (The New-session compose page already does this; without it the
        // console reverts to the large bar the moment the session is created — the reported gap.)
        .navigationBarTitleDisplayMode(.inline)
        // …and none at all while a phone's composer holds the keyboard (`foldsChrome`): back, the
        // title and session menu come back when the keyboard goes.
        .toolbar(foldsChrome(registry.peek(sessionID)) ? .hidden : .automatic, for: .navigationBar)
        // Inline title: the session name over a "state · when" subtitle, matching the web Agent
        // console header (`AgentView.tsx`). Centered/two-line — the system convention (Messages/Phone)
        // — rather than web's left-aligned bar. The status word lived in the transcript's `statusBar`
        // band before; on iOS that band is now retired in favour of this.
        .toolbar {
            ToolbarItem(placement: .principal) {
                let session = appModel.session(id: sessionID)
                let title = ConsoleNavTitle(
                    session: session,
                    console: registry.peek(sessionID),
                    availableWidth: navTitleWidth
                )
                // A coordinator conversation's title is its project's — the server keeps the two in
                // step — so its tap opens that project, the way a Messages header opens what the
                // conversation is about; the › beside the badge says so. Every other title is tap to
                // rename, matching web's double-click-the-header-title. A trashed session is not
                // renamable there either, and a row we haven't loaded yet has no title to seed the
                // field with — both fall back to the plain, non-interactive title.
                if let session, let projectID = session.projectId {
                    Button {
                        appModel.openProjectFromConversation(projectID, overConsole: opensPagesOverConsole)
                    } label: {
                        title
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the project this conversation coordinates")
                } else if let session, session.effectiveLifecycleState != .trash {
                    Button {
                        renameDraft = session.title ?? ""
                        renaming = true
                    } label: {
                        title
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Renames this session")
                } else {
                    title
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if let session = appModel.session(id: sessionID) {
                    sessionMenu(session)
                } else {
                    Button {} label: { Image(systemName: "ellipsis") }
                        .disabled(true)
                        .accessibilityLabel("Session actions")
                }
            }
        }
        .sessionRenameAlert(isPresented: $renaming, draft: $renameDraft, sessionID: sessionID)
        .sheet(item: $taggingSession) { session in
            SessionTagSheet(session: session)
                .environment(appModel)
                .task { await appModel.loadSessionTags() }
        }
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
        #else
        // The same link on macOS, from the window toolbar: a detail pane's own actions sit at
        // `.primaryAction` there, as the project and task pages' menus do.
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showShare = true } label: {
                    Label("Share session", systemImage: "square.and.arrow.up")
                }
                .help("Share a read-only link to this session")
            }
        }
        #endif
        .sheet(isPresented: $showShare) {
            if let baseURL = appModel.baseURL {
                ShareSheet(kind: .session, rootID: sessionID, baseURL: baseURL, tokenStore: appModel.tokenStore)
            }
        }
    }

    #if os(iOS)
    private func sessionWorkspace(_ session: Session) -> Agent? {
        appModel.agents?.items.first { $0.id == (session.agent?.id ?? session.agentId) }
    }

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
                    Button {
                        let listed = session.effectiveLifecycleState == .completed
                            ? (appModel.agents?.agentSessions ?? []) : appModel.sessions
                        moveListed = listed.filter {
                            ($0.agent?.id ?? $0.agentId) == (session.agent?.id ?? session.agentId)
                        }
                        movingSession = session
                    } label: {
                        Label("Move…", systemImage: "folder")
                    }
                    .disabled(sessionWorkspace(session) == nil)
                    Button { taggingSession = session } label: {
                        Label("Tags…", systemImage: "tag")
                    }
                }
                if let taskID = session.taskId {
                    Section {
                        Button {
                            appModel.openFromConversation(.task(taskID), overConsole: opensPagesOverConsole)
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

/// The band's cards while a phone's composer holds the keyboard (`foldsChrome`): folded to no
/// height, not removed, so an open list, the branch bar's sheet host and a "View tasks ›" press made
/// meanwhile all keep their state, and the cards come back as they were when the keyboard goes.
/// The wide shells never fold, and macOS doesn't take the modifier at all.
private struct TypingFold: ViewModifier {
    let folded: Bool

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .frame(height: folded ? 0 : nil, alignment: .top)
            .clipped()
            .opacity(folded ? 0 : 1)
            .allowsHitTesting(!folded)
            .accessibilityHidden(folded)
        #else
        content
        #endif
    }
}

#if os(iOS)
/// The pushed console's inline nav-bar title: the session name over a "state · when" subtitle,
/// mirroring the web Agent console header (see OrbitKit `SessionHeader`). The session (with its
/// title + timestamps) comes from the app's cached list; when it isn't loaded yet the title falls
/// back to the live stream's agent name and the subtitle to its current status word.
private struct ConsoleNavTitle: View {
    @Environment(AppModel.self) private var appModel
    let session: Session?
    let console: ConsoleModel?
    /// The navigation bar's centre budget, derived from the current detail-column width. Unlike a
    /// plain `lineLimit`, this gives both text rows a finite proposal they can actually truncate in.
    let availableWidth: CGFloat

    var body: some View {
        VStack(spacing: 1) {
            HStack(spacing: 6) {
                Text(SessionHeader.title(for: session, fallbackAgent: console?.agentName))
                    .font(.headline)
                    .lineLimit(1).truncationMode(.tail)
                if let session {
                    SessionCoordinatorBadge(session: session)
                        .layoutPriority(1)
                    // The tap opens the project (see the title's button in `ConsoleView`).
                    if session.projectId != nil {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .layoutPriority(1)
                            .accessibilityHidden(true)
                    }
                }
            }
            Text(subtitle)
                .font(.caption2).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
        }
        .frame(width: availableWidth)
        // SwiftUI views do not clip to their layout frame by default. Keep a fixed-size badge (or a
        // future title child) from ever painting over the trailing Share button again.
        .clipped()
    }

    private var subtitle: String {
        // Waiting on a watch, the subtitle says so — targets, progress, last look — instead of
        // "Background process running · 3m ago".
        let watching = session.flatMap { appModel.watches?.summary(for: $0.id) }
        if let s = SessionHeader.subtitle(for: session, watching: watching) { return s }
        // No cached session yet (fresh deep link): show the live stream's status, prettified like
        // the old band did (AWAITING_INPUT -> "Awaiting Input").
        if let status = console?.state.status {
            return status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
        }
        return ""
    }
}
#endif

struct TranscriptView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openApprovalReview) private var openApprovalReview
    @Environment(\.openPromotionReview) private var openPromotionReview
    let console: ConsoleModel
    /// The sticky "↑ Your question" header folds away while a phone's composer holds the keyboard,
    /// with the rest of the console's chrome (`ConsoleView.foldsChrome`).
    var hidesStickyQuestion = false
    /// Keep the preview's place while its sheet refreshes or the conversation keeps streaming.
    var reviewingCard = false
    @State private var reviewSessionID: String?
    private let bottomID = TranscriptRow.bottom.id
    // Mirrors web's `atBottom` (AgentView.tsx): flips false once the user scrolls up off the live
    // tail. Drives the floating jump-to-latest button AND gates the auto-follow below, so reading
    // history isn't yanked back down by streaming updates. Maintained by `ScrollTracker` (macOS 15+);
    // on the macOS 14 floor it stays true — the view keeps the unconditional follow and hides the button.
    @State private var atBottom = true
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
                             recompute: recomputeStuck, scroll: transcriptScroll)
        #else
        return ScrollTracker(atBottom: $atBottom, tailOutOfView: $tailOutOfView, ruler: ruler,
                             recompute: recomputeStuck)
        #endif
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
        // macOS shows the session state in this band; iOS carries it in the nav-bar subtitle
        // (`ConsoleNavTitle`) instead, matching the web header, so the band is retired there.
        #if os(macOS)
        .safeAreaInset(edge: .top, spacing: 0) { statusBar }
        #endif
    }

    /// Split out of `body`, and out of each other, because as one expression this chain is long
    /// enough that the iOS type-checker gives up on it — "unable to type-check this expression in
    /// reasonable time; try breaking up the expression into distinct sub-expressions",
    /// ConsoleView.swift:627, which is how v0.1.2-beta.174's iOS archive failed. Each piece declares
    /// `some View`, so the checker works on it alone and one more modifier stays cheap.
    /// The transcript itself: one flat `ForEach` over the pre-assembled rows, with the row-level
    /// preferences that must sit on the outermost row view.
    private var rowsList: some View {
        List {
            ForEach(rows) { row in
                transcriptRow(row)
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
        // The transcript viewport's top edge in global space — the line `AnchorRow` tests each row
        // against to find the one under the top. Stable during a scroll (only shifts on layout, e.g.
        // the keyboard), so reading it here doesn't churn.
        .background {
            GeometryReader { g in
                Color.clear.onChange(of: g.frame(in: .global).minY, initial: true) { _, y in ruler.viewportTop = y }
            }
        }
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
            if atBottom && !console.detached && !reviewingCard {
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
            atBottom = true; stranded = false; ruler.reset(); stuckID = nil
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
            atBottom = true
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
        // A local command is an explicit new tail item, so reveal it even when the reader had
        // scrolled up. This matches a normal local send and web's `pinToBottom()` behavior.
        .onChange(of: console.localStatusCards.count) {
            atBottom = true
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
            #if os(iOS)
            // Same coast fix as the jump-to-latest disc: cancel the momentum first, or the
            // deceleration swallows the scroll.
            transcriptScroll.halt()
            #endif
            DispatchQueue.main.async {
                holdScroll(to: request.rowID, anchor: .center, opensReview: true)
            }
        }
        // A link to one record (`SessionRecordLink`): scroll to its row. The reader is taken off
        // the live tail first, said outright as the sticky header's jump says it — a programmatic
        // jump is no drag the scroll tracker could read, and the next publish would pull them back.
        // `initial: true` because the page can land before this transcript first appears; the
        // console consumes the request once followed, so reappearing does not jump back to it.
        .onChange(of: console.recordRequest, initial: true) { _, request in
            guard let request else { return }
            atBottom = false
            console.recordRequestFollowed(request)
            #if os(iOS)
            transcriptScroll.halt()
            #endif
            DispatchQueue.main.async { holdScroll(to: request.rowID, anchor: .center) }
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
            } else {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(held.rowID, anchor: held.anchor)
                }
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
            if !atBottom || console.detached || stranded {
                scrollToBottomButton(proxy: proxy)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
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
        // hides only at the very top where no question is above. Shown whenever such a question
        // exists — including at the bottom — exactly like web, not gated on `atBottom`. In-flow inset
        // (not an overlay) so it pushes content down like web: a `scrollTo(anchor: .top)` then lands
        // the target just *below* the header, not hidden under it. iOS 18+/macOS 15+ (needs the
        // scroll/row geometry); on the earlier floor `stuckID` never updates, so this stays hidden.
        .safeAreaInset(edge: .top, spacing: 0) {
            if #available(iOS 18, macOS 15, *), !hidesStickyQuestion, let q = stuckBubble {
                stickyQuestion(q, proxy: proxy)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
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
    // so is a background job's news or a wakeup coming due, a line inside an answer rather than the head
    // of one (`StickySummary.isAnchor`; web's line carries no `data-sticky-label`).
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
        if let anchor = ruler.topAnchorID {
            found = questions.above(anchor)
        } else if ruler.contentOffset > 40 {
            found = questions.last
        }
        if found != stuckID { stuckID = found }
    }

    /// A turn the bar may point back at: asked already, and the head of a round rather than a line inside one.
    private func namesAQuestion(_ b: UserBubble) -> Bool {
        !b.queued && StickySummary.isAnchor(text: b.text, note: b.note, itemCard: b.itemCard,
                                            taskStart: b.taskStart, startedCard: b.startedCard,
                                            sessionMessage: b.sessionMessage)
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
    private var rows: [TranscriptRow] {
        TranscriptRows.build(state: console.state,
                             statusCards: console.localStatusCards,
                             canPageOlder: canPageOlder,
                             showWorkingIndicator: console.showWorkingIndicator,
                             decisionCards: console.decisionCards,
                             clocks: console.receiptClocks)
    }

    /// Only the load-earlier spinner and the zero-height tail row differ from the chat-flow insets.
    private func rowInsets(_ row: TranscriptRow) -> EdgeInsets {
        switch row {
        case .loadOlder: return EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)
        case .bottom:    return EdgeInsets()
        default:         return EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16)
        }
    }

    @ViewBuilder
    private func transcriptRow(_ row: TranscriptRow) -> some View {
        switch row {
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
            TranscriptItemView(item: item, fullPayload: console.fullPayload, console: console)
                .modifier(AnchorRow(itemID: item.id, ruler: ruler, recompute: recomputeStuck))
        case .toolGroup(let cards):
            // No `AnchorRow`: a folded run of tool calls is never the "Your question" the sticky
            // header names, so it has no business moving that anchor.
            ToolGroupCardView(cards: cards, fullPayload: console.fullPayload)
        case .statusCard(let card):
            SessionStatusCardView(card: card)
        case .decisionCard(let card):
            // No `AnchorRow`: a question about the project's ruler isn't a "Your question" the
            // sticky header names. Unlike an approval it stops no turn, so later messages render
            // BELOW it — which is why the bar at the top of this console points down at it.
            DeliveredDecisionCardView(console: console, card: card)
        case .approval(let approval):
            // No `AnchorRow`: an approval isn't a "Your question" the sticky header names.
            ApprovalCard(console: console, approval: approval)
        case .working:
            WorkingIndicatorView()
        case .queued(let bubble):
            // No `AnchorRow` — a queued turn hasn't been asked yet, so it's never the sticky
            // "Your question" (web's `:not(.chat-queued)`).
            //
            // An exception item's delivery is nobody's message the moment it is QUEUED, not the
            // moment a runner takes it: its words are written for the AGENT, so read as a message
            // they are wrong about who sent them and everything the item is opened with is prose —
            // for as long as the turn waits, and redrawn the instant it is taken. The card comes off
            // the projection (`QueuedTurnInfo.itemCard`), never out of the text's shape, and this is
            // checked FIRST as the transcript's own row checks it (`TranscriptItemView`): the shape
            // must not depend on which of the two states the turn is in. A delivery's paragraph is
            // neither of the two wake blocks below, so nothing is shadowed by the order.
            //
            // Another Orbit session's message is asked about before all of them, as the transcript's
            // row asks it: who sent it is the projection's (`QueuedTurnInfo.senderCard`), and its words
            // are the sending agent's to choose — they could take a wake's shape. Cancel withdraws it
            // and hands nothing back to the composer (`ComposerLogic.restorableText`). Not offered for
            // a steer: `session_send` into a running turn is written into it, and the server refuses
            // to withdraw what the engine may already be reading (`UserBubbleView` hides it the same way).
            if let card = bubble.sessionMessage {
                SessionMessageCardView(card: card, text: bubble.text, ts: bubble.ts,
                                       undelivered: bubble.undelivered,
                                       onCancelQueued: bubble.turnId == nil || bubble.steer
                                           ? nil : { Task { await console.cancelQueued(bubble) } })
            } else if let card = bubble.itemCard {
                OpenItemDeliveryCardView(card: card, text: bubble.text, ts: bubble.ts,
                                         undelivered: bubble.undelivered,
                                         onCancelQueued: bubble.turnId == nil
                                             ? nil : { Task { await console.cancelQueued(bubble) } })
            } else if let started = bubble.startedCard {
                // The message telling the coordinator its project was started: the card the
                // transcript draws once a runner takes it, off the projection (`startedCard`).
                ProjectStartedCardView(card: started, text: bubble.text, ts: bubble.ts,
                                       undelivered: bubble.undelivered,
                                       onCancelQueued: bubble.turnId == nil
                                           ? nil : { Task { await console.cancelQueued(bubble) } })
            } else if let card = bubble.reviewRequest {
                // A confirmation review's turns are Orbit's on the queue too: the cards the
                // transcript draws once a runner takes them (web parity: the queued tail's
                // `q.confirmationReviewRequest` / `q.confirmationReturn`).
                ReviewRequestedCardView(card: card, ts: bubble.ts, undelivered: bubble.undelivered,
                                        onCancelQueued: bubble.turnId == nil
                                            ? nil : { Task { await console.cancelQueued(bubble) } })
            } else if let card = bubble.reviewReturn {
                SentBackByReviewerCardView(card: card, ts: bubble.ts, undelivered: bubble.undelivered,
                                           onCancelQueued: bubble.turnId == nil
                                               ? nil : { Task { await console.cancelQueued(bubble) } })
            } else if let wake = WatchWakeText.parse(bubble.text) {
                WatchWakeCardView(wake: wake, text: bubble.text, ts: bubble.ts,
                                  undelivered: bubble.undelivered,
                                  onWithdraw: bubble.turnId == nil
                                      ? nil : { Task { await console.cancelQueued(bubble) } })
            } else if let background = BackgroundWakeText.parse(bubble.text) {
                // A wake the control plane queued for a background job's news, or for a wakeup
                // coming due, is nobody's message either: it gets the card the transcript draws
                // once a runner takes it. Nothing has been recorded yet, so the block is still the
                // turn's own content rather than a note beside it (web parity: the queued tail
                // reads `q.content`). Withdrawing it is an ordinary cancel — nothing re-sends it.
                // Except for a job that ended while the turn ran: that wake is a steer on its way
                // into the running turn, which the server refuses to withdraw, so it says how far it
                // has got instead (web parity: `QueuedTurnMeta` for a `steer` placement).
                BackgroundWakeCardView(wake: background, ts: bubble.ts,
                                       undelivered: bubble.undelivered,
                                       onCancelQueued: bubble.turnId == nil || bubble.steer
                                           ? nil : { Task { await console.cancelQueued(bubble) } },
                                       steerState: BackgroundWakeCard.steerState(
                                           steer: bubble.steer, delivery: bubble.delivery,
                                           undelivered: bubble.undelivered),
                                       queued: true)
            } else {
                UserBubbleView(bubble: bubble,
                               onCancelQueued: { Task { await console.cancelQueued(bubble) } })
            }
        case .bottom:
            if console.detached {
                // A window opened at a record ends at a gap: reaching its bottom pulls in the newer page.
                HStack {
                    Spacer()
                    ProgressView().controlSize(.small)
                    Spacer()
                }
                .padding(.vertical, 8)
                .accessibilityLabel(SessionRecordLink.Copy.loadingNewer)
                .onAppear { Task { await console.loadNewer() } }
            } else {
                Color.clear.frame(height: 1)
            }
        }
    }

    /// Carry a scroll into the next update rather than making it from here (see `heldScroll`). A new
    /// tick each time, so asking twice for the same row scrolls twice.
    private func holdScroll(to rowID: String, anchor: UnitPoint, opensReview: Bool = false) {
        heldScroll = HeldScroll(rowID: rowID, anchor: anchor, tick: (heldScroll?.tick ?? 0) &+ 1,
                                sessionID: console.sessionID, opensReview: opensReview)
    }

    /// The bar opens the same review as tapping a preview. Inline cards remain scroll-only.
    private func openReview(for row: TranscriptRow) {
        guard case .decisionCard(let card) = row else { return }
        switch card.kind {
        case .promotionApproval(let promotionID):
            openPromotionReview(promotionID)
        case .criteriaDecision, .acceptanceConfirmation, .startProject, .criteriaChange,
             .ownerConfirmation, .coordinatorQuestion:
            openApprovalReview(.delivered(card))
        default:
            break
        }
    }

    // Sticky header that names the turn above the fold and scrolls back to it — web's
    // `.chat-sticky-question` (muted label + a single ellipsized line, both from `StickySummary`).
    // `anchor: .top` lands the bubble just under this header (it's a safe-area inset, so the scroll
    // region starts below it).
    private func stickyQuestion(_ bubble: UserBubble, proxy: ScrollViewProxy) -> some View {
        // What this turn was and what it said. A watch's wake — or an exception item's delivery — is
        // still the turn the bar points back at, but it is not the person's question: it gets its
        // card's own title and line (`StickySummary`), so the bar can't say "your question" above a
        // card reading "not typed by you".
        let summary = StickySummary.of(text: bubble.text, note: bubble.note, itemCard: bubble.itemCard,
                                       taskStart: bubble.taskStart,
                                       startedCard: bubble.startedCard,
                                       sessionMessage: bubble.sessionMessage)
        // `CoastingButton` (not a plain `Button`) so the tap fires even while the List is still coasting.
        return CoastingButton {
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
            HStack(spacing: 8) {
                // Priority, not `fixedSize()`: the label is served first, so the line beside it is
                // what gives way — but a label as long as "Watch stopped: every target is gone"
                // truncates itself rather than pushing the line off the row entirely.
                Text(summary.label)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail).layoutPriority(1)
                Text(summary.text)
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
        }
        .accessibilityLabel("Jump to your last question")
        .help("Jump to your last question")
    }

    // Circular "scroll to latest" control (ChatGPT parity). Wrapped in `CoastingButton` so the tap lands
    // even while the List is still coasting, and so a press springs the disc ~1.2× larger (ChatGPT's
    // feel — the shadow deepens with it). The disc rests at 40pt inside a 44pt hit target
    // (near-filling it, with a hair of margin); bottom padding is 6, so it floats just above the composer.
    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        CoastingButton {
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
        .padding(.bottom, 6)
        .accessibilityLabel(console.detached ? SessionRecordLink.Copy.jumpToLatest : "Scroll to latest")
        .help(console.detached ? SessionRecordLink.Copy.jumpToLatest : "Scroll to latest")
    }

    #if os(macOS)
    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle().fill(console.connected ? .green : .orange).frame(width: 7, height: 7)
            Text(headerStatus)
                .font(.caption).foregroundStyle(.secondary)
            if let session = app.session(id: console.sessionID) {
                SessionCoordinatorBadge(session: session)
            }
            Spacer()
            if !console.state.pendingApprovals.isEmpty {
                Label("\(console.state.pendingApprovals.count) pending", systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            if !console.state.background.isEmpty {
                Label("\(console.state.background.count) background", systemImage: "gearshape.2")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
        .background(.bar)
    }

    private var headerStatus: String {
        let watching = app.watches?.summary(for: console.sessionID)
        if let subtitle = SessionHeader.subtitle(for: app.session(id: console.sessionID), watching: watching) {
            return subtitle
        }
        return console.state.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
    }
    #endif
}

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
        .frame(maxWidth: 560, alignment: .leading)
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

/// The single scroll observer: drives the jump-to-latest button's `atBottom` and `tailOutOfView`,
/// AND feeds the sticky header by stashing the live content offset into `ruler` and asking for a
/// recompute each frame.
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
    #if os(iOS)
    /// The List's own `UIScrollView`, for the one fact UIKit knows better than any geometry: whether
    /// a finger is on it. See `readerIsMoving`.
    let scroll: TranscriptScroll
    #endif
    /// Whether the reader is the one moving the list: a finger on it, or the momentum of one.
    /// `.animating` is SwiftUI moving it (a jump-to-latest, the sticky header) and `.idle` is it
    /// sitting still while content is re-laid-out underneath — neither is a reader. `TailPinning`
    /// needs the difference to tell a drag up from the clamp a row that shrank forces.
    @State private var readerDriven = false

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
                }
                .onScrollGeometryChange(for: TailScrollSample.self) { geo in
                    TailScrollSample(offset: Double(geo.contentOffset.y),
                                     contentHeight: Double(geo.contentSize.height),
                                     bottomGap: Double(geo.contentSize.height - geo.visibleRect.maxY))
                } action: { was, now in
                    atBottom = TailPinning.pinned(wasPinned: atBottom, from: was, to: now,
                                                  readerDriven: readerIsMoving,
                                                  evidence: Self.evidence)
                    tailOutOfView = now.bottomGap > TailPinning.nearBottom
                    ruler.contentOffset = CGFloat(now.offset)
                    recompute()
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
    var body: some View {
        switch item {
        case .user(let b):
            // Another Orbit session's message (`session_send` / `project_send`): somebody's words,
            // but not the reader's, so not the reader's bubble. Who sent it is what the control plane
            // recorded beside the echo (`sessionMessage`, `SessionMessage.parse`), so it is asked
            // FIRST — before anything is read out of the words, which are the sending agent's to
            // choose — as the browser asks it (`NodeView`). No payload, the old reading.
            //
            // An exception item's delivery is the control plane's too, and for a stronger reason
            // than the wakes below: nobody typed it at all. What the turn says is a paragraph
            // written for the AGENT — the tools to call, the ids to call them with — so drawing it
            // as a message is both wrong about who sent it and unreadable as a record: the item's
            // kind, its title, the files a merge conflicted on and whether the work has landed are
            // all in the payload recorded beside it (`openItemDelivery`, `OpenItemDelivery.parse`).
            // With no payload the turn keeps its old reading — this is checked before the wakes, as
            // the browser checks it (`NodeView`).
            if let card = b.sessionMessage {
                SessionMessageCardView(card: card, text: b.text, ts: b.ts,
                                       undelivered: b.undelivered || b.delivery == "failed",
                                       attached: b.attached)
            } else if let card = b.itemCard {
                // The note the same turn carried rides inside the card (`b.attached`): nobody typed
                // this turn either, so the control plane's words do not go back into a bubble in the
                // reader's own name — the same rule the wake card applies to a mixed note.
                OpenItemDeliveryCardView(card: card, text: b.text, ts: b.ts,
                                         undelivered: b.undelivered || b.delivery == "failed",
                                         attached: b.attached)
            } else if let card = b.taskStart {
                // A task run's opening turn is the brief written for the agent — the task, then four
                // steps of protocol — and nobody typed it either. With the task recorded beside it
                // (`taskStart`, `TaskStart.parse`) it is drawn as that task, with anything delivery
                // appended riding inside the card; the task's inputs the turn carried keep the
                // bubble's own image and file rows under it, with no words in the owner's name.
                VStack(alignment: .leading, spacing: 6) {
                    TaskStartCardView(card: card, text: b.text, ts: b.ts,
                                      undelivered: b.undelivered || b.delivery == "failed",
                                      attached: b.attached)
                    if !b.attachments.isEmpty {
                        UserBubbleView(bubble: inputsOnly(b))
                    }
                }
            } else if let started = b.startedCard {
                // The message telling the coordinator its project was started: prose for the agent,
                // drawn as the card the payload recorded beside it (`projectStarted`,
                // `ProjectStarted.parse`). No payload, the old reading.
                ProjectStartedCardView(card: started, text: b.text, ts: b.ts,
                                       undelivered: b.undelivered || b.delivery == "failed",
                                       attached: b.attached)
            } else if let card = b.reviewRequest {
                // A confirmation request handed to this conversation to review, and a reviewer's
                // return handed to the run (`ConfirmationReviewTurns.swift`): Orbit's turns, drawn as
                // their cards with the block the agent read riding at the foot (web parity: NodeView).
                ReviewRequestedCardView(card: card, ts: b.ts,
                                        undelivered: b.undelivered || b.delivery == "failed",
                                        attached: b.attached)
            } else if let card = b.reviewReturn {
                SentBackByReviewerCardView(card: card, ts: b.ts,
                                           undelivered: b.undelivered || b.delivery == "failed",
                                           attached: b.attached)
            } else if let replies = b.sessionReplies, !replies.isEmpty {
                // The outcomes of this session's own requests, handed back (`sessionReplies`,
                // `SessionReply.parse`): a reply turn carries nobody's words, and a message of the
                // owner's may carry outcomes that were held for it — then the owner's words are their
                // bubble, first, and the outcomes follow as cards, with what else delivery appended
                // folded into them (web parity: NodeView).
                VStack(alignment: .leading, spacing: 6) {
                    if !b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        UserBubbleView(bubble: withoutNote(b))
                    }
                    SessionReplyCardsView(replies: replies, ts: b.ts, attached: replyRest(b))
                }
            } else if let wake = WatchWakeText.parse(b.text) {
                // A turn a watch queued is the watch's to show, not a message the user typed: it opens
                // with a raw UUID and carries the whole payload the agent read (web parity: NodeView).
                WatchWakeCardView(wake: wake, text: b.text, ts: b.ts,
                                  undelivered: b.undelivered || b.delivery == "failed")
            } else if let background = BackgroundWakeText.parse(b.note) {
                // A turn the control plane opened for a background job's news, or for a wakeup
                // coming due, is nobody's message either: the block IS the turn, so it is read off
                // the recorded note rather than the person's words, which are empty. Only the wake
                // blocks become the card — anything else the same note carried (the inventory a
                // returning engine is handed, a coordinator's standing role) is a folded entry in
                // the same card, because it is the control plane's too. It used to be an entry in a
                // user bubble under the card, which drew an empty bubble: a message with no words
                // in it, in the reader's own name. A job that ended while a turn ran was written
                // into that turn as a steer: the same line, where its echo landed inside the running
                // turn, saying how far it got (web parity: `Transcript.tsx`'s `steer=`).
                VStack(alignment: .leading, spacing: 6) {
                    BackgroundWakeCardView(wake: background, ts: b.ts,
                                           undelivered: b.undelivered || b.delivery == "failed",
                                           attached: attachedRest(background),
                                           steerState: BackgroundWakeCard.steerState(
                                               steer: b.steer, delivery: b.delivery,
                                               undelivered: b.undelivered))
                    if BackgroundWakeCard.drawsBubble(text: b.text) {
                        UserBubbleView(bubble: withoutNote(b))
                    }
                }
            } else {
                UserBubbleView(bubble: b)
            }
        case .assistant(let b): AssistantBubbleView(bubble: b)
        case .thinking(let b):  ThinkingView(block: b)
        case .toolCall(let c):  ToolCardView(card: c, fullPayload: fullPayload)
        case .interrupt:
            Label("Interrupted", systemImage: "stop.circle").font(.orbitLabel).foregroundStyle(.secondary)
        case .error(_, let message):
            if let console, console.executesDsh, let repair = DshRuntime.repair(message) {
                DshRepairCardView(console: console, repair: repair)
            } else if let repair = EngineAuth.antigravityRepair(message), let console, console.executesAntigravity {
                AntigravityRepairCardView(console: console, repair: repair)
            } else if let summary = ToolFailureSummary.parse(message) {
                ToolFailureCardView(message: message, summary: summary)
            } else {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red).textSelection(.enabled)
            }
        case .authError(_, let message):
            if let console {
                AuthErrorCardView(console: console, message: message)
            } else {
                // No console to act through (a preview / detached render): the diagnosis alone,
                // which is what the runtime said in the first place.
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange).textSelection(.enabled)
            }
        case .autoRetry(let notice):
            if let console {
                AutoRetryCardView(console: console, notice: notice)
            } else {
                // Same as above: with no session to read the armed retry off, or to retry through,
                // what's left is the runtime's own sentence.
                Label(notice.message, systemImage: "clock.fill")
                    .foregroundStyle(.secondary).textSelection(.enabled)
            }
        case .notice(_, let message):
            // A heads-up, not a failure — web's `.chat-notice`: the warning tone at label size,
            // behind the triangle.
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.orbitLabel).foregroundStyle(.orange).textSelection(.enabled)
        }
    }

    /// What the wake card did NOT take, as the entry folded inside it — so a mixed note still shows
    /// its other blocks instead of repeating the wake beneath the card.
    private func attachedRest(_ wake: BackgroundWake) -> (kind: String, text: String)? {
        wake.rest.isEmpty ? nil : (kind: describeNote(wake.rest), text: wake.rest)
    }

    /// What the reply cards did NOT take from a turn's note, as the entry folded inside them.
    private func replyRest(_ bubble: UserBubble) -> (kind: String, text: String)? {
        let rest = SessionReply.withoutReplyBlocks(bubble.note)
        return rest.isEmpty ? nil : (kind: describeNote(rest), text: rest)
    }

    /// The same bubble with the note taken off it: all of it is the card's now, so leaving it here
    /// would draw it a second time under the card that already holds it.
    private func withoutNote(_ bubble: UserBubble) -> UserBubble {
        var bare = bubble
        bare.note = nil
        return bare
    }

    /// The same bubble holding only what it was sent with: the brief and the note are the task-start
    /// card's, so what is left is the images and files, drawn as the bubble draws them.
    private func inputsOnly(_ bubble: UserBubble) -> UserBubble {
        var inputs = bubble
        inputs.text = ""
        inputs.note = nil
        return inputs
    }
}
