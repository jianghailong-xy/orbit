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
    /// The page's subtitle before its members have been read: no count it cannot vouch for yet.
    public static let pageSubtitleLoading = "Project"
    public static let coordinatorSection = "Coordinator"
    public static func pageProgress(done: Int, total: Int, running: Int) -> String {
        "\(done)/\(total) done · \(running) running"
    }

    /// The progress line of a project nobody has started, which says so rather than reading like
    /// one that runs nothing: "Not started · 5 tasks" (docs/mocks/project-start-sessions-page).
    public static func pageNotStarted(tasks: Int) -> String {
        "Not started · \(tasks) \(tasks == 1 ? "task" : "tasks")"
    }
    /// The start row under it, when the coordinator has asked: since when, what it suggests in one
    /// line, and the press that opens the start card.
    public static func startAsked(_ ago: String) -> String { "asked \(ago)" }
    public static func startSuggestion(_ settings: ProjectStartSettings) -> String {
        "\(settings.line == .main ? "Directly into main" : "Project branch") · Automatic \(settings.automatic ? "on" : "off") · \(settings.maxConcurrentTasks) at a time"
    }
    public static let startReview = "Review and start"
    /// …and when nobody has, beside the owner's own Start….
    public static let startNotAsked = "The coordinator hasn’t asked yet"
    /// What either press opens, for a reader who cannot see the card it will put up.
    public static let startHint = "Opens the start card: the criteria, the plan and how it runs."

    /// The project page's landing line, shortened for a row that is not redrawn every second:
    /// "Merge to main · queued · 13m", "Landing · checking · 4m · <task>". Nil when nothing is in
    /// flight; a server that sends only the count gets "Landing · N jobs". Web: `sessionProjectLandingLine`.
    public static func landingLine(_ integration: ProjectListIntegration?, now: Date) -> SessionLine? {
        let count = integration?.activeJobCount ?? 0
        guard let job = integration?.inFlight else {
            return count > 0 ? SessionLine(text: "Landing · \(count) \(count == 1 ? "job" : "jobs")", tone: .queued) : nil
        }
        let heartbeat = job.heartbeatAt.flatMap(RelativeTime.parse)
        let running = job.state == "RUNNING" && heartbeat.map { now.timeIntervalSince($0) > 600 } != true
        let word = ProjectPage.integrationJobWords[job.kind ?? ""] ?? "Integration"
        let state = job.state == "RUNNING" ? (ProjectPage.integrationPhaseWords[job.phase ?? ""] ?? "running") : "queued"
        let text = [count > 1 ? "\(word) \(count) jobs" : word, state,
                    ProjectAttention.elapsedLabel(job.startedAt, now: now), count > 1 ? nil : job.taskTitle]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return SessionLine(text: text, tone: running ? .running : .queued)
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
