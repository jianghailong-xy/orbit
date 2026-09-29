import Foundation

// The navigation value layer: one stack per section, and every fact the shells need read off it.
//
// Today those facts live in flat optionals on `AppModel` — `selectedAgentSessionID` alone draws the
// `List(selection:)` highlight, stands for the console pushed on the Agents stack, and names the
// session that should be streaming. In a three-column shell those three are the same thing, because
// the detail pane is always on screen. On an iPhone they are not: a stack is ordered, can be popped,
// and "this row is the current one, but I'm looking at the list" is a perfectly legal state that a
// single `String?` cannot express. Once the two disagree, nothing arbitrates — SwiftUI's stack is
// private, the optional is the only copy — so the highlight and the push drift apart and the row
// goes dead.
//
// Here the stack is the only copy, and each derived fact is a total function of it, so none of them
// can disagree with what is on screen. Pure values and pure functions, deliberately not
// `@Observable` — the same layering `Transcript/SessionStore.swift` states, which keeps this
// testable on Linux where SwiftUI doesn't exist.

/// How a page got pushed, carried by the frame that needs it. It used to be a shadow variable kept
/// true by an assignment-ordering convention ("set it *before* the selection so its observer
/// preserves it") that only a comment enforced.
public enum NavOrigin: Hashable, Sendable {
    /// A row in the section's own list.
    case list
    /// A row in the compact shell's left drawer — a Recents row, or one of the open projects — the
    /// page that yields the screen edge back to the drawer it came from.
    case drawer
    /// A URL or a notification tap.
    case deepLink
    /// The needs-you banner.
    case banner
    /// A link in the conversation underneath, on a phone: pushed over that console, so the back
    /// swipe returns to it (`AppModel.pushConsole`).
    case conversation
}

/// One pushed page. A section's whole navigation state is `[NavNode]`, so what is on screen and how
/// you got there are the same value.
public enum NavNode: Hashable, Sendable {
    case console(sessionID: String, origin: NavOrigin)
    case compose(agentID: String)
    case taskDetail(taskID: String)
    case taskListsDirectory
    case runnerDetail(runnerID: String)
    case watchDetail(watchID: String)
    /// Settings' second layer: the runners list, pushed from Settings' own form. A runner's record is
    /// the third, and it is the *same* ``runnerDetail(runnerID:)`` frame the Runners section pushes —
    /// what tells the two apart is the stack a frame rides, not the frame.
    case settingsRunners
    /// Every other page Settings' list opens — Notifications, Providers, Shared links, Change
    /// password, Admin — each a frame of Settings' own stack like the runners list above it.
    case settingsPage(SettingsPage)
    /// A pool's page, pushed from Settings → Providers: an account pool of the user's own Claude
    /// subscriptions, read-only here, or a shared pool of OpenAI API keys, which is run from its page.
    case accountPool(poolID: String)
    case sharedPool(poolID: String)
    case userDetail(userID: String)
    /// One project's page, pushed from the Projects list or from the drawer's project rows — which
    /// the page's origin tells apart, as a console's does.
    case projectDetail(projectID: String, origin: NavOrigin = .list)
    /// Every task one session's agent created: its console's `View all in Tasks ›` on a phone, pushed
    /// over that console — with the card's task and project pages — so the back swipe returns to the
    /// conversation instead of to another section's list.
    case createdTasks(sessionID: String)
    /// The Following page's list of watches: a console's Watching card's `Manage in Watches ›` on a
    /// phone, pushed over that console for the same reason — a row opens its watch on this stack.
    case watches
    /// One wiki entry's page, pushed from the Wiki home's rows — or over a phone's conversation, from
    /// an `orbit-wiki:` link in it, so the back swipe returns to the conversation.
    case wikiEntry(entryID: String)
    /// Review: the proposals waiting for the owner, one card at a time. Pushed from the Wiki home's
    /// amber banner.
    case wikiReview
    /// The space's Wiki settings — its review mode and maintenance — pushed from the home's gear.
    case wikiSettings
    /// One run: what a maintenance run, an import or a session's proposal applied at once, pushed
    /// from its row in Recently changed.
    case wikiRun(changesetID: String)
    /// One of a topic's articles — its own (part 0) or a subtopic article — pushed from the Contents
    /// sheet, Browse by category or the A–Z index.
    case wikiArticle(topic: String, part: Int)
    /// Every category's topics and their articles, pushed from the Contents sheet.
    case wikiBrowse
    /// Every article A to Z, pushed from the Contents sheet.
    case wikiIndex
}

