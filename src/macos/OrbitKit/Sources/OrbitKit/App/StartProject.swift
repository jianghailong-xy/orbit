import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   "START THIS PROJECT?" — THIS CLIENT'S HALF OF WEB'S `StartProjectCard.tsx` AND
   `lib/projectStart.ts`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   ASKED, NEVER INFERRED
   ---------------------
   A project nobody has started is asked about once its coordinator has asked
   (`project_request_start`) and the plan passed Orbit's ready check — the open `START_REQUEST` item,
   which the open-items read serves beside the project's other items
   (`ProjectOpenItemsView.startRequest`). The card used to be inferred from a project holding one
   task, and arrived in the middle of a coordinator still deciding how to split the work. A request
   whose plan moved is superseded by the server on that same read, so a card is never drawn for a
   plan that is no longer there.

   ONE PRESS, ONE WRITE
   --------------------
   Start sends `POST /projects/:id/start` (`StartProjectRequestBody`): the seal of the criteria the
   coordinator asked about — which the card only offers while it is the seal standing now, so it is
   also the version on screen — and every setting as the card shows it. The settings arrive as the
   coordinator suggested them and are the owner's to change on the card; what changed is the
   server's to record (`differsFromRequest`), against the request the press names. A seal that
   moved, or a project started at another end, is a 409 that writes nothing.

   EVERY WORD IS THE BROWSER'S
   ---------------------------
   `lib/projectStart.ts` declares each sentence of the start card, of How it runs and of the settings
   line once, and `StartProjectCardCopyParityTests` reads that file back: the two clients share no
   compiler, so a sentence re-worded at one end only turns nothing else red. The derivations — the
   plan's order in one line, the ready check's warnings in the owner's words, the body a press
   sends — are ports of the same file's functions, held to the browser's own examples by
   `StartProjectTests`.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire

/// How a project runs, as a start sets it — `@orbit/shared`'s `ProjectStartSettings`.
///
/// - `line` — where its finished tasks land: its own branch first, or straight on its upstream.
/// - `projectBranchName` — the project branch as a full `refs/heads/…` ref, only with a project
///   branch. Absent on a request means `refs/heads/project/<project id>`, or the branch the project
///   already names.
/// - `automatic` — `project.coordinator_enabled`: the coordinator runs the project for the owner.
/// - `maxConcurrentTasks` — how many of its tasks may be in flight at once.
/// - `mergeCheckCommand` — the check run on the combined tree before anything lands; nil for none.
public struct ProjectStartSettings: Codable, Equatable, Sendable {
    public let line: IntegrationLine
    public let projectBranchName: String?
    public let automatic: Bool
    public let maxConcurrentTasks: Int
    public let mergeCheckCommand: String?

    public init(line: IntegrationLine, projectBranchName: String? = nil, automatic: Bool,
                maxConcurrentTasks: Int, mergeCheckCommand: String? = nil) {
        self.line = line
        self.projectBranchName = projectBranchName
        self.automatic = automatic
        self.maxConcurrentTasks = maxConcurrentTasks
        self.mergeCheckCommand = mergeCheckCommand
    }

    /// Decoded by hand so that settings naming a line this build does not know are NOT settings:
    /// the caller reads them with `try?` and draws nothing for them, the way web's `settingsOf`
    /// leaves them off whole rather than drawing half of them.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        line = try c.decode(IntegrationLine.self, forKey: .line)
        guard line != .unknown else {
            throw DecodingError.dataCorruptedError(forKey: .line, in: c,
                                                   debugDescription: "a line this build does not know")
        }
        projectBranchName = try c.decodeIfPresent(String.self, forKey: .projectBranchName)
        automatic = try c.decode(Bool.self, forKey: .automatic)
        maxConcurrentTasks = try c.decode(Int.self, forKey: .maxConcurrentTasks)
        guard maxConcurrentTasks >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .maxConcurrentTasks, in: c,
                                                   debugDescription: "a negative count")
        }
        mergeCheckCommand = try c.decodeIfPresent(String.self, forKey: .mergeCheckCommand)
    }

    /// The same reading for a payload carried as JSON rather than decoded — the `projectStarted`
    /// card's `settings` (`ProjectStarted.parseCard`). Nil for anything that is not whole settings.
    public static func parse(_ value: JSONValue?) -> ProjectStartSettings? {
        guard case .object(let settings)? = value,
              let raw = settings["line"]?.stringValue,
              let line = IntegrationLine(rawValue: raw), line != .unknown,
              case .bool(let automatic)? = settings["automatic"],
              let count = settings["maxConcurrentTasks"]?.intValue, count >= 0 else { return nil }
        let check: String?
        switch settings["mergeCheckCommand"] {
        case .string(let command)?: check = command
        case .null?, nil: check = nil
        default: return nil
        }
        return ProjectStartSettings(line: line,
                                    projectBranchName: settings["projectBranchName"]?.stringValue,
                                    automatic: automatic, maxConcurrentTasks: count,
                                    mergeCheckCommand: check)
    }
}

