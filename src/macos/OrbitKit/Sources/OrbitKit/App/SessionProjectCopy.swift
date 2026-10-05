import Foundation

/// Project rows and pages say the web's `SESSION_PROJECT_COPY` words
/// (`src/web/src/lib/sessionProjects.ts`, docs/session-list-projects-design.md §6).
public enum SessionProjectCopy {
    public static func progress(done: Int, total: Int) -> String { "\(done)/\(total)" }
    public static func progressHint(sessions: Int, running: Int) -> String {
        "\(sessions) sessions · \(running) running"
    }
    public static func waitingSession(_ text: String, title: String) -> String {
        "\(text) · \(title)"
    }

    public static let noCoordinator = "No coordinator"
    public static let openSession = "Open Session"
    public static let openCoordinator = "Open Coordinator"
    public static let sessions = "Sessions"
    public static let openProject = "Open Project"
    public static let pin = "Pin"
    public static let unpin = "Unpin"
    public static let move = "Move…"

    public static func pageSubtitle(sessions: Int) -> String { "Project · \(sessions) sessions" }
    public static let coordinatorSection = "Coordinator"
    public static func pageProgress(done: Int, total: Int, running: Int) -> String {
        "\(done)/\(total) done · \(running) running"
    }

    /// The project-page coordinator chip without its prefix, capitalized for the session row.
    public static func coordinatorLead(_ kind: CoordinatorLeadKind) -> String? {
        switch kind {
        case .integrationConflict: return "Resolving a merge conflict"
        case .integrationCheckFailed: return "Checks failed"
        case .integrationError: return "Handling an integration error"
        case .taskFailed: return "Handling a failed task"
        case .deliveryReview: return "Reviewing a delivery"
        case .unknown: return nil
        }
    }
}
