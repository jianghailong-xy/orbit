import Foundation

// The task detail page on the native clients: the web's `TaskDetailPanel` block for block, in its
// order — Head, Actions, [Verification task], Details, Dependencies, Description, Acceptance,
// Inputs, Attribution, Followed by, Runs, Comments, and the comment box under them. The words are
// the browser's own (`TaskDetailCopyParityTests` reads the web sources and holds every one of them
// here to its declaration there); what differs is only the container a phone gives them.

/// Every word the page says that the browser also says.
public enum TaskDetailCopy {
    // MARK: section headings (`tdp-section-title`)

    public static let detailsHeading = "Details"
    public static let dependenciesHeading = "Dependencies"
    public static let descriptionHeading = "Description"
    public static let acceptanceHeading = "Acceptance"
    public static let inputsHeading = "Inputs"
    public static let attributionHeading = "Attribution"
    public static let followedByHeading = "Followed by"
    public static let runsHeading = "Runs"
    public static let commentsHeading = "Comments"

    // MARK: actions

    /// The detail's own name for a first run (the list rows say `Run`).
    public static let runNow = "Run now"

    // MARK: details

    public static let assigneeLabel = "Assignee"
    public static let providerLabel = "Provider"
    public static let modelLabel = "Model"
    public static let listLabel = "List"
    public static let startAtLabel = "Start at"
    public static let createdByLabel = "Created by"
    public static let createdFromLabel = "Created from"
    public static let createdLabel = "Created"

    // MARK: start at (`TaskScheduleEditor.tsx`)

    /// What the row reads while nothing is scheduled — the web's datetime box is simply empty.
    public static let scheduleNotSet = "Not set"
    public static let saveSchedule = "Save schedule"
    public static let cancelSchedule = "Cancel schedule"
    public static let scheduleSaved = "Start time saved"
    public static let scheduleCancelled = "Scheduled start cancelled"
    public static let scheduleHintUnscheduled = "Optional, in your own time zone. The task starts once, at that time."
    public static let scheduleHintUnreadable =
        "A start is scheduled that this control cannot read. Cancel schedule clears it, or pick a time to replace it."
    public static func scheduleHint(startingOn local: String) -> String {
        "Starts once, on \(local), in your own time zone. Run now starts immediately and clears this scheduled start."
    }

    // MARK: dependencies

    public static let noDependencies = "No dependencies"
    public static let addPrerequisite = "Add prerequisite"
    public static let autoRunWhenReady = "Auto-run when all prerequisites finish"
    public static let graphView = "Graph"
    public static let listView = "List"
    public static let currentTask = "Current"
    public static let noAdjacentRelationships = "No adjacent relationships"
    public static let removePrerequisiteTitle = "Remove prerequisite?"
    public static let removePrerequisiteDetail = "This task will no longer wait for this prerequisite."
    public static let remove = "Remove"
    public static let graphLimitReached = "Graph expansion limit reached. Some branch connections remain collapsed."

    public static func dependencySummary(connected: Int, loaded: Bool, upstream: Int, downstream: Int) -> String {
        "\(connected) connected\(loaded ? " loaded" : "") · \(upstream) upstream · \(downstream) downstream"
    }

    public static func failedPrerequisites(_ n: Int) -> String {
        n == 1
            ? "A direct prerequisite failed or was cancelled — resolve it before running."
            : "\(n) direct prerequisites failed or were cancelled — resolve them before running."
    }

    public static func completedPrerequisites(_ done: Int, of total: Int) -> String {
        "\(done) of \(total) direct prerequisites complete. All are required."
    }

    /// The first sentence of the web's `expandable` notice. The second tells the reader to expand a
    /// collapsed branch, which only the browser's canvas can do.
    public static func graphSnapshotLimit(maxDepth: Int?, maxNodes: Int?, maxEdges: Int?) -> String {
        let edges = maxEdges.map { " or \($0) relationships" } ?? ""
        return "The initial snapshot is limited to \(maxDepth ?? 8) hops or \(maxNodes ?? 100) tasks\(edges)."
    }

    // MARK: description and long text

    public static let showMore = "Show more"
    public static let showLess = "Show less"

    // MARK: acceptance (`pages/TaskDetailPage.tsx`)

