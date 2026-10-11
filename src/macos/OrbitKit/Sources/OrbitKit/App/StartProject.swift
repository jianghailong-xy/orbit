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
   plan in levels, what still comes to the owner under the Automatic switch, the line under Start,
   the body a press sends — are ports of the same file's functions, held to the browser's own
   examples by `StartProjectTests`.

   WHAT THE OWNER IS SHOWN (the owner, 2026-10-07)
   -----------------------------------------------
   Automatic opens on, whatever a coordinator suggested; the ready check's warnings are the
   coordinator's and the card draws none of them, nor the check's ✓ line; an empty merge check is a
   setting like any other; and a start with Automatic on opens the project's first coordinator when
   it has none. Mocks: docs/mocks/start-card-redesign (v2).
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire

/// How a project runs, as a start sets it — `@orbit/shared`'s `ProjectStartSettings`.
///
/// - `line` — where its finished tasks land: its own branch first, or straight on its upstream.
/// - `projectBranchName` — the project branch as a full `refs/heads/…` ref, only with a project
///   branch. Absent on a request means `refs/heads/project/<project id>`, or the branch the project
///   already names.
/// - `upstreamRef` — the project's main branch as a full `refs/heads/…` ref, with either line: where
///   its tasks start from and its work ends up. On a start it is the owner's choice; on a
///   coordinator's request, a suggestion. Absent asks for nothing: the project keeps the main branch
///   it stands on. In a start's record, the main branch the start left the project on.
/// - `automatic` — `project.coordinator_enabled`: the coordinator runs the project for the owner.
/// - `maxConcurrentTasks` — how many of its tasks may be in flight at once.
/// - `mergeCheckCommand` — the check run on the combined tree before anything lands; nil for none.
public struct ProjectStartSettings: Codable, Equatable, Sendable {
    public let line: IntegrationLine
    public let projectBranchName: String?
    public let upstreamRef: String?
    public let automatic: Bool
    public let maxConcurrentTasks: Int
    public let mergeCheckCommand: String?