/// One of the settings above, as a difference names it. `line` covers the branch name too.
/// `CaseIterable` in card order, which is the order every list of them is drawn in.
public enum ProjectStartSettingKey: String, Codable, CaseIterable, Sendable {
    case line
    case automatic
    case maxConcurrentTasks
    case mergeCheckCommand

    /// The keys a payload names, in card order, and none it does not know: a key this build has no
    /// words for is not a difference it can point at.
    public static func known(_ raw: [String]) -> [ProjectStartSettingKey] {
        allCases.filter { raw.contains($0.rawValue) }
    }
}

/// What a start left behind, beside the confirmation it wrote: the settings as they stand after it,
/// and which of them are not what the start was asked for — `@orbit/shared`'s `ProjectStartRecord`,
/// which the confirmation read serves as `startedWith`.
public struct ProjectStartRecord: Codable, Equatable, Sendable {
    public let settings: ProjectStartSettings
    public let differsFromRequest: [ProjectStartSettingKey]

    public init(settings: ProjectStartSettings, differsFromRequest: [ProjectStartSettingKey] = []) {
        self.settings = settings
        self.differsFromRequest = differsFromRequest
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(ProjectStartSettings.self, forKey: .settings)
        differsFromRequest = ProjectStartSettingKey.known(
            (try? c.decodeIfPresent([String].self, forKey: .differsFromRequest)) ?? [])
    }
}

/// One finding of the ready check a start request went through. The card reads the warnings: what
/// the owner should know before pressing Start.
public struct ProjectStartFinding: Codable, Equatable, Sendable {
    /// A task a finding is about.
    public struct Task: Codable, Equatable, Sendable {
        public let taskId: String
        public let title: String

        public init(taskId: String, title: String) {
            self.taskId = taskId
            self.title = title
        }
    }

    /// `REFUSE` or `WARN`. Only warnings are filed with a request.
    public let severity: String
    public let code: String
    /// The server's own sentence, which is what a code this build does not know is said in.
    public let message: String
    public let tasks: [Task]

    public init(severity: String = "WARN", code: String, message: String, tasks: [Task] = []) {
        self.severity = severity
        self.code = code
        self.message = message
        self.tasks = tasks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        severity = try c.decodeIfPresent(String.self, forKey: .severity) ?? ""
        code = try c.decodeIfPresent(String.self, forKey: .code) ?? ""
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        tasks = (try? c.decodeIfPresent([Task].self, forKey: .tasks)) ?? []
    }
}

/// A coordinator's request to start its project, as it is filed: the `START_REQUEST` open item's
/// payload (`ProjectOpenItemRow.startRequest`), and what the card is drawn from.
///
/// `criteriaDigest` is the seal of the criteria the request was made about — the one a press
/// confirms. `planDigest` says which plan it was about; a request whose plan moved is superseded by
/// the server and no longer served.
public struct ProjectStartRequest: Codable, Equatable, Sendable {
    public let settings: ProjectStartSettings
    public let why: String
    public let criteriaDigest: String
    public let planDigest: String
    /// The repository the check found the project integrating into, or nil for a project with none.
    public let repository: String?
    /// The check's warnings: what the owner should know before pressing Start.
    public let warnings: [ProjectStartFinding]

    public init(settings: ProjectStartSettings, why: String = "", criteriaDigest: String,
                planDigest: String = "", repository: String? = nil,
                warnings: [ProjectStartFinding] = []) {
        self.settings = settings
        self.why = why
        self.criteriaDigest = criteriaDigest
        self.planDigest = planDigest
        self.repository = repository
        self.warnings = warnings
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(ProjectStartSettings.self, forKey: .settings)
        why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
        criteriaDigest = try c.decode(String.self, forKey: .criteriaDigest)
        planDigest = try c.decodeIfPresent(String.self, forKey: .planDigest) ?? ""
        repository = try c.decodeIfPresent(String.self, forKey: .repository)
        warnings = (try? c.decodeIfPresent([ProjectStartFinding].self, forKey: .warnings)) ?? []
    }
}

