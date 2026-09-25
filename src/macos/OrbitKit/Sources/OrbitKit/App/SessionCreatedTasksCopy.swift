import Foundation

/// The words of the "Tasks created here" card above a session's composer, and the sentence its
/// collapsed row writes. The browser writes the same ones (`SESSION_CREATED_TASKS_COPY` and
/// `createdTasksCountLine` in `@orbit/shared`), and both ends are proved against one set of cases,
/// `src/shared/src/session-created-tasks.fixture.json` — see `SessionCreatedTasksCopyParityTests`.
public enum SessionCreatedTasksCopy {
    public static let title = "Tasks created here"
    public static let viewAll = "View all in Tasks ›"
    public static let openProject = "Open project ›"
    /// Followed directly by the replaced task's title.
    public static let replacesPrefix = "Replaces "
    /// The Tasks page's filter chip; followed directly by the session's title.
    public static let createdInChip = "Created in "
    /// Between the sentence's parts, and before a row's `Replaces …`: U+00B7 between two spaces.
    public static let separator = " · "

    /// With exactly one row the collapsed row writes no sentence: it names the task and shows its
    /// pill, as the Watching row does.
    public static let singleNamesTheTask = true

    /// One part of the sentence. A failed count is the one part drawn in red.
    public struct CountPart: Equatable, Sendable {
        public let text: String
        public let failed: Bool
    }

    /// `N running`, `N failed` and `done/total done`: a zero running or failed is left out rather
    /// than written as `0 running`, and `done/total` always stays, so the sentence is never empty.
    public static func countParts(running: Int, failed: Int, done: Int, total: Int) -> [CountPart] {
        var parts: [CountPart] = []
        if running > 0 { parts.append(CountPart(text: "\(running) running", failed: false)) }
        if failed > 0 { parts.append(CountPart(text: "\(failed) failed", failed: true)) }
        parts.append(CountPart(text: "\(done)/\(total) done", failed: false))
        return parts
    }

    /// The sentence the parts make: `2 running · 1 failed · 4/8 done`.
    public static func countLine(running: Int, failed: Int, done: Int, total: Int) -> String {
        countParts(running: running, failed: failed, done: done, total: total)
            .map(\.text)
            .joined(separator: separator)
    }

    /// `Replaces ‹title›`, the suffix a row whose task took over another one carries.
    public static func replaces(_ title: String) -> String { replacesPrefix + title }

    /// `Created in ‹session›`, the Tasks page's chip.
    public static func createdIn(_ sessionTitle: String) -> String { createdInChip + sessionTitle }

    /// What the collapsed row says.
    public enum Line: Equatable, Sendable {
        /// The session created nothing: there is no card.
        case hidden
        /// One row: its task by name, and its pill.
        case single(SessionCreatedTaskRow)
        /// Several: the sentence, in parts.
        case counted([CountPart])
    }

    public static func line(_ tasks: SessionCreatedTasks) -> Line {
        guard tasks.total > 0 else { return .hidden }
        if singleNamesTheTask, tasks.total == 1, let only = tasks.items.first {
            return .single(only)
        }
        return .counted(countParts(running: tasks.running, failed: tasks.failed,
                                   done: tasks.done, total: tasks.total))
    }
}