    public init(line: IntegrationLine, projectBranchName: String? = nil, upstreamRef: String? = nil,
                automatic: Bool, maxConcurrentTasks: Int, mergeCheckCommand: String? = nil) {
        self.line = line
        self.projectBranchName = projectBranchName
        self.upstreamRef = upstreamRef
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
        upstreamRef = try c.decodeIfPresent(String.self, forKey: .upstreamRef)
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
                                    upstreamRef: settings["upstreamRef"]?.stringValue,
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
/// rides only with a project branch (it refuses one on a line that has none) and the main branch
/// only where the card offered one (it refuses one for a project with no repository), while the
/// merge check and the request are sent either way, null when there is none.
public struct StartProjectRequestBody: Encodable, Equatable, Sendable {
    public let criteriaDigest: String
    public let line: IntegrationLine
    public let projectBranchName: String?
    /// The main branch as a full `refs/heads/…` ref: the owner's choice once pressed.
    public let upstreamRef: String?
    public let automatic: Bool
    public let maxConcurrentTasks: Int
    public let mergeCheckCommand: String?
    public let requestId: String?

    public init(criteriaDigest: String, line: IntegrationLine, projectBranchName: String? = nil,
                upstreamRef: String? = nil, automatic: Bool, maxConcurrentTasks: Int,
                mergeCheckCommand: String? = nil, requestId: String? = nil) {
        self.criteriaDigest = criteriaDigest
        self.line = line
        self.projectBranchName = projectBranchName
        self.upstreamRef = upstreamRef
        self.automatic = automatic
        self.maxConcurrentTasks = maxConcurrentTasks
        self.mergeCheckCommand = mergeCheckCommand
        self.requestId = requestId
    }

    enum CodingKeys: String, CodingKey {
        case criteriaDigest, line, projectBranchName, upstreamRef, automatic, maxConcurrentTasks
        case mergeCheckCommand, requestId
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(criteriaDigest, forKey: .criteriaDigest)
        try c.encode(line, forKey: .line)
        try c.encodeIfPresent(projectBranchName, forKey: .projectBranchName)
        try c.encodeIfPresent(upstreamRef, forKey: .upstreamRef)
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
    /// What a session row, its header and the pinned strip say while the card is waiting.
    public static let readyToStart = "Ready to start"
    public static let doneWhen = "Done when"
    public static let plan = "Plan"
    public static let howItRuns = "How it runs"
    /// The link under the plan, to the tasks it names.
    public static let viewTasks = "View tasks ›"
    /// Beside it, while the plan is drawn as levels: the project page's task graph, full screen.
    public static let taskGraph = "Task graph"
    public static let action = "Start the project"
    /// What the armed composer asks for, once "Chat about this" has handed the reply to it.
    public static let chatPlaceholder = "What should change before it starts?"
    /// The card's header when nobody asked — the owner's own Start… — and, after it, when the project
    /// has no coordinator either.
    public static let nobodyAsked = "Nobody asked yet"
    public static let noCoordinatorYet = "no coordinator yet"
    /// What the coordinator's own words are headed with, and the press that shows all of them.
    public static let coordinator = "Coordinator"
    public static let more = "More"
    public static let less = "Less"
    /// What a press the door did not take says, over the door's own message.
    public static let notRecorded = "That start was not recorded"
    /// Why Start is dead on a card whose request no longer stands.
    public static let requestGone =
        "The plan changed after the coordinator asked, so this request no longer stands. Orbit "
        + "shows the card again when the coordinator asks to start the new plan."
    /// Said under the switch when Automatic is on and the project has no coordinator to run it yet:
    /// the start opens one (`POST /projects/:id/start`).
    public static let opensCoordinator =
        "This project has no coordinator yet. Orbit opens one where its tasks run when it starts."
    public static let now = "Now"
    public static let you = "You"

    /// The most tasks a project may run at once, as the door bounds it
    /// (web's `START_MAX_CONCURRENT_TASKS`, the server's `MAX_PROJECT_CONCURRENT_TASKS`).
    public static let maxConcurrentTasks = 100

    /// The sections' own heads, with how many there are: "Done when · 4 criteria".
    public static func doneWhenHead(_ count: Int) -> String {
        "\(doneWhen) · \(count) \(count == 1 ? "criterion" : "criteria")"
    }

    /// "Plan · 12 tasks in 7 levels" — the levels said only when there are more than one, and only
    /// when the plan was drawn in them (a folded graph is just "Plan · N tasks").
    public static func planHead(_ count: Int, levels: Int = 1) -> String {
        let head = "\(plan) · \(count) \(count == 1 ? "task" : "tasks")"
        return levels > 1 ? "\(head) in \(levels) levels" : head
    }

    /// Who asked, under the project's name: "The coordinator asked 56m ago". `ago` is each end's own
    /// clock words (`RelativeTime.format` here); a time the clock cannot say is the words alone.
    public static let coordinatorAsked = "The coordinator asked"
    public static func askedLine(_ ago: String?) -> String {
        ago.map { "\(coordinatorAsked) \($0)" } ?? coordinatorAsked
    }

    /// The header line of a card nobody asked for: "Nobody asked yet", and "· no coordinator yet"
    /// when there is not one to ask.
    public static func nobodyAskedLine(hasCoordinator: Bool) -> String {
        hasCoordinator ? nobodyAsked : "\(nobodyAsked) · \(noCoordinatorYet)"
    }

    /// The one paragraph under the criteria: what starting binds the project to, and what happens
    /// when the criteria move later — it asks again, and nothing stops.
    public static func explanation(_ count: Int) -> String {
        "Orbit derives done from these \(count) criteria and nothing else. If they change later, it "
            + "asks you to confirm the new version — the project keeps running."
    }

    /// What pressing Start does, said under the button: who it opens, what starts at once, and what
    /// it confirms — "Starts P1a now · confirms these 7 criteria · seal 3f2a…". A start that opens the
    /// project's first coordinator says that first and leaves the seal out, so the line still fits.
    public static func barCaption(opensCoordinator: Bool, startsNow: [String], criteria: Int,
                                  seal: String) -> String {
        var parts: [String] = []
        if opensCoordinator { parts.append("opens a coordinator") }
        if !startsNow.isEmpty { parts.append("starts \(joinAnd(startsNow)) now") }
        parts.append(criteria == 1 ? "confirms this criterion" : "confirms these \(criteria) criteria")
        if !opensCoordinator { parts.append("seal \(seal)") }
        let line = parts.joined(separator: " · ")
        return line.prefix(1).uppercased() + line.dropFirst()
    }

    // MARK: the footnote under How it runs

    public static let automaticByDefault = "Automatic is on by default"
    public static let coordinatorSuggestedOff = "the coordinator suggested off"
    public static let restSuggested = "The rest is the coordinator’s suggestion."
    public static let changeLater = "You can change any of these later on the project page."

    /// Whose settings these are, and that they can change: Automatic is the owner's default whatever
    /// a coordinator suggested, and the rest is the coordinator's suggestion when one asked.
    public static func howItRunsNote(asked: Bool, suggestedOff: Bool) -> String {
        let automatic = suggestedOff ? "\(automaticByDefault) (\(coordinatorSuggestedOff))."
                                     : "\(automaticByDefault)."
        return ([automatic] + (asked ? [restSuggested] : []) + [changeLater]).joined(separator: " ")
    }

    // MARK: what still comes to the owner

    public static let comesToYou = "Comes to you"
    public static let decideDone = "Whether each task is done"
    public static let youConfirm = "you confirm it"
    public static let problems = "Problems along the way"
    public static let problemsDetail = "conflicts, failed checks"
    public static let mergingIntoMain = "Merging the branch into main"
    public static let eachMergeIntoMain = "Each merge into main"
    /// The two above, said of the project's main branch — at `main`, word for word the constants.
    public static func mergingInto(_ main: String) -> String {
        "Merging the branch into \(main)"
    }
    public static func eachMergeInto(_ main: String) -> String {
        "Each merge into \(main)"
    }
    public static let criteriaChanges = "Any change to the criteria"

    /// "11 reviews": the evidence the owner decides on when Automatic is off.
    public static func reviews(_ count: Int) -> String {
        "\(count) \(count == 1 ? "review" : "reviews")"
    }

    /// More tasks the owner confirms than one list should name.
    public static func tasksYouConfirm(_ count: Int) -> String {
        "\(count) tasks you confirm"
    }

    /// "Problems it can’t resolve within 2 h": what reaches the owner of an Automatic project, after
    /// the project's escalation window.
    public static func problemsUnresolved(within: String) -> String {
        "Problems it can’t resolve within \(within)"
    }

    /// An escalation window as the list says it: "30 min", "2 h".
    public static func within(seconds: Int) -> String {
        if seconds < 3600 { return "\(max(1, Int((Double(seconds) / 60).rounded()))) min" }
        return "\(Int((Double(seconds) / 3600).rounded())) h"
    }

    /// One line of the list: what comes to the owner, and a few words after it.
    public struct ComesToYouItem: Equatable, Sendable, Identifiable {
        public let text: String
        public let detail: String?
        public var id: String { text }

        public init(text: String, detail: String? = nil) {
            self.text = text
            self.detail = detail
        }
    }

    /// The escalation window a project has when the read does not say
    /// (`project.exception_escalation_seconds`'s default) — web's `DEFAULT_ESCALATION_SECONDS`.
    public static let defaultEscalationSeconds = 7_200

    /// What still comes to the owner once the project starts with these settings — the consequence
    /// of the Automatic switch, listed rather than described, so flipping it shows what it costs.
    /// Web's `startComesToYou`, by the rules the server runs: an OWNER_CONFIRMED task is always the
    /// owner's to confirm; with Automatic off every EVIDENCE_JUDGMENT task's evidence comes to them,
    /// and so does every problem; a branch merges into main on the owner's word unless Automatic is
    /// on, and a project that lands directly on main never merges by itself; with Automatic on, a
    /// problem reaches the owner only after the project's escalation window. The merges name the
    /// project's main branch, `main`.
    public static func comesToYou(automatic: Bool, line: IntegrationLine,
                                  ownerConfirmed: [StartPlanNamedTask], evidenceJudged: Int,
                                  escalationSeconds: Int,
                                  main: String = RunSettings.defaultMainBranch) -> [ComesToYouItem] {
        let confirms: [ComesToYouItem] = ownerConfirmed.count > 3
            ? [ComesToYouItem(text: tasksYouConfirm(ownerConfirmed.count))]
            : ownerConfirmed.map { ComesToYouItem(text: "\($0.label) · \($0.title)", detail: youConfirm) }
        let merges: [ComesToYouItem] = line == .main
            ? [ComesToYouItem(text: eachMergeInto(main))]
            : automatic ? [] : [ComesToYouItem(text: mergingInto(main))]
        let criteria = ComesToYouItem(text: criteriaChanges)
        if automatic {
            return confirms + merges + [
                criteria,
                ComesToYouItem(text: problemsUnresolved(within: within(seconds: escalationSeconds))),
            ]
        }
        return [ComesToYouItem(text: decideDone, detail: evidenceJudged > 0 ? reviews(evidenceJudged) : nil)]
            + confirms
            + [ComesToYouItem(text: problems, detail: problemsDetail)]
            + merges
            + [criteria]
    }

    // MARK: the plan, by level

    /// What the plan calls a task: the marker its title opens with — "A · …", "① 服务端 · …", "3) …",
    /// "B：…", "P1 Web：…", "P1a · …" — and otherwise the title itself, cut short. A plan is written
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

    /// A capital, one or two digits and at most one small letter — "P1", "D12", "P1a" — followed at
    /// once by `.`, `)`, `:`, `：` or a space: a code rather than a word, so a space is separator
    /// enough — the browser's `/^([A-Z]\d{1,2}[a-z]?)(?:[.):：]|\s)/u`, spelled out.
    private static func leadingCode(_ s: [Unicode.Scalar]) -> String? {
        guard s.count > 2, ("A"..."Z").contains(s[0]), isDigit(s[1]) else { return nil }
        var length = isDigit(s[2]) ? 3 : 2
        if length < s.count, ("a"..."z").contains(s[length]) { length += 1 }
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

    /// A task's title without the label the plan already calls it by: "P1a · wiki-worker …" is
    /// listed as "P1a" and "wiki-worker …" — web's `planTaskRest`.
    public static func planTaskRest(_ title: String, label: String) -> String {
        let text = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard label != text, text.hasPrefix(label) else { return text }
        var rest = Substring(text.dropFirst(label.count))
        rest = rest.drop(while: { $0.isWhitespace })
        if let first = rest.first, ".):：·-–—|".contains(first) { rest = rest.dropFirst() }
        let trimmed = String(rest.drop(while: { $0.isWhitespace }))
        return trimmed.isEmpty ? text : trimmed
    }

    /// "5 in parallel": a level of more than one task.
    public static func inParallel(_ count: Int) -> String {
        "\(count) in parallel"
    }

    /// The plan in levels — the batch-create review's rule (`batchLevels`, web's `planLevels`): a task
    /// sits one level after the deepest of what it waits on, and tasks on one level do not wait on
    /// each other. Tasks are given oldest first, which is the order within a level; an edge to a task
    /// outside `tasks` (settled work, another project) waits on nothing here, and a cycle the server
    /// would never have allowed is cut rather than followed.
    public static func planLevels(_ tasks: [StartPlanTask]) -> [[StartPlanLevelTask]] {
        var known = Set<String>()
        for task in tasks { known.insert(task.id) }
        var prerequisites: [String: [String]] = [:]
        for task in tasks {
            var seen = Set<String>()
            prerequisites[task.id] = task.after.filter { known.contains($0) && $0 != task.id && seen.insert($0).inserted }
        }
        var level: [String: Int] = [:]
        func depth(_ id: String, _ seen: inout Set<String>) -> Int {
            if let at = level[id] { return at }
            if seen.contains(id) { return 0 }
            seen.insert(id)
            var at = 0
            for each in prerequisites[id] ?? [] { at = max(at, 1 + depth(each, &seen)) }
            level[id] = at
            return at
        }
        var levels: [[StartPlanLevelTask]] = []
        for task in tasks {
            var seen = Set<String>()
            let at = depth(task.id, &seen)
            while levels.count <= at { levels.append([]) }
            levels[at].append(StartPlanLevelTask(
                id: task.id, label: planTaskLabel(task.title), title: task.title,
                now: at == 0 && task.autoRunWhenReady != false,
                you: task.completionCriterion == "OWNER_CONFIRMED"))
        }
        return levels.filter { !$0.isEmpty }
    }

    /// The plan as the card reads it, off the project's dependency graph: the tasks nothing
    /// cancelled, in levels, and what the list of what comes to the owner reads off them. A folded
    /// graph is a plan too big to list, and says only how many tasks it holds.
    public static func planView(graph: ProjectDependencyGraph?, fallbackCount: Int) -> StartPlanView {
        // Folded is what the server says of a graph with any mark that is not a task
        // (`project-graph-fold.ts`), which is how this build reads it off the marks.
        guard let graph, !graph.truncated, !graph.marks.contains(where: { $0.kind != .task }) else {
            return StartPlanView(count: graph?.taskCount ?? fallbackCount, levels: nil,
                                 ownerConfirmed: [], evidenceJudged: 0, startsNow: [])
        }
        // Unfolded, every mark is one task. Cancelled ones are not part of the plan, and settled
        // ones run nothing and ask nobody, so neither is listed or counted.
        let tasks = graph.marks.filter { $0.status != "CANCELLED" }
        let planned = tasks.filter { $0.status != "DONE" }.map { mark in
            StartPlanTask(id: mark.id, title: mark.title,
                          after: graph.edges.filter { $0.targetMarkId == mark.id }.map(\.sourceMarkId),
                          completionCriterion: mark.completionCriterion,
                          autoRunWhenReady: mark.autoRunWhenReady)
        }
        let levels = planned.isEmpty ? nil : planLevels(planned)
        return StartPlanView(
            count: tasks.count,
            levels: levels,
            ownerConfirmed: planned.filter { $0.completionCriterion == "OWNER_CONFIRMED" }.map {
                let label = planTaskLabel($0.title)
                return StartPlanNamedTask(label: label, title: planTaskRest($0.title, label: label))
            },
            evidenceJudged: planned.filter { $0.completionCriterion == "EVIDENCE_JUDGMENT" }.count,
            startsNow: (levels?.first ?? []).filter(\.now).map(\.label))
    }

    /// The shrink below which the card lists the plan by level rather than drawing it: the browser's
    /// `MIN_FIT_ZOOM`, the line its project page draws between fitting a plan and opening on its
    /// frontier (docs/mocks/start-card-web-width, board 02, approved 2026-10-09).
    public static let planGraphMinFit = 0.7

    /// The plan as the project page's task graph, laid out top to bottom for a card
    /// `availableWidth` points wide — or nil, and the card lists the plan by level with the graph
    /// one press away, when the whole of it would have to shrink below `planGraphMinFit`, or the
    /// read folded or cut the plan short: those marks stand for more tasks than a picture shows.
    public static func planGraph(_ graph: ProjectDependencyGraph?, availableWidth: Double)
        -> (layout: ProjectGraph.Layout, edges: [ProjectGraphEdge], scale: Double)? {
        guard let graph, availableWidth > 0, !graph.truncated,
              !graph.marks.contains(where: { $0.kind != .task }) else { return nil }
        let prepared = ProjectGraph.prepare(graph, expanded: [])
        guard !prepared.marks.isEmpty else { return nil }
        let layout = ProjectGraph.layout(marks: prepared.marks, edges: prepared.edges, direction: .topToBottom,
                                         availableWidth: availableWidth)
        let scale = layout.fit(width: availableWidth)
        return scale >= planGraphMinFit ? (layout, prepared.edges, scale) : nil
    }

    // MARK: the press

    /// The body a press sends: the seal, every setting, and the request it answers. The branch the
    /// coordinator named rides only with a project branch — the door refuses a branch name on a
    /// line that has none — and an empty merge check is none. The main branch on the card is the
    /// owner's choice once pressed, so it rides whenever the card offered one: a project with no
    /// repository has none, and the door refuses one for it.
    public static func body(request: ProjectStartRequest, draft: StartSettingsDraft,
                            requestId: String?) -> StartProjectRequestBody {
        let branch = request.settings.projectBranchName ?? ""
        let check = draft.mergeCheckCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let upstream = draft.upstream ?? ""
        return StartProjectRequestBody(
            criteriaDigest: request.criteriaDigest,
            line: draft.line,
            projectBranchName: draft.line == .projectBranch && !branch.isEmpty ? branch : nil,
            upstreamRef: upstream.isEmpty ? nil : RunSettings.mainBranchRef(upstream),
            automatic: draft.automatic,
            maxConcurrentTasks: draft.maxConcurrentTasks,
            mergeCheckCommand: check.isEmpty ? nil : check,
            requestId: requestId)
    }

    /// The main branch a start opens with, by name: the first of the one this project's owner
    /// already chose for it, the one they chose last for its repository, the one the coordinator
    /// suggests, and main (contract L6) — web's `startMainBranch`. An earlier choice of the owner's
    /// outranks a suggestion; a main branch the project only stands on by default is nobody's
    /// choice, and a read that failed (`standing` nil) says nothing at all.
    public static func mainBranch(suggested: String?, standing: ProjectIntegrationView?) -> String {
        var chosen: String?
        if let at = standing?.upstreamChosenAt, !at.isEmpty { chosen = standing?.upstreamRef }
        return RunSettings.mainBranchName(chosen ?? standing?.lastMainBranch?.branch ?? suggested)
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

/// One task of the plan. `after` names its prerequisites by id; the two settlement facts are what
/// the card marks it by (Now, You) and counts in what comes to the owner.
public struct StartPlanTask: Equatable, Sendable {
    public let id: String
    public let title: String
    public let after: [String]
    public let completionCriterion: String?
    public let autoRunWhenReady: Bool?

    public init(id: String, title: String, after: [String] = [], completionCriterion: String? = nil,
                autoRunWhenReady: Bool? = nil) {
        self.id = id
        self.title = title
        self.after = after
        self.completionCriterion = completionCriterion
        self.autoRunWhenReady = autoRunWhenReady
    }
}

/// One task as a level of the plan lists it.
public struct StartPlanLevelTask: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let title: String
    /// Orbit starts it the moment the project does: first level, and not set to start by hand.
    public let now: Bool
    /// The owner confirms it (OWNER_CONFIRMED).
    public let you: Bool

    public init(id: String, label: String, title: String, now: Bool, you: Bool) {
        self.id = id
        self.label = label
        self.title = title
        self.now = now
        self.you = you
    }
}

/// A task by the label the plan calls it and the rest of its title.
public struct StartPlanNamedTask: Equatable, Sendable {
    public let label: String
    public let title: String

    public init(label: String, title: String) {
        self.label = label
        self.title = title
    }
}

/// The plan as the card reads it: how many tasks, the plan in levels (nil when the graph came back
/// folded — a plan too big to list), and the facts the list of what comes to the owner reads.
public struct StartPlanView: Equatable, Sendable {
    public let count: Int
    public let levels: [[StartPlanLevelTask]]?
    /// Its OWNER_CONFIRMED tasks, by label and the rest of their title.
    public let ownerConfirmed: [StartPlanNamedTask]
    /// How many of its tasks are settled by a judgment of their evidence.
    public let evidenceJudged: Int
    /// The labels of the tasks Orbit starts the moment the project does.
    public let startsNow: [String]

    public init(count: Int, levels: [[StartPlanLevelTask]]?, ownerConfirmed: [StartPlanNamedTask],
                evidenceJudged: Int, startsNow: [String]) {
        self.count = count
        self.levels = levels
        self.ownerConfirmed = ownerConfirmed
        self.evidenceJudged = evidenceJudged
        self.startsNow = startsNow
    }
}

/// The settings as the card edits them. The count is always a number here — a Stepper has no empty
/// state — but it is still bounded by the door's own limits (`complete`).
public struct StartSettingsDraft: Equatable, Sendable {
    public var line: IntegrationLine
    /// The main branch by name, `refs/heads/` left off: what the Main branch row shows and the reader
    /// picks or types — nil for a project with no repository, which has no main branch to choose
    /// and no row.
    public var upstream: String?
    public var automatic: Bool
    public var maxConcurrentTasks: Int
    public var mergeCheckCommand: String

    public init(line: IntegrationLine, upstream: String? = nil, automatic: Bool, maxConcurrentTasks: Int,
                mergeCheckCommand: String = "") {
        self.line = line
        self.upstream = upstream
        self.automatic = automatic
        self.maxConcurrentTasks = maxConcurrentTasks
        self.mergeCheckCommand = mergeCheckCommand
    }

    /// The card's draft of what a suggestion says — with Automatic on whatever was suggested:
    /// delegating is the owner's default (the owner, 2026-10-07), and a coordinator that would keep it
    /// off says so in its own words, which the card quotes. The main branch is the first that
    /// `StartProject.mainBranch` finds, and only for a project the integration read (`standing`)
    /// says has a repository: a read that does not say whether it has one offers none.
    public init(_ settings: ProjectStartSettings, standing: ProjectIntegrationView? = nil) {
        let repository = standing?.repository ?? ""
        self.init(line: settings.line,
                  upstream: repository.isEmpty ? nil
                      : StartProject.mainBranch(suggested: settings.upstreamRef, standing: standing),
                  automatic: true,
                  maxConcurrentTasks: settings.maxConcurrentTasks,
                  mergeCheckCommand: settings.mergeCheckCommand ?? "")
    }

    /// The branch every sentence about where work goes names: the one on the card, or main for a
    /// project with no repository to have another.
    public var main: String {
        upstream ?? RunSettings.defaultMainBranch
    }

    /// Whether the draft is a set of settings the door would take: a line, and a whole number of
    /// tasks in range.
    public var complete: Bool {
        line != .unknown && (1...StartProject.maxConcurrentTasks).contains(maxConcurrentTasks)
    }

    /// Whether a merge check is set: an empty one is a setting like any other, said as None.
    public var hasMergeCheck: Bool {
        !mergeCheckCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

    /// The main branch: the branch a project's tasks start from and its finished work ends up on
    /// (`project_codebase.upstream_ref`). `main` until the owner chooses another — never probed, never
    /// `master` by guess (contract L6) — and every sentence here that says where work goes names the
    /// project's own, so a project on `master` reads "Directly into master" and one on `main` reads
    /// exactly as it always did. Each such sentence is a function of the branch, beside the constant
    /// that says it of main: the constants are the words the copy-parity tests read (here and on
    /// Android), and `StartProjectTests` holds every function, at main, to its constant word for word.
    public static let defaultMainBranch = "main"
    public static let mainBranch = "Main branch"
    public static let mainBranchHint = "Tasks start from it, and the project’s work ends up on it."
    /// Under the start card's row while it shows the branch remembered for this repository.
    public static func lastChoiceFor(_ repository: String) -> String {
        "Your last choice for \(repository)"
    }
    /// How it runs: what choosing a main branch there also decides.
    public static func mainBranchRemembers(_ repository: String) -> String {
        "New projects in \(repository) start with your last choice."
    }
    /// The remembered branch's tag in the picker.
    public static let lastChosen = "last chosen"
    /// The picker's head: whose branches it lists, or that there is no list to pick from.
    public static func branchesIn(_ workspace: String) -> String {
        "Branches in \(workspace)"
    }
    public static let typeABranch = "Type a branch name"
    /// A typed name the runner never reported, offered as itself.
    public static func useBranch(_ name: String) -> String {
        "Use “\(name)”"
    }
    /// A main branch as the doors take it, and as a sentence names it: a read's short name or a full
    /// ref, `main` for none.
    public static func mainBranchRef(_ name: String) -> String {
        "refs/heads/\(name)"
    }
    public static func mainBranchName(_ ref: String?) -> String {
        guard let ref, !ref.isEmpty else { return defaultMainBranch }
        return ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
    }

    public static let lineMain = "Directly into main"
    public static let lineMainHint =
        "For a single task or an urgent fix. Every merge into main asks you."
    /// The two above, said of the project's main branch.
    public static func lineMain(_ main: String) -> String {
        "Directly into \(main)"
    }
    public static func lineMainHint(_ main: String) -> String {
        "For a single task or an urgent fix. Every merge into \(main) asks you."
    }
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
    public static func mergeCheckHint(_ main: String) -> String {
        "Runs on the combined tree before anything lands — on the project branch and again before "
            + "\(main)."
    }
    public static let mergeCheckPlaceholder = "No check — work lands once it rebases cleanly"
    /// Said under an empty merge check while Automatic would merge the branch into main unchecked.
    public static let noMergeCheckWarning =
        "No merge check: with Automatic on, the branch merges into main with nothing run on the "
        + "combined tree."
    public static func noMergeCheckWarning(_ main: String) -> String {
        "No merge check: with Automatic on, the branch merges into \(main) with nothing run on the "
            + "combined tree."
    }

    public static let summaryMergeCheckSet = "merge check set"
    public static let summaryNoMergeCheck = "no merge check"
    /// What a setting that is not what the coordinator suggested says when it is pointed at.
    public static let settingDiffers = "Not what the coordinator suggested"

    /// The Automatic sentence for the line chosen: the merge half follows the line, and names the
    /// project's main branch — the two constants above, for a project on main.
    public static func automaticHint(_ line: IntegrationLine, main: String = defaultMainBranch) -> String {
        if line == .main {
            return "The coordinator runs it for you: it decides when each task is done and handles conflicts "
                + "and failed checks. Merging into \(main) always asks you — a project that lands directly on "
                + "\(main) never merges by itself. The criteria and anything irreversible stay yours."
        }
        return "The coordinator runs it for you: it decides when each task is done, handles conflicts and "
            + "failed checks, and merges the branch into \(main) once the merge check passes — with a "
            + "receipt you can revert. The criteria and anything irreversible stay yours."
    }

    /// The start card's one sentence under the switch: who decides what, for the line and merge
    /// check chosen. What still comes to the owner is the list beneath it (`StartProject.comesToYou`).
    public static let automaticOnChecked =
        "The coordinator decides when each task is done and merges into main once the merge check "
        + "passes — with a receipt you can revert."
    public static let automaticOnUnchecked =
        "The coordinator decides when each task is done and merges into main by itself — with a "
        + "receipt you can revert."
    public static let automaticOnMain =
        "The coordinator decides when each task is done. Each merge into main still asks you."
    public static let automaticOff =
        "You decide when each task is done and when the branch goes into main."
    public static let automaticOffMain =
        "You decide when each task is done, and each merge into main asks you."

    /// The five above, said of the project's main branch.
    public static func automaticSays(automatic: Bool, line: IntegrationLine, hasMergeCheck: Bool,
                                     main: String = defaultMainBranch) -> String {
        guard automatic else {
            return line == .main
                ? "You decide when each task is done, and each merge into \(main) asks you."
                : "You decide when each task is done and when the branch goes into \(main)."
        }
        if line == .main {
            return "The coordinator decides when each task is done. Each merge into \(main) still asks you."
        }
        return hasMergeCheck
            ? "The coordinator decides when each task is done and merges into \(main) once the merge check "
                + "passes — with a receipt you can revert."
            : "The coordinator decides when each task is done and merges into \(main) by itself — with a "
                + "receipt you can revert."
    }

    /// The merge check's row on the start card, folded to its value, and what an empty one means.
    public static let mergeCheckSet = "Set"
    public static let mergeCheckNone = "None"
    public static let mergeCheckNoneSays = "Work lands once it rebases cleanly."

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
    /// check set". Directly into the main branch the start recorded, main when it recorded none.
    public static func parts(_ settings: ProjectStartSettings,
                             differs: [ProjectStartSettingKey] = []) -> [Part] {
        let tasks = settings.maxConcurrentTasks
        let line: String
        if settings.line == .main {
            line = lineMain(mainBranchName(settings.upstreamRef))
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