/// The body of `POST /projects/:id/start`: the version of the criteria the owner read, and the
/// settings on the card. Encoded by hand because the door is exact about absence: the branch name
/// rides only with a project branch (it refuses one on a line that has none), while the merge check
/// and the request are sent either way, null when there is none.
public struct StartProjectRequestBody: Encodable, Equatable, Sendable {
    public let criteriaDigest: String
    public let line: IntegrationLine
    public let projectBranchName: String?
    public let automatic: Bool
    public let maxConcurrentTasks: Int
    public let mergeCheckCommand: String?
    public let requestId: String?

    public init(criteriaDigest: String, line: IntegrationLine, projectBranchName: String? = nil,
                automatic: Bool, maxConcurrentTasks: Int, mergeCheckCommand: String? = nil,
                requestId: String? = nil) {
        self.criteriaDigest = criteriaDigest
        self.line = line
        self.projectBranchName = projectBranchName
        self.automatic = automatic
        self.maxConcurrentTasks = maxConcurrentTasks
        self.mergeCheckCommand = mergeCheckCommand
        self.requestId = requestId
    }

    enum CodingKeys: String, CodingKey {
        case criteriaDigest, line, projectBranchName, automatic, maxConcurrentTasks
        case mergeCheckCommand, requestId
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(criteriaDigest, forKey: .criteriaDigest)
        try c.encode(line, forKey: .line)
        try c.encodeIfPresent(projectBranchName, forKey: .projectBranchName)
        try c.encode(automatic, forKey: .automatic)
        try c.encode(maxConcurrentTasks, forKey: .maxConcurrentTasks)
        if let mergeCheckCommand {
            try c.encode(mergeCheckCommand, forKey: .mergeCheckCommand)
        } else {
            try c.encodeNil(forKey: .mergeCheckCommand)
        }
        if let requestId {
            try c.encode(requestId, forKey: .requestId)
        } else {
            try c.encodeNil(forKey: .requestId)
        }
    }
}

// MARK: - the words: the start card

public enum StartProject {

    /// The card's question, and the heading of the open item that asks it.
    public static let title = "Start this project?"
    /// Who asked, as the meta line says it.
    public static let askedByCoordinator = "asked by the coordinator"
    /// What a session row, its header and the pinned strip say while the card is waiting.
    public static let readyToStart = "Ready to start"
    public static let doneWhen = "Done when"
    public static let plan = "Plan"
    public static let howItRuns = "How it runs"
    public static let suggestedByCoordinator = "suggested by the coordinator"
    /// The link beside the plan's order, to the tasks it names.
    public static let viewTasks = "View tasks ›"
    public static let action = "Start the project"
    /// What the armed composer asks for, once "Chat about this" has handed the reply to it.
    public static let chatPlaceholder = "What should change before it starts?"
    /// What the ready check looked at, before the list of what it found true.
    public static let checkedPlan = "Orbit checked the plan:"
    public static let checkedCriteria = "every criterion has a task serving it"
    public static let checkedRunners = "every task has a runner"
    /// What a press the door did not take says, over the door's own message.
    public static let notRecorded = "That start was not recorded"
    /// Why Start is dead on a card whose request no longer stands.
    public static let requestGone =
        "The plan changed after the coordinator asked, so this request no longer stands. Orbit "
        + "shows the card again when the coordinator asks to start the new plan."

    /// The most tasks a project may run at once, as the door bounds it
    /// (web's `START_MAX_CONCURRENT_TASKS`, the server's `MAX_PROJECT_CONCURRENT_TASKS`).
    public static let maxConcurrentTasks = 100

    /// The sections' own heads, with how many there are: "Done when · 4 criteria".
    public static func doneWhenHead(_ count: Int) -> String {
        "\(doneWhen) · \(count) \(count == 1 ? "criterion" : "criteria")"
    }

    /// "Plan · 5 tasks".
    public static func planHead(_ count: Int) -> String {
        "\(plan) · \(count) \(count == 1 ? "task" : "tasks")"
    }