    public static let acceptanceCriteriaLabel = "Acceptance criteria"
    public static let automaticJudgementLabel = "Automatic judgement"
    public static let edit = "Edit"
    public static let acceptanceEmpty = "No acceptance criteria set."
    public static let acceptancePairEmpty = "Not set — a person decides when this task is done."
    public static let acceptanceAutomaticHint =
        "Filled in as a pair, the task is judged by running this command and reading its exit code — nobody has to decide by hand."
    public static let acceptancePairIncomplete =
        "The command and the exit code that counts as done go together — fill in both."
    public static let acceptanceExitCodeNotAnInteger = "The exit code has to be a whole number."
    public static let acceptanceCriteriaPlaceholder = "What has to be true when this task is done"
    public static let acceptanceCommandLabel = "Command"
    public static let acceptanceCommandPlaceholder = "e.g. npm test -w @orbit/web"
    public static let doneWhenItExits = "done when it exits"
    public static let saveAcceptance = "Save acceptance"
    public static let cancel = "Cancel"
    public static let acceptanceSaved = "Acceptance saved"

    // MARK: inputs (`TaskInputs.tsx`)

    public static let inputsHint = "Files every run of this task is given — design mocks, specs. Each run gets its own copy."
    public static let addFile = "Add file"
    public static let removeInputTitle = "Remove this input?"
    public static let removeInputDetail = "Runs already started keep their copy."

    // MARK: attribution (`TaskAttributionCard.tsx`, `lib/attribution.ts`)

    public static let countsTowardsLabel = "Counts towards"
    public static let noticedInLabel = "Noticed in"
    public static let crossingLabel = "Crossing"
    public static let blockedByLabel = "Blocked by"
    public static let evidenceOnly = "EVIDENCE ONLY"
    public static let trigger = "Trigger"
    public static let notReported = "Not reported by this server build."
    public static let attributionUnavailable = "Attribution boundary could not be loaded"
    public static let absentReason: [String: String] = [
        "FILED_UNDER_NO_PROJECT": "This task is filed under no project.",
        "NO_DISCOVERY_RECORDED": "Nothing was recorded about where this work was noticed.",
        "NO_CROSSING_DECLARED": "No declared crossing touches this task.",
        "NOTHING_BLOCKING_ATTRIBUTION": "Nothing is blocking where this work counts.",
    ]
    public static let crossingStateLabel: [String: String] = [
        "PENDING": "Waiting for your answer",
        "APPROVED": "Approved, not yet applied",
        "DENIED": "Refused",
        "APPLIED": "Applied",
    ]
    public static let crossingStateMeaning: [String: String] = [
        "PENDING": "the work is not filed anywhere until you answer",
        "APPROVED": "the writer may now file it; it has not been filed yet",
        "DENIED": "refusing is final for this crossing — file the work yourself if you change your mind",
        "APPLIED": "this answer has been spent; it authorises nothing further",
    ]

    // MARK: followed by (`WatchRelations.tsx`, `WatchEditor.tsx`)

    public static let followTask = "Follow task"
    public static let loadingWatches = "Loading watches…"
    public static let watchesUnavailable = "Couldn’t load watches."
    public static let nothingWatching = "Nothing is watching this task."
    public static func endedWatches(_ n: Int) -> String { "\(n) ended \(n == 1 ? "watch" : "watches")" }
    public static let follow = "Follow"
    public static let watchingLabel = "Watching"
    public static let waitUntilTheTask = "Wait until the task…"
    public static let thenLabel = "Then"
    public static let notifyMe = "Notify me"
    public static let stopWatchingAfter = "Stop watching after"
    public static let followDeadlineHint =
        "If the condition has not held by then, the watch expires. Pausing does not stop this clock."
    public static let following = "Following"
    public static let followMatchedAtOnce = "Already true, so the watch triggered at once"

    // MARK: runs and comments

    public static let noRuns = "No runs yet"
    public static let noComments = "No comments yet"
}

/// The two presses under a task's title: the one that concludes it on the left, the one that moves
/// it forward on the right — never three, so neither label has to break on a phone.
public struct TaskDetailActionRow: Equatable, Sendable {
    public enum Leading: Equatable, Sendable {
        /// A run of the task is waiting on the owner: go to its card (`OwnerConfirmations.PanelAction.pointer`).
        case waitingForConfirmation(sessionID: String)
        /// Confirm it from here (`OwnerConfirmations.PanelAction.confirm`).
        case confirmDone
        /// Take a stopped task back to Open (`TaskReopen.isOffered`).
        case reopen
    }