/// Which section is showing, and every section's stack.
///
/// The stacks persist across a section switch, which is what `selectedSection`'s `didSet` throws
/// away today while the flat selection survives it — and it has to list the pushes to drop by hand,
/// a list kept in a comment that nothing type-checks.
public struct NavState: Equatable, Sendable {
    public var section: AppSection
    public var stacks: [AppSection: [NavNode]]
    /// Settings is up as a sheet over the section (iOS, where it is presented rather than switched
    /// to): its own stack is then the one on screen, so a push lands there and the section's stack
    /// underneath is left exactly as it was — the same console, still streaming, when it closes.
    public var settingsPresented: Bool

    public init(section: AppSection = .agents, stacks: [AppSection: [NavNode]] = [:],
                settingsPresented: Bool = false) {
        self.section = section
        self.stacks = stacks
        self.settingsPresented = settingsPresented
    }

    /// The stack on screen: the current section's, which is what a `NavigationStack(path:)` binds to.
    ///
    /// Writable because that is exactly how a `NavigationStack(path:)` reports back — a back button,
    /// an edge swipe, or a row's own link appending to it. Writes go through the same normalization
    /// the transitions use, so an emptied stack still drops its key and two states showing the same
    /// screens stay equal (SwiftUI writes back `[]`, not "no value").
    public var path: [NavNode] {
        get { stacks[section] ?? [] }
        set { stacks[section] = newValue.isEmpty ? nil : newValue }
    }

    /// Settings' own stack, wherever Settings is drawn: the sheet's on iOS, the section's on macOS
    /// (where it *is* the section's `path`). What the sheet's `NavigationStack(path:)` binds to, and
    /// normalized the same way, so an emptied stack drops its key.
    public var settingsPath: [NavNode] {
        get { stacks[.settings] ?? [] }
        set { stacks[.settings] = newValue.isEmpty ? nil : newValue }
    }

    /// Put Settings up over the section. It opens on its own list, not on whichever page it was
    /// closed on — the stack is cleared on the way in rather than on the way out, so the page being
    /// dismissed doesn't pop under the closing sheet.
    public mutating func openSettings() {
        if !settingsPresented { settingsPath = [] }
        settingsPresented = true
    }

    // MARK: - Derived facts
    //
    // Each one is a read of `path`. There is nothing else to keep in step with it.

    /// `AppModel.sectionAtRoot` — nothing pushed, so the compact shell can give the left screen edge
    /// to its drawer gesture. Asking the selection instead of the stack was also how a stranded
    /// selection cost you the drawer swipe on the list page.
    public var sectionAtRoot: Bool { path.isEmpty }

    /// `AppModel.focusedConsoleSessionID` — the session that should be live-streaming. Its doc
    /// promises "backing out to a list stops the stream"; the pop that does it happens inside
    /// SwiftUI's private stack, which reports back by writing the emptied path into ``path``.
    public var focusedConsoleSessionID: String? { consoleOnTop }

    /// The session row drawn as selected. Deliberately the same read as ``focusedConsoleSessionID``:
    /// storing the highlight *separately* from the push is what let the two disagree, leaving a row
    /// that drew as selected and could not be opened.
    public var highlightedSessionID: String? { consoleOnTop }

    /// `AppModel.consoleFromRecents` — you came from the drawer, so the left edge returns you there.
    /// No shadow variable and no assignment-ordering convention: the frame says where it came from.
    public var consoleFromRecents: Bool {
        if case .console(_, .drawer) = path.last { return true }
        return false
    }