    /// Which project, who asked and when, and the seal a press confirms — the version is last
    /// because it is what a reader needs only once they have read the rest. `askedAgo` is nil for a
    /// card no coordinator asked for; how long ago is the platform's own clock words
    /// (`RelativeTime.format`), as the browser's is its own.
    public static func meta(projectTitle: String, askedAgo: String?, seal: String) -> String {
        let asked = askedAgo.map { " · \(askedByCoordinator) · \($0)" } ?? ""
        return "\(projectTitle)\(asked) · seal \(seal)"
    }

    /// The one paragraph the card keeps: what starting binds the project to, and what happens when
    /// the criteria move later — it asks again, and nothing stops.
    public static func explanation(_ count: Int) -> String {
        "Orbit derives done from these \(count) criteria and nothing else. If they change later, it "
            + "asks you to confirm the new version — the project keeps running."
    }

    /// What the ready check found true, in the order it checks: served, runnable, and the repository
    /// the project integrates into when it has one.
    public static func checkedLine(repository: String?) -> String {
        var found = [checkedCriteria, checkedRunners]
        if let repository, !repository.isEmpty {
            found.append("repository \(repositoryLabel(repository))")
        }
        return "\(checkedPlan) \(found.joined(separator: " · "))"
    }

    /// What the coordinator said about the plan, as the card quotes it under the settings.
    public static func coordinatorSays(_ why: String) -> String {
        "Coordinator: “\(why)”"
    }

    /// A repository as a reader names it: `owner/repo` out of whatever URL the binding holds.
    public static func repositoryLabel(_ url: String) -> String {
        var path = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasSuffix(".git") { path = String(path.dropLast(4)) }
        while path.hasSuffix("/") { path = String(path.dropLast()) }
        let parts = path.split(whereSeparator: { $0 == "/" || $0 == ":" }).map(String.init)
        return parts.count >= 2 ? "\(parts[parts.count - 2])/\(parts[parts.count - 1])" : path
    }

    // MARK: the plan, in one line

    /// What the order line calls a task: the marker its title opens with — "A · …", "① 服务端 · …",
    /// "3) …", "B：…", "P1 Web：…" — and otherwise the title itself, cut short. A plan is written
    /// with those markers when its tasks are meant to be named by them, and a title with none is
    /// named whole.
    public static func planTaskLabel(_ title: String) -> String {
        let text = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let scalars = Array(text.unicodeScalars)
        if let first = scalars.first,
           (0x2460...0x2473).contains(first.value) || (0x2776...0x277F).contains(first.value) {
            return String(Character(first))
        }
        if let marker = leadingMarker(scalars) { return marker }
        if let code = leadingCode(scalars) { return code }
        guard scalars.count > 24 else { return text }
        var cut = String.UnicodeScalarView()
        cut.append(contentsOf: scalars.prefix(23))
        return String(cut) + "…"
    }

    /// One ASCII letter or one or two digits, followed at once by `.`, `)`, `:` or `：`, or by
    /// spaces and then one of `· - – — : ： |` standing on its own — the browser's
    /// `/^([A-Za-z]|\d{1,2})(?:[.):：]|\s+[·\-–—:：|](?:\s|$))/u`, spelled out.
    private static func leadingMarker(_ s: [Unicode.Scalar]) -> String? {
        guard let first = s.first else { return nil }
        let lengths: [Int]
        if first.isASCII, first.properties.isAlphabetic {
            lengths = [1]
        } else if isDigit(first) {
            lengths = s.count > 1 && isDigit(s[1]) ? [2, 1] : [1]
        } else {
            return nil
        }
        for length in lengths where separatorFollows(s, at: length) {
            var marker = String.UnicodeScalarView()
            marker.append(contentsOf: s[0..<length])
            return String(marker)
        }
        return nil
    }

    /// A capital and one or two digits — "P1", "D12" — followed at once by `.`, `)`, `:`, `：` or a
    /// space: a code rather than a word, so a space is separator enough — the browser's
    /// `/^([A-Z]\d{1,2})(?:[.):：]|\s)/u`, spelled out.
    private static func leadingCode(_ s: [Unicode.Scalar]) -> String? {
        guard s.count > 2, ("A"..."Z").contains(s[0]), isDigit(s[1]) else { return nil }
        let length = isDigit(s[2]) ? 3 : 2
        guard length < s.count,
              ".):：".unicodeScalars.contains(s[length]) || s[length].properties.isWhitespace
        else { return nil }
        var code = String.UnicodeScalarView()
        code.append(contentsOf: s[0..<length])
        return String(code)
    }