    public enum Trailing: Equatable, Sendable {
        /// A run of it is going; nil when this end knows there is one but not which.
        case openRun(sessionID: String?)
        case runNow
        case retry
        /// A row with no work of its own: what the press says it cannot do (`TaskJudgment.isGateRow`).
        case gate
    }

    public let leading: Leading?
    public let trailing: Trailing?

    public init(leading: Leading?, trailing: Trailing?) {
        self.leading = leading
        self.trailing = trailing
    }

    /// The pointer's label does not fit half a phone's width: in that one state the presses stack.
    public var stacked: Bool {
        if case .waitingForConfirmation = leading { return trailing != nil }
        return false
    }

    public var isEmpty: Bool { leading == nil && trailing == nil }
}

/// A fact in the Attribution block — or the sentence saying why there is none.
public struct TaskAttributionRow: Equatable, Sendable, Identifiable {
    public enum Link: Equatable, Sendable {
        case project(String)
        case task(String)
        case session(String)
    }

    public let label: String
    public let text: String
    /// True when `text` explains an absence rather than stating a fact.
    public let absent: Bool
    /// Short status words drawn as tags beside the fact (a project's status, EVIDENCE ONLY…).
    public let tags: [String]
    /// The lines under the fact, in the browser's order.
    public let notes: [String]
    public let link: Link?

    public var id: String { label }

    public init(label: String, text: String, absent: Bool = false, tags: [String] = [], notes: [String] = [],
                link: Link? = nil) {
        self.label = label
        self.text = text
        self.absent = absent
        self.tags = tags
        self.notes = notes
        self.link = link
    }
}

/// One row of the dependency list: a task of the component, how it relates to its neighbours, and
/// whether it is one of the focus's direct prerequisites (the ones this page may remove).
public struct TaskDependencyListRow: Equatable, Sendable, Identifiable {
    public let node: TaskDependencyGraph.Node
    public let isFocus: Bool
    public let relationships: String
    public let removable: Bool
    public var id: String { node.id }
}

/// The acceptance block as the editor holds it: text in every field, because all three are typed.
public struct TaskAcceptanceDraft: Equatable, Sendable {
    public var criteria: String
    public var command: String
    public var exitCode: String

    public init(criteria: String = "", command: String = "", exitCode: String = "") {
        self.criteria = criteria
        self.command = command
        self.exitCode = exitCode
    }

    /// `acceptanceDraftFrom`: the stored fields as the editor starts from them.
    public init(task: TaskItem?) {
        criteria = task?.acceptanceCriteria ?? ""
        command = task?.acceptanceCommand ?? ""
        exitCode = task?.acceptanceExpectedExitCode.map(String.init) ?? ""
    }

    /// `acceptanceProblem`: nil when the draft can be saved as it stands.
    public var problem: String? {
        let command = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let exit = exitCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if command.isEmpty && exit.isEmpty { return nil }
        if command.isEmpty || exit.isEmpty { return TaskDetailCopy.acceptancePairIncomplete }
        return Self.isWholeNumber(exit) ? nil : TaskDetailCopy.acceptanceExitCodeNotAnInteger
    }

    /// `acceptanceChanged`.
    public func changed(from current: TaskAcceptanceDraft) -> Bool {
        trimmed(criteria) != trimmed(current.criteria) || !samePair(current)
    }

    /// `canSaveAcceptance`.
    public func canSave(over current: TaskAcceptanceDraft) -> Bool {
        changed(from: current) && problem == nil
    }

    /// `acceptancePatch`: only the fields that moved. Blank is not a value — it clears, the way the
    /// server normalizes a project's goal — and the command with its exit code go together.
    public func patch(over current: TaskAcceptanceDraft) -> UpdateTaskRequest {
        var request = UpdateTaskRequest()
        if trimmed(criteria) != trimmed(current.criteria) {
            request.acceptanceCriteria = Self.blankToNull(criteria).map { .set($0) } ?? .clear
        }
        if !samePair(current) {
            if let command = Self.blankToNull(command) {
                request.acceptanceCommand = .set(command)
                request.acceptanceExpectedExitCode = Int(trimmed(exitCode)).map { .set($0) } ?? .clear
            } else {
                request.acceptanceCommand = .clear
                request.acceptanceExpectedExitCode = .clear
            }
        }
        return request
    }