    /// `AppModel.projectFromDrawer` — the same for a project's page opened from the drawer's project
    /// rows: the left edge returns you to the drawer, not to the Projects list under the page.
    public var projectFromDrawer: Bool {
        if case .projectDetail(_, .drawer) = path.last { return true }
        return false
    }

    // The three single-layer sections — Following, Runners, Admin — push exactly one kind of page,
    // so "which record is showing" is the id on top of their own stack. Each one is a total function
    // of that stack like every other fact here: the list's highlight and the detail pane are the
    // same read, which is what stops a row drawing as selected while the page under it says
    // something else. Admin is the one that had nowhere to put this at all — see ``NavNode/userDetail(userID:)``.

    /// `AppModel.selectedWatchID` — the watch record the Following pane shows. Whatever the frame
    /// carries is what is shown: a push may name a watch by its UUID until the list's spelling
    /// replaces it in place.
    public var selectedWatchID: String? {
        guard case .watchDetail(let id) = path.last else { return nil }
        return id
    }

    /// `AppModel.selectedRunnerID` — the runner record the Runners pane shows.
    public var selectedRunnerID: String? {
        guard case .runnerDetail(let id) = path.last else { return nil }
        return id
    }

    /// `AppModel.selectedProjectID` — the project the Projects pane shows. A task one of its rows
    /// opened over it (``projectBeneathTask``) leaves it the project showing: the list keeps it
    /// selected, and the pane draws the task over it.
    public var selectedProjectID: String? {
        if case .projectDetail(let id, _) = path.last { return id }
        return projectBeneathTask
    }

    /// The project whose page is directly under the task page on top — the pair a project's task
    /// row pushes, on the phone's Projects stack and in the wide shells' pane alike.
    public var projectBeneathTask: String? {
        let frames = path
        guard frames.count >= 2, case .taskDetail = frames[frames.count - 1],
              case .projectDetail(let id, _) = frames[frames.count - 2] else { return nil }
        return id
    }

    /// `AppModel.selectedWikiEntryID` — the entry the Wiki pane shows.
    public var selectedWikiEntryID: String? {
        guard case .wikiEntry(let id) = path.last else { return nil }
        return id
    }

    /// Whether Review is the page on top of the Wiki section's stack.
    public var wikiReviewOnTop: Bool {
        if case .wikiReview = path.last { return true }
        return false
    }

    /// Whether the Wiki settings are the page on top of the Wiki section's stack.
    public var wikiSettingsOnTop: Bool {
        if case .wikiSettings = path.last { return true }
        return false
    }

    /// The run the Wiki pane shows, when a run's page is on top.
    public var selectedWikiRunID: String? {
        guard case .wikiRun(let id) = path.last else { return nil }
        return id
    }

    /// The article the Wiki pane shows, when an article is on top: its topic and part.
    public var selectedWikiArticle: WikiArticleAddress? {
        guard case .wikiArticle(let topic, let part) = path.last else { return nil }
        return WikiArticleAddress(topic: topic, part: part)
    }

    /// Whether Browse by category is the page on top of the Wiki section's stack.
    public var wikiBrowseOnTop: Bool {
        if case .wikiBrowse = path.last { return true }
        return false
    }

    /// Whether the A–Z index is the page on top of the Wiki section's stack.
    public var wikiIndexOnTop: Bool {
        if case .wikiIndex = path.last { return true }
        return false
    }

    /// `AppModel.selectedUserID` — the account the Admin pane shows.
    public var selectedUserID: String? {
        guard case .userDetail(let id) = path.last else { return nil }
        return id
    }

    /// The console page on top, if that is what is showing. Both "which row is current" and "which
    /// console streams" are this one read, so they cannot drift apart.
    private var consoleOnTop: String? {
        guard case .console(let id, _) = path.last else { return nil }
        return id
    }

