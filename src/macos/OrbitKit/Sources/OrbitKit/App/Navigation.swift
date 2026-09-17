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
    /// A Recents row in the compact shell's left drawer — the page that yields the screen edge back
    /// to the drawer it came from.
    case drawer
    /// A URL or a notification tap.
    case deepLink
    /// The needs-you banner.
    case banner
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
    case userDetail(userID: String)
}

/// Which section is showing, and every section's stack.
///
/// The stacks persist across a section switch, which is what `selectedSection`'s `didSet` throws
/// away today while the flat selection survives it — and it has to list the pushes to drop by hand,
/// a list kept in a comment that nothing type-checks.
public struct NavState: Equatable, Sendable {
    public var section: AppSection
    public var stacks: [AppSection: [NavNode]]

    public init(section: AppSection = .agents, stacks: [AppSection: [NavNode]] = [:]) {
        self.section = section
        self.stacks = stacks
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

    /// Go one page deeper in the current section.
    public mutating func push(_ node: NavNode) {
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