    private func samePair(_ other: TaskAcceptanceDraft) -> Bool {
        trimmed(command) == trimmed(other.command) && trimmed(exitCode) == trimmed(other.exitCode)
    }

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// `blankToNull`: the value as typed, or nil when nothing but whitespace was.
    public static func blankToNull(_ value: String) -> String? {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
    }

    static func isWholeNumber(_ s: String) -> Bool {
        let digits = s.hasPrefix("-") ? s.dropFirst() : Substring(s)
        return !digits.isEmpty && digits.allSatisfy { $0.isASCII && $0.isNumber }
    }
}

/// The rules the page draws by. Pure: every input is passed in, so each is testable on Linux.
public enum TaskDetailLogic {
    // MARK: actions

    /// The action row from the verdicts the page already reads: what the owner's confirmation offers,
    /// whether the task can be reopened, whether it is a gate row, and the entry its live run gives.
    public static func actionRow(owner: OwnerConfirmations.PanelAction?, reopenable: Bool, status: TaskStatus,
                                 gate: Bool, entry: TaskRunHandoff.Entry) -> TaskDetailActionRow {
        let leading: TaskDetailActionRow.Leading?
        switch owner {
        case .pointer(let sessionId): leading = .waitingForConfirmation(sessionID: sessionId)
        case .confirm: leading = .confirmDone
        case nil: leading = reopenable ? .reopen : nil
        }
        let trailing: TaskDetailActionRow.Trailing?
        if status == .done {
            trailing = nil
        } else if !gate, entry.kind == .openRun {
            trailing = .openRun(sessionID: entry.sessionID)
        } else if gate {
            trailing = .gate
        } else {
            trailing = entry.kind == .retry ? .retry : .runNow
        }
        return TaskDetailActionRow(leading: leading, trailing: trailing)
    }

    // MARK: details

    /// The one line under the Details card: who made the task and when (the web's `Created by` and
    /// `Created` rows).
    public static func createdFootnote(creatorName: String?, createdAt: String?,
                                       timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        let when = createdAt.flatMap { formatted($0, timeZone: timeZone, locale: locale) }
        let who = creatorName.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        switch (who, when) {
        case let (who?, when?): return "\(TaskDetailCopy.createdByLabel) \(who) · \(when)"
        case let (who?, nil): return "\(TaskDetailCopy.createdByLabel) \(who)"
        case let (nil, when?): return "\(TaskDetailCopy.createdLabel) \(when)"
        case (nil, nil): return nil
        }
    }

    /// The scheduled start as the reader reads it (`scheduledStart`), or nil when there is none or
    /// it cannot be read.
    public static func scheduledLocal(_ runAt: String?, timeZone: TimeZone = .current,
                                      locale: Locale = .current) -> String? {
        runAt.flatMap { formatted($0, timeZone: timeZone, locale: locale) }
    }

    /// The Start at row's value: the start, or `Not set`.
    public static func scheduleValue(_ runAt: String?, timeZone: TimeZone = .current,
                                     locale: Locale = .current) -> String {
        guard let runAt, !runAt.isEmpty else { return TaskDetailCopy.scheduleNotSet }
        return scheduledLocal(runAt, timeZone: timeZone, locale: locale) ?? runAt
    }

    /// The three things a start control cannot say for itself (`TaskScheduleFields`' hint).
    public static func scheduleHint(_ runAt: String?, timeZone: TimeZone = .current,
                                    locale: Locale = .current) -> String {
        guard let runAt, !runAt.isEmpty else { return TaskDetailCopy.scheduleHintUnscheduled }
        guard let local = scheduledLocal(runAt, timeZone: timeZone, locale: locale) else {
            return TaskDetailCopy.scheduleHintUnreadable
        }
        return TaskDetailCopy.scheduleHint(startingOn: local)
    }