    private static func isDigit(_ scalar: Unicode.Scalar) -> Bool {
        ("0"..."9").contains(scalar)
    }

    private static func separatorFollows(_ s: [Unicode.Scalar], at p: Int) -> Bool {
        guard p < s.count else { return false }
        if ".):：".unicodeScalars.contains(s[p]) { return true }
        var q = p
        while q < s.count, s[q].properties.isWhitespace { q += 1 }
        guard q > p, q < s.count, "·-–—:：|".unicodeScalars.contains(s[q]) else { return false }
        return q + 1 == s.count || s[q + 1].properties.isWhitespace
    }

    /// "A, B and C".
    static func joinAnd(_ words: [String]) -> String {
        guard words.count > 1 else { return words.first ?? "" }
        return "\(words.dropLast().joined(separator: ", ")) and \(words[words.count - 1])"
    }

    /// The plan's order in one line — "A starts now · B, C after A · D after B · E after C and D":
    /// the tasks that wait on the same prerequisites said together, in the order they can run, each
    /// group after everything it waits on. Tasks are given oldest first, which is the order within a
    /// step; an edge to a task outside `tasks` (settled work, another project) waits on nothing here.
    public static func planOrderLine(_ tasks: [StartPlanTask]) -> String {
        var index: [String: Int] = [:]
        var label: [String: String] = [:]
        for (at, task) in tasks.enumerated() {
            index[task.id] = at
            label[task.id] = planTaskLabel(task.title)
        }
        var prerequisites: [String: [String]] = [:]
        for task in tasks {
            var seen = Set<String>()
            let unique = task.after.filter { seen.insert($0).inserted }
            prerequisites[task.id] = unique
                .filter { index[$0] != nil && $0 != task.id }
                .sorted { index[$0]! < index[$1]! }
        }
        // How far down the plan each task sits: one step after the furthest of what it waits on. A
        // cycle the server would never have allowed is cut rather than followed.
        var level: [String: Int] = [:]
        func depth(_ id: String, _ seen: inout Set<String>) -> Int {
            if let known = level[id] { return known }
            if seen.contains(id) { return 0 }
            seen.insert(id)
            var at = 0
            for each in prerequisites[id] ?? [] {
                at = max(at, 1 + depth(each, &seen))
            }
            level[id] = at
            return at
        }
        struct Group {
            var level: Int
            var order: Int
            var members: [String]
            var after: [String]
        }
        var groups: [String: Group] = [:]
        var keys: [String] = []
        for (order, task) in tasks.enumerated() {
            let after = prerequisites[task.id] ?? []
            let key = after.joined(separator: ",")
            if var group = groups[key] {
                group.members.append(task.id)
                groups[key] = group
            } else {
                var seen = Set<String>()
                groups[key] = Group(level: depth(task.id, &seen), order: order,
                                    members: [task.id], after: after)
                keys.append(key)
            }
        }
        return keys.compactMap { groups[$0] }
            .sorted { ($0.level, $0.order) < ($1.level, $1.order) }
            .map { group in
                let who = group.members.map { label[$0] ?? $0 }.joined(separator: ", ")
                if group.after.isEmpty {
                    return "\(who) \(group.members.count == 1 ? "starts" : "start") now"
                }
                return "\(who) after \(joinAnd(group.after.map { label[$0] ?? $0 }))"
            }
            .joined(separator: " · ")
    }

    /// The ready check's warnings, in the owner's words: a task set to start by hand is named by the
    /// label the order line gives it, and the merge check's warning is the row it is about rather
    /// than a line here. A code this build does not know is said in the server's own words.
    public static func warningLines(_ warnings: [ProjectStartFinding],
                                    tasks: [(id: String, title: String)]) -> [String] {
        var titles: [String: String] = [:]
        for task in tasks { titles[task.id] = task.title }
        return warnings.flatMap { finding -> [String] in
            if finding.code == "START_NO_MERGE_CHECK" { return [] }
            if finding.code == "START_TASKS_START_BY_HAND", !finding.tasks.isEmpty {
                return [byHandWarning(finding.tasks.map {
                    planTaskLabel(titles[$0.taskId] ?? $0.title)
                })]
            }
            return [finding.message]
        }
    }