    /// `AppModel.selectedTaskID` — the task whose detail is showing, which in the three-column shell
    /// is also the row drawn as selected. Read off the stack like every other fact here: while a
    /// flat `selectedTaskID` sat beside the stack, a task deleted under the viewer could leave the
    /// pane drawing a selection whose page was never pushed, on a spinner that never resolved.
    public var taskDetailOnTop: String? {
        guard case .taskDetail(let id) = path.last else { return nil }
        return id
    }

    /// `AppModel.taskListsDirectoryPresented` — the searchable directory of every named task list is
    /// the second thing this section pushes (the compact drawer's "View All Lists" row). It is a
    /// frame, not a boolean beside the stack, so opening it cannot disagree with what is on screen.
    public var taskListsDirectoryOnTop: Bool {
        if case .taskListsDirectory = path.last { return true }
        return false
    }

    // MARK: - Transitions

    /// Go one page deeper in the current section — or in Settings, while it is up over the section:
    /// a push lands on the stack on screen, never on one underneath it.
    public mutating func push(_ node: NavNode) {
        if settingsPresented {
            settingsPath.append(node)
            return
        }
        withPath { $0.append(node) }
    }

    /// The back button or the system back-swipe — what `NavigationStack(path:)` writes back by
    /// contract, which is how a pop finally reaches the model at all.
    public mutating func pop() {
        withPath { if !$0.isEmpty { $0.removeLast() } }
    }

    /// Back to the section's list.
    public mutating func popToRoot() {
        withPath { $0.removeAll() }
    }

    /// What a three-column shell means by "select": replace the page the detail pane is showing
    /// rather than deepen the stack. One state therefore serves both shell shapes, so neither needs
    /// to know which shell it is in.
    public mutating func replaceTop(with node: NavNode) {
        withPath {
            if $0.isEmpty { $0.append(node) } else { $0[$0.count - 1] = node }
        }
    }

    /// Back to `sessionID`'s console when it is the page directly under the one on top: the
    /// conversation a phone opened its project's page over. Going to that conversation again is a
    /// pop, so the stack reads conversation › project page instead of growing a second copy of the
    /// same conversation on every round trip. False, with nothing changed, when it is not there.
    @discardableResult
    public mutating func returnToConsole(_ sessionID: String) -> Bool {
        let frames = path
        guard !settingsPresented, frames.count >= 2,
              case .console(let beneath, _) = frames[frames.count - 2],
              PublicID.storageKey(beneath) == PublicID.storageKey(sessionID) else { return false }
        pop()
        return true
    }

    /// Back to `projectID`'s page when it is the page directly under the task page on top: the
    /// project whose row opened the task. Going to that project again is a pop, so the stack reads
    /// project › task instead of project › task › project on every press of the task's project
    /// line. False, with nothing changed, when it is not there.
    @discardableResult
    public mutating func returnToProject(_ projectID: String) -> Bool {
        guard !settingsPresented, let beneath = projectBeneathTask,
              PublicID.storageKey(beneath) == PublicID.storageKey(projectID) else { return false }
        pop()
        return true
    }

    /// The session's console is gone — completed, trashed or purged out from under it — so nothing
    /// is left on screen streaming a session the server no longer has. This is the one edit that
    /// replaced three hand-cleared optionals: the selection, the Recents marker and the compose
    /// page's in-place console were three copies of "the console showing", and a frame is dropped
    /// here whether it was the top one or buried under a later push.
    public mutating func removeConsole(_ sessionID: String) {
        withPath { frames in
            frames.removeAll {
                if case .console(let id, _) = $0 { return id == sessionID }
                return false
            }
        }
    }

    /// Every transition goes through here, so an emptied stack drops its key instead of leaving an
    /// empty array behind: two states showing the same screens compare equal.
    private mutating func withPath(_ change: (inout [NavNode]) -> Void) {
        var p = path
        change(&p)
        stacks[section] = p.isEmpty ? nil : p
    }
}

/// Where one article lives: its topic's slug, and its part — 0 for the topic's own article.
public struct WikiArticleAddress: Hashable, Sendable {
    public let topic: String
    public let part: Int

    public init(topic: String, part: Int) {
        self.topic = topic
        self.part = part
    }
}