    /// The instant a picked date is sent as.
    public static func runAtISO(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// The browser's `toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric',
    /// minute: '2-digit' })` — "Sep 26, 4:48 AM". The day and the time are formatted apart and
    /// joined the browser's way: ICU's combined pattern says "Sep 26 at 4:48 AM" instead.
    static func formatted(_ iso: String, timeZone: TimeZone, locale: Locale) -> String? {
        guard let date = RelativeTime.parse(iso) else { return nil }
        func format(_ template: String) -> String {
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.timeZone = timeZone
            formatter.setLocalizedDateFormatFromTemplate(template)
            return formatter.string(from: date)
        }
        return "\(format("MMMd")), \(format("jmm"))"
    }

    // MARK: dependencies

    /// The component the page draws: the one read from the server, or — until it arrives, or when it
    /// could not be — the task's direct edges alone (`buildDirectTaskDependencyGraph`).
    public static func dependencyGraph(for task: TaskItem, loaded: TaskDependencyGraph?) -> TaskDependencyGraph {
        if let loaded, loaded.focusTaskId == task.id || PublicID.storageKey(loaded.focusTaskId) == PublicID.storageKey(task.id) {
            return loaded
        }
        let focus = TaskDependencyGraph.Node(id: task.id, title: task.title, status: task.status.rawValue, depth: 0)
        let prerequisites = (task.dependsOn ?? []).compactMap(\.dependsOnTask)
        let dependents = (task.dependedOnBy ?? []).compactMap(\.task)
        var nodes = [focus]
        var edges: [TaskDependencyGraph.Edge] = []
        for ref in prerequisites {
            nodes.append(TaskDependencyGraph.Node(id: ref.id, title: ref.title ?? ref.id,
                                                  status: ref.status?.rawValue ?? "OPEN", depth: 1))
            edges.append(TaskDependencyGraph.Edge(sourceTaskId: ref.id, targetTaskId: task.id))
        }
        for ref in dependents {
            nodes.append(TaskDependencyGraph.Node(id: ref.id, title: ref.title ?? ref.id,
                                                  status: ref.status?.rawValue ?? "OPEN", depth: 1))
            edges.append(TaskDependencyGraph.Edge(sourceTaskId: task.id, targetTaskId: ref.id))
        }
        return TaskDependencyGraph(focusTaskId: task.id, nodes: nodes, edges: edges)
    }

    /// Whether the task has any dependency at all (`hasDependencyRelations`).
    public static func hasDependencies(_ task: TaskItem) -> Bool {
        !(task.dependsOn ?? []).isEmpty || !(task.dependedOnBy ?? []).isEmpty
    }

    /// The section head's count line, or nil when there is nothing to count.
    public static func dependencySummary(for task: TaskItem, graph: TaskDependencyGraph) -> String? {
        guard hasDependencies(task) else { return nil }
        let prerequisites = (task.dependsOn ?? []).count
        let dependents = (task.dependedOnBy ?? []).count
        return TaskDetailCopy.dependencySummary(connected: max(graph.nodes.count - 1, 0), loaded: graph.truncated,
                                                upstream: graph.counts?.upstream ?? prerequisites,
                                                downstream: graph.counts?.downstream ?? dependents)
    }

    /// The notice a blocked task carries above its dependencies; `failed` draws it red.
    public static func blockedNotice(for task: TaskItem) -> (text: String, failed: Bool)? {
        let state = task.dependencyState ?? "NONE"
        guard state == "BLOCKED" || state == "BLOCKED_FAILED" else { return nil }
        let prerequisites = (task.dependsOn ?? []).compactMap(\.dependsOnTask)
        if state == "BLOCKED_FAILED" {
            let failed = prerequisites.filter { $0.status == .failed || $0.status == .cancelled }.count
            return (TaskDetailCopy.failedPrerequisites(failed), true)
        }
        let done = prerequisites.filter { $0.status == .done }.count
        return (TaskDetailCopy.completedPrerequisites(done, of: prerequisites.count), false)
    }

    /// Graph when the component has an edge, the list otherwise (`dependencyView`'s default).
    public static func prefersGraph(_ graph: TaskDependencyGraph) -> Bool { !graph.edges.isEmpty }

    /// The component as list rows, in the order the server gave them (`TaskDependencyList`).
    public static func dependencyRows(_ graph: TaskDependencyGraph) -> [TaskDependencyListRow] {
        let titles = Dictionary(graph.nodes.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
        var incoming: [String: [String]] = [:]
        var outgoing: [String: [String]] = [:]
        for edge in graph.edges {
            incoming[edge.targetTaskId, default: []].append(edge.sourceTaskId)
            outgoing[edge.sourceTaskId, default: []].append(edge.targetTaskId)
        }
        let direct = Set(incoming[graph.focusTaskId] ?? [])
        return graph.nodes.map { node in
            let prerequisites = (incoming[node.id] ?? []).compactMap { titles[$0] }.joined(separator: ", ")
            let targets = (outgoing[node.id] ?? []).compactMap { titles[$0] }.joined(separator: ", ")
            let relationships = [
                prerequisites.isEmpty ? "" : "Depends on \(prerequisites)",
                targets.isEmpty ? "" : "Required by \(targets)",
            ].filter { !$0.isEmpty }.joined(separator: " · ")
            let isFocus = node.id == graph.focusTaskId
            return TaskDependencyListRow(node: node, isFocus: isFocus,
                                         relationships: relationships.isEmpty
                                            ? TaskDetailCopy.noAdjacentRelationships : relationships,
                                         removable: !isFocus && direct.contains(node.id))
        }
    }

    /// The component in the project graph's terms, so the page draws it with the same layout and
    /// the same marks: every task a mark of its own — nothing folds around the task being read.
    public static func graphMarks(_ graph: TaskDependencyGraph) -> (marks: [ProjectGraphMark], edges: [ProjectGraphEdge]) {
        let marks = graph.nodes.map { node in
            ProjectGraphMark(kind: .task, id: node.id, title: node.title, taskId: node.id, status: node.status,
                             running: node.running, queued: node.queued)
        }
        let ids = Set(graph.nodes.map(\.id))
        let edges = graph.edges
            .filter { ids.contains($0.sourceTaskId) && ids.contains($0.targetTaskId) }
            .map { ProjectGraphEdge(sourceMarkId: $0.sourceTaskId, targetMarkId: $0.targetTaskId) }
        return (marks, edges)
    }

    /// Why the drawing may not be the whole component (`taskDependencyGraphTruncationState`).
    public static func truncationNotice(_ graph: TaskDependencyGraph) -> String? {
        let remaining = graph.collapsedGroups.filter { $0.hiddenCount > 0 }
        if remaining.contains(where: { ($0.cursor ?? "").isEmpty == false }) {
            return TaskDetailCopy.graphSnapshotLimit(maxDepth: graph.limits?.maxDepth,
                                                     maxNodes: graph.limits?.maxNodes,
                                                     maxEdges: graph.limits?.maxEdges)
        }
        if !remaining.isEmpty || graph.truncatedEdges { return TaskDetailCopy.graphLimitReached }
        return nil
    }

    // MARK: long text

    /// Whether a description or a comment is drawn folded, with `Show more` under it. Decided from
    /// the text, not from a measured height: a list row that measures itself to decide its own
    /// height is the self-sizing loop the transcript once froze on.
    public static func folds(_ text: String, lines: Int = 10, characters: Int = 600) -> Bool {
        text.count > characters || text.split(separator: "\n", omittingEmptySubsequences: false).count > lines
    }

    // MARK: inputs

    /// The browser's `humanSize`.
    public static func humanSize(_ bytes: Int) -> String {
        if bytes >= 1024 * 1024 { return String(format: "%.1f MB", Double(bytes) / (1024 * 1024)) }
        if bytes >= 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
        return "\(bytes) B"
    }

    // MARK: attribution

    /// The four facts, in the browser's order, each the way `TaskAttributionBody` reads it.
    public static func attributionRows(_ view: TaskAttribution) -> [TaskAttributionRow] {
        [countsTowards(view), noticedIn(view), crossing(view), blockedBy(view)]
    }

    static func absent(_ label: String, _ reason: String?) -> TaskAttributionRow {
        let text = reason.map { TaskDetailCopy.absentReason[$0] ?? $0 } ?? TaskDetailCopy.notReported
        return TaskAttributionRow(label: label, text: text, absent: true)
    }

    static func countsTowards(_ view: TaskAttribution) -> TaskAttributionRow {
        guard let owning = view.owning else { return absent(TaskDetailCopy.countsTowardsLabel, view.owningAbsentReason) }
        return TaskAttributionRow(label: TaskDetailCopy.countsTowardsLabel, text: owning.title, tags: [owning.status],
                                  link: .project(owning.projectId))
    }

    static func noticedIn(_ view: TaskAttribution) -> TaskAttributionRow {
        let discovery = view.discovery
        guard discovery.recorded else { return absent(TaskDetailCopy.noticedInLabel, discovery.absentReason) }
        var lines: [String] = []
        if let project = discovery.project { lines.append(project.title) }
        if let trigger = discovery.triggerEvent { lines.append("\(TaskDetailCopy.trigger) \(trigger)") }
        if let task = discovery.task { lines.append("Task: \(task.title)") }
        if let session = discovery.session { lines.append("Session: \(session.title ?? "untitled")") }
        let tag = discovery.authority == "EVIDENCE_ONLY" ? TaskDetailCopy.evidenceOnly : discovery.authority
        let link: TaskAttributionRow.Link? = discovery.session.map { .session($0.sessionId) }
            ?? discovery.task.map { .task($0.taskId) }
            ?? discovery.project.map { .project($0.projectId) }
        return TaskAttributionRow(label: TaskDetailCopy.noticedInLabel, text: lines.first ?? tag,
                                  tags: [tag], notes: Array(lines.dropFirst()), link: link)
    }

    static func crossing(_ view: TaskAttribution) -> TaskAttributionRow {
        guard let crossing = view.crossing else { return absent(TaskDetailCopy.crossingLabel, view.crossingAbsentReason) }
        var notes: [String] = []
        if let meaning = TaskDetailCopy.crossingStateMeaning[crossing.state] { notes.append(meaning) }
        if let from = crossing.from, let to = crossing.to { notes.append("\(from.title) → \(to.title)") }
        if let code = crossing.code { notes.append([code, crossing.requiredAction].compactMap { $0 }.joined(separator: " ")) }
        return TaskAttributionRow(label: TaskDetailCopy.crossingLabel,
                                  text: TaskDetailCopy.crossingStateLabel[crossing.state] ?? crossing.state,
                                  tags: [crossing.state], notes: notes)
    }

    static func blockedBy(_ view: TaskAttribution, timeZone: TimeZone = .current,
                          locale: Locale = .current) -> TaskAttributionRow {
        guard let blocker = view.blocker else { return absent(TaskDetailCopy.blockedByLabel, view.blockerAbsentReason) }
        var notes = ["\(blocker.code ?? "UNKNOWN") · owner \(blocker.owner)"]
        if let when = formatted(blocker.nextCheckAt, timeZone: timeZone, locale: locale) {
            notes.append("Next checked \(when)")
        }
        return TaskAttributionRow(label: TaskDetailCopy.blockedByLabel, text: blocker.requiredAction,
                                  tags: [blocker.kind], notes: notes)
    }

    // MARK: followed by

    /// The watches that name this task (`watchesFollowedBy`), live ones to list and how many ended.
    public static func followers(of taskID: String, in watches: [Watch]) -> (live: [Watch], ended: Int) {
        let key = PublicID.storageKey(taskID)
        let related = watches.filter { watch in
            watch.targets.contains { $0.targetKind == .task && PublicID.storageKey($0.targetResourceId) == key }
        }
        let live = related.filter { WatchStateMachine.isLive($0.state) }
        return (live, related.count - live.count)
    }

    /// The conditions Follow offers over one task, the web's default (`TASK_TERMINAL`) first.
    public static var followConditions: [WatchPredicate] { WatchEditing.conditions(for: .task) }

    /// The deadlines Follow offers (the web's `TTL_CHOICES`), and the one it starts on.
    public static var followDeadlines: [Int] { WatchEditing.deadlineChoices }
    public static var defaultFollowDeadline: Int { WatchLimits.defaultTtlSeconds }

    /// What the toast says once a Follow went through.
    public static func followedToast(_ watch: Watch) -> String {
        watch.state == .matched ? TaskDetailCopy.followMatchedAtOnce : TaskDetailCopy.following
    }
}