    /// "B, C, D and E are set to start by hand — they wait for the coordinator even after the
    /// project starts."
    public static func byHandWarning(_ labels: [String]) -> String {
        let one = labels.count == 1
        return "\(joinAnd(labels)) \(one ? "is" : "are") set to start by hand — "
            + "\(one ? "it waits" : "they wait") for the coordinator even after the project starts."
    }

    /// The plan as the card reads it, off the project's dependency graph: the tasks nothing
    /// cancelled, their order, and the check's warnings in the order line's names. A folded graph is
    /// a plan too big for one line, and says only how many tasks it holds.
    public static func planView(graph: ProjectDependencyGraph?, request: ProjectStartRequest,
                                fallbackCount: Int) -> StartPlanView {
        // Folded is what the server says of a graph with any mark that is not a task
        // (`project-graph-fold.ts`), which is how this build reads it off the marks.
        guard let graph, !graph.truncated, !graph.marks.contains(where: { $0.kind != .task }) else {
            return StartPlanView(count: graph?.taskCount ?? fallbackCount, order: nil,
                                 warnings: warningLines(request.warnings, tasks: []))
        }
        // Unfolded, every mark is one task. Cancelled ones are not part of the plan, and settled
        // ones run nothing, so neither is given a place in the order.
        let tasks = graph.marks.filter { $0.status != "CANCELLED" }
        let planned = tasks.filter { $0.status != "DONE" }.map { mark in
            StartPlanTask(id: mark.id, title: mark.title,
                          after: graph.edges.filter { $0.targetMarkId == mark.id }.map(\.sourceMarkId))
        }
        return StartPlanView(
            count: tasks.count,
            order: planned.isEmpty ? nil : planOrderLine(planned),
            warnings: warningLines(request.warnings,
                                   tasks: tasks.map { (id: $0.taskId ?? $0.id, title: $0.title) }))
    }

    // MARK: the press

    /// The body a press sends: the seal, every setting, and the request it answers. The branch the
    /// coordinator named rides only with a project branch — the door refuses a branch name on a
    /// line that has none — and an empty merge check is none.
    public static func body(request: ProjectStartRequest, draft: StartSettingsDraft,
                            requestId: String?) -> StartProjectRequestBody {
        let branch = request.settings.projectBranchName ?? ""
        let check = draft.mergeCheckCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        return StartProjectRequestBody(
            criteriaDigest: request.criteriaDigest,
            line: draft.line,
            projectBranchName: draft.line == .projectBranch && !branch.isEmpty ? branch : nil,
            automatic: draft.automatic,
            maxConcurrentTasks: draft.maxConcurrentTasks,
            mergeCheckCommand: check.isEmpty ? nil : check,
            requestId: requestId)
    }

    /// The project branch as the first option names it: the ref the coordinator named, or the
    /// project's own default, without `refs/heads/`.
    public static func branch(_ request: ProjectStartRequest, projectID: String) -> String {
        let ref = request.settings.projectBranchName ?? "refs/heads/project/\(projectID)"
        return ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
    }

    // MARK: whether it is asked, and whether it can be answered

    /// The request this conversation is asked about right now: the project's open `START_REQUEST`,
    /// with a request this build can read, while the project has not been started. Nil otherwise —
    /// including while either read has not answered, which is not a request.
    public static func live(openItems: ProjectOpenItemsView?,
                            started: Bool?) -> ProjectOpenItemRow? {
        guard started == false, let row = openItems?.startRequest, row.startRequest != nil
        else { return nil }
        return row
    }

    /// Where the card drawn for the request `itemID` stands right now, derived from the reads and
    /// from nothing else.
    public enum Standing: Equatable, Sendable {
        /// The request is the project's open one, about the seal standing now: Start is live.
        case live
        /// The request no longer stands — replaced, withdrawn, or naming a seal the criteria have
        /// moved past — so a press would start nothing a reader agreed to.
        case gone
        /// A read has not answered, so no version can be named to start on.
        case unread
    }

    public static func standing(itemID: String, request: ProjectStartRequest,
                                openItems: ProjectOpenItemsView?,
                                confirmation: StandardSetConfirmationStanding?,
                                started: Bool?) -> Standing {
        guard openItems != nil, let confirmation, started != nil else { return .unread }
        guard let live = live(openItems: openItems, started: started), live.itemId == itemID,
              confirmation.currentVersion.digest == request.criteriaDigest else { return .gone }
        return .live
    }

    /// Why Start is dead, or nil while it is live — web's `SessionStartProjectCard` says the same
    /// two sentences for the same two facts.
    public static func staleExplanation(_ standing: Standing) -> String? {
        switch standing {
        case .live:   return nil
        case .gone:   return requestGone
        case .unread: return AcceptanceConfirmations.staleExplanation(nil)
        }
    }

    /// Whether the card is still asking — what the needs-you bar counts. A card whose request no
    /// longer stands is left on screen, dimmed, and stops being counted: pointing a reader at a card
    /// with nothing to press is worse than saying nothing. One that could not be read stays open,
    /// for `AcceptanceConfirmations.isOpen`'s reason.
    public static func isOpen(_ standing: Standing) -> Bool {
        standing != .gone
    }
}

/// One task of the plan, as the order line reads it. `after` names its prerequisites by id.
public struct StartPlanTask: Equatable, Sendable {
    public let id: String
    public let title: String
    public let after: [String]

    public init(id: String, title: String, after: [String] = []) {
        self.id = id
        self.title = title
        self.after = after
    }
}

/// The plan as the card reads it: how many tasks, their order in one line, and the warnings.
public struct StartPlanView: Equatable, Sendable {
    public let count: Int
    /// Nil when the plan is too big to say in a line (the graph came back folded).
    public let order: String?
    public let warnings: [String]

    public init(count: Int, order: String?, warnings: [String]) {
        self.count = count
        self.order = order
        self.warnings = warnings
    }
}

/// The settings as the card edits them. The count is always a number here — a Stepper has no empty
/// state — but it is still bounded by the door's own limits (`complete`).
public struct StartSettingsDraft: Equatable, Sendable {
    public var line: IntegrationLine
    public var automatic: Bool
    public var maxConcurrentTasks: Int
    public var mergeCheckCommand: String

    public init(line: IntegrationLine, automatic: Bool, maxConcurrentTasks: Int,
                mergeCheckCommand: String = "") {
        self.line = line
        self.automatic = automatic
        self.maxConcurrentTasks = maxConcurrentTasks
        self.mergeCheckCommand = mergeCheckCommand
    }

    /// The card's draft of what a suggestion says.
    public init(_ settings: ProjectStartSettings) {
        self.init(line: settings.line, automatic: settings.automatic,
                  maxConcurrentTasks: settings.maxConcurrentTasks,
                  mergeCheckCommand: settings.mergeCheckCommand ?? "")
    }

    /// Whether the draft is a set of settings the door would take: a line, and a whole number of
    /// tasks in range.
    public var complete: Bool {
        line != .unknown && (1...StartProject.maxConcurrentTasks).contains(maxConcurrentTasks)
    }

    /// Whether the merge check row is the amber one (`RunSettings.mergeCheckMissing`).
    public var mergeCheckMissing: Bool {
        RunSettings.mergeCheckMissing(line: line, automatic: automatic,
                                      mergeCheckCommand: mergeCheckCommand)
    }
}

// MARK: - the words: How it runs, and the settings a start left behind

/// How a project runs, in the words the start card uses for each setting — and the one line a
/// start's settings are said in afterwards, on its receipt and on the "Project started" card.
/// Web's `RUN_*` declarations in `lib/projectStart.ts`.
public enum RunSettings {
    public static let tasksLandOn = "Tasks land on"
    public static let lineProjectBranch = "A project branch"
    public static let lineProjectBranchHint =
        "Recommended when tasks depend on each other: they land here first and are checked together."
    public static let lineMain = "Directly into main"
    public static let lineMainHint =
        "For a single task or an urgent fix. Every merge into main asks you."
    public static let automatic = "Automatic"
    /// What Automatic means, on a project branch: the coordinator runs the project, merges included.
    public static let automaticHintProjectBranch =
        "The coordinator runs it for you: it decides when each task is done, handles conflicts and "
        + "failed checks, and merges the branch into main once the merge check passes — with a "
        + "receipt you can revert. The criteria and anything irreversible stay yours."
    /// …and directly into main, where the merging half is the one thing it never does by itself.
    public static let automaticHintMain =
        "The coordinator runs it for you: it decides when each task is done and handles conflicts "
        + "and failed checks. Merging into main always asks you — a project that lands directly on "
        + "main never merges by itself. The criteria and anything irreversible stay yours."
    public static let switchOn = "On"
    public static let switchOff = "Off"
    public static let atMost = "At most"
    public static let mergeCheck = "Merge check"
    public static let mergeCheckHint =
        "Runs on the combined tree before anything lands — on the project branch and again before "
        + "main."
    public static let mergeCheckPlaceholder = "No check — work lands once it rebases cleanly"
    /// Said under an empty merge check while Automatic would merge the branch into main unchecked.
    public static let noMergeCheckWarning =
        "No merge check: with Automatic on, the branch merges into main with nothing run on the "
        + "combined tree."

    public static let summaryMergeCheckSet = "merge check set"
    public static let summaryNoMergeCheck = "no merge check"
    /// What a setting that is not what the coordinator suggested says when it is pointed at.
    public static let settingDiffers = "Not what the coordinator suggested"

    /// The Automatic sentence for the line chosen: the merge half follows the line.
    public static func automaticHint(_ line: IntegrationLine) -> String {
        line == .main ? automaticHintMain : automaticHintProjectBranch
    }

    /// The words after the number: "At most 3 tasks at a time".
    public static func tasksAtATime(_ count: Int?) -> String {
        "\(count == 1 ? "task" : "tasks") at a time"
    }

    /// Whether the merge check row is the amber one: Automatic on a project branch with nothing to
    /// run on the combined tree before the branch merges into main — the ready check's own warning.
    public static func mergeCheckMissing(line: IntegrationLine, automatic: Bool,
                                         mergeCheckCommand: String?) -> Bool {
        automatic && line == .projectBranch
            && (mergeCheckCommand ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A project branch as a line names it: without `refs/heads/`, and `project/<id>` down to the
    /// first five characters of the id, which is how a reader tells two of them apart.
    public static func shortBranch(_ ref: String) -> String {
        let name = ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
        let prefix = "project/"
        guard name.hasPrefix(prefix) else { return name }
        let id = Array(name.dropFirst(prefix.count).unicodeScalars)
        guard id.count >= 6, !id.contains(where: { $0 == "\n" || $0 == "\r" }) else { return name }
        var head = String.UnicodeScalarView()
        head.append(contentsOf: id.prefix(5))
        return "\(prefix)\(String(head))…"
    }

    /// One setting of the one-line summary, and whether it is not what the start was asked for.
    public struct Part: Equatable, Sendable, Identifiable {
        public let key: ProjectStartSettingKey
        public let text: String
        public let differs: Bool

        public var id: String { key.rawValue }

        public init(key: ProjectStartSettingKey, text: String, differs: Bool) {
            self.key = key
            self.text = text
            self.differs = differs
        }
    }

    /// The settings a start left the project running with, in card order: the line, Automatic,
    /// concurrency and the merge check — "project/34Wvw… · Automatic on · 3 tasks at a time · merge
    /// check set".
    public static func parts(_ settings: ProjectStartSettings,
                             differs: [ProjectStartSettingKey] = []) -> [Part] {
        let tasks = settings.maxConcurrentTasks
        let line: String
        if settings.line == .main {
            line = lineMain
        } else if let branch = settings.projectBranchName, !branch.isEmpty {
            line = shortBranch(branch)
        } else {
            line = lineProjectBranch
        }
        let check = (settings.mergeCheckCommand ?? "").isEmpty ? summaryNoMergeCheck
                                                               : summaryMergeCheckSet
        return [
            Part(key: .line, text: line, differs: differs.contains(.line)),
            Part(key: .automatic, text: "\(automatic) \(settings.automatic ? "on" : "off")",
                 differs: differs.contains(.automatic)),
            Part(key: .maxConcurrentTasks, text: "\(tasks) \(tasksAtATime(tasks))",
                 differs: differs.contains(.maxConcurrentTasks)),
            Part(key: .mergeCheckCommand, text: check, differs: differs.contains(.mergeCheckCommand)),
        ]
    }

    public static func line(_ settings: ProjectStartSettings) -> String {
        parts(settings).map(\.text).joined(separator: " · ")
    }

    /// The same line for a reader who cannot see which parts are bold: every setting the owner
    /// changed is followed by what that means, as the browser's screen-reader text says it.
    public static func spokenLine(_ settings: ProjectStartSettings,
                                  differs: [ProjectStartSettingKey]) -> String {
        parts(settings, differs: differs)
            .map { $0.differs ? "\($0.text) (\(settingDiffers))" : $0.text }
            .joined(separator: " · ")
    }
}
