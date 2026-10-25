import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE PROJECT PAGE'S HALF OF STARTING A PROJECT, AND "HOW IT RUNS" AFTERWARDS — THIS CLIENT'S HALF
   OF WEB'S `ProjectRunSettings.tsx`, THE PROJECT-PAGE PART OF `lib/projectStart.ts`, AND
   `defaultStartSettings` IN `StartProjectCard.tsx` (mock board3 ②③)
   ─────────────────────────────────────────────────────────────────────────────────────────────

   BEFORE THE START
   ----------------
   A project nobody has started says so ("Not started"), and its Open items lead with the start: the
   coordinator's request when there is one — "Start this project?", what it suggests, and Review,
   which goes to the one place the request is answered, the card in the coordinator conversation —
   and otherwise the owner's own "Start…", which opens that same card over the page, set by the
   default rule (`StartProject.defaultSettings`).

   AFTER IT
   --------
   Every setting the start card set is changed in one block, How it runs: where tasks land (until
   the first landing locks it), Automatic, how many run at once, the merge check, how long an
   exception waits on the coordinator, and Pause project. A question the start card answered is
   changed here afterwards, and nowhere else — Automatic left the coordinator card for it.

   EVERY WORD IS THE BROWSER'S
   ---------------------------
   `ProjectRunSettingsCopyParityTests` reads `lib/projectStart.ts` and `ProjectRunSettings.tsx` back
   against the words below; the derivations are held to the browser's own examples by
   `ProjectRunSettingsTests`.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the words: the start, as the project page says it

extension StartProject {

    /// The project page's status tag for a project nobody has started.
    public static let notStarted = "Not started"
    /// Who asked, leading the request's row under "Start this project?".
    public static let rowAsked = "The coordinator asked"
    /// The owner's own way to start a project nobody asked about — the same card, over the page.
    public static let rowOwn = "Start…"
    /// …said beside it: nobody is waiting on it, so it is quiet and counted in nothing.
    public static let rowNotAsked = "not asked yet"

    /// The request's row under its title: who asked, and what it suggests — "The coordinator asked
    /// · a project branch · Automatic on · at most 3 at a time". Directly into `main`: the main branch
    /// the start card opens with (`mainBranch(suggested:standing:)`), or — for a page holding no
    /// integration read — the one the request suggests.
    public static func requestSummary(_ settings: ProjectStartSettings, main: String? = nil) -> String {
        let main = main ?? RunSettings.mainBranchName(settings.upstreamRef)
        return [
            rowAsked,
            RunSettings.lineInSentence(settings.line, main: main),
            "\(RunSettings.automatic) \(settings.automatic ? "on" : "off")",
            "at most \(settings.maxConcurrentTasks) at a time",
        ].joined(separator: " · ")
    }

    /// What the start's row in Open items is, for a project page: the coordinator's request, the
    /// owner's own Start…, or nothing.
    public enum PageRow: Equatable, Sendable {
        /// The coordinator asked: its open `START_REQUEST`, answered on the card in its conversation.
        case asked(ProjectOpenItemRow)
        /// Nobody asked: the owner's own Start…, which opens the same card over the page.
        case own

        /// The coordinator's request, when the row is one — what Open items counts as needing you.
        public var request: ProjectOpenItemRow? {
            if case .asked(let row) = self { return row }
            return nil
        }
    }

    /// Which row the page draws. Only an OPEN project nobody has started draws one — a read that
    /// does not say whether it started is not a project waiting to be started — and the owner's own
    /// Start… only once the open-items read has answered: a request still on its way is not a
    /// project nobody asked about.
    public static func pageRow(status: ProjectStatus, started: Bool?,
                               openItems: ProjectOpenItemsView?) -> PageRow? {
        guard status == .open, started == false, let openItems else { return nil }
        if let request = openItems.startRequest { return .asked(request) }
        return .own
    }

    /// The settings a start takes when nobody suggested any — the rule the older confirmation door
    /// starts a project by, read off what the project page holds: the line the project is already
    /// on or its owner chose, else a project branch when its tasks wait on one another and main
    /// when they do not; Automatic on; the concurrency it has; the merge check it has. Web's
    /// `defaultStartSettings`.
    public static func defaultSettings(view: ProjectIntegrationView?, maxConcurrentTasks: Int?,
                                       graph: ProjectDependencyGraph?) -> ProjectStartSettings {
        let decided = view?.line.flatMap { $0 == .unknown ? nil : $0 }
        let line = decided ?? (graph.map(planHasDependencies) == true ? .projectBranch : .main)
        let branch = decided == .projectBranch ? view?.ref.flatMap { $0.isEmpty ? nil : "refs/heads/\($0)" } : nil
        // The main branch the project already stands on, where it has one: what a start that names
        // none would keep. The card's own order puts the owner's choices before it (`mainBranch`).
        let upstream = view?.upstreamRef.flatMap { $0.isEmpty ? nil : RunSettings.mainBranchRef($0) }
        return ProjectStartSettings(line: line, projectBranchName: branch, upstreamRef: upstream,
                                    automatic: true, maxConcurrentTasks: maxConcurrentTasks ?? 1,
                                    mergeCheckCommand: view?.mergeCheckCommand)
    }

    /// Whether any live task of the plan waits on another. A run the server folded is a chain.
    static func planHasDependencies(_ graph: ProjectDependencyGraph) -> Bool {
        let live = Set(graph.marks.filter { markStatus($0) != "CANCELLED" }.map(\.id))
        return graph.marks.contains { $0.kind == .run }
            || graph.edges.contains { live.contains($0.sourceMarkId) && live.contains($0.targetMarkId) }
    }

    /// A mark's status as one word: a task's own, and a fold's worst — web's `markStatus`.
    private static func markStatus(_ mark: ProjectGraphMark) -> String {
        if mark.kind == .task { return mark.status ?? "" }
        let counts = mark.statusCounts
        if (counts["FAILED"] ?? 0) > 0 { return "FAILED" }
        if (counts["IN_PROGRESS"] ?? 0) > 0 { return "IN_PROGRESS" }
        if (counts["OPEN"] ?? 0) > 0 { return "OPEN" }
        return "DONE"
    }

    /// The request the owner's own card is drawn from: the default rule's settings, about the seal
    /// standing now, with nothing any coordinator said — no reason, no warnings, no repository the
    /// ready check found (it did not run).
    public static func ownerRequest(settings: ProjectStartSettings, criteriaDigest: String) -> ProjectStartRequest {
        ProjectStartRequest(settings: settings, why: "", criteriaDigest: criteriaDigest)
    }
}

// MARK: - the words: How it runs

extension RunSettings {

    /// The block's head says when what it changes takes hold.
    public static let appliesFromNextTask = "applies from the next task"
    public static let escalateAfter = "Escalate after"
    public static let escalateHint = "Items the coordinator hasn’t handled by then come to you."
    /// The merge check's editor saves what was typed.
    public static let save = "Save"
    /// What a change the doors did not take says, over the door's own message.
    public static let notSaved = "These settings were not saved"
    public static let pause = "Pause project"
    public static let pauseHint = "Stops new tasks, wake-ups and merges into main. Running tasks finish."
    public static func pauseHint(_ main: String) -> String {
        "Stops new tasks, wake-ups and merges into \(main). Running tasks finish."
    }
    public static let resume = "Resume project"
    public static let notPaused = "The project was not paused"
    public static let notResumed = "The project was not resumed"
    /// Where the integration read failed, and the block has nothing to draw from.
    public static let notLoaded = "How it runs could not be loaded"

    /// The integration row of a project nobody has started: where its tasks land is the start's to
    /// decide — "Tasks land on: decided when you start — the coordinator suggests a project branch".
    public static let lineDecidedAtStart = "decided when you start"
    public static let lineSuggested = "the coordinator suggests"

    /// A line as a sentence names it, mid-sentence: "a project branch", "directly into main" — into
    /// the project's main branch, `main`.
    public static func lineInSentence(_ line: IntegrationLine, main: String = defaultMainBranch) -> String {
        line == .main ? "directly into \(main)" : "a project branch"
    }

    /// The whole of that row, with the coordinator's suggestion once it has asked — directly into the
    /// main branch the start card opens with, `main`.
    public static func undecidedLine(suggested: IntegrationLine?, main: String = defaultMainBranch) -> String {
        let decided = "\(tasksLandOn): \(lineDecidedAtStart)"
        guard let suggested, suggested != .unknown else { return decided }
        return "\(decided) — \(lineSuggested) \(lineInSentence(suggested, main: main))"
    }

    /// Why Tasks land on is read-only: the line started integrating — `since` is "2h ago" — and
    /// moving it would orphan what already landed on it. Said under the line on a project with no
    /// Main branch row; one that has the row says `mainBranchLocked` under it instead.
    public static func lineLocked(since: String?) -> String {
        "This project started integrating\(since.map { " \($0)" } ?? ""), so the line it lands on can "
            + "no longer change. Merge it into main, or give up the branch, to start another."
    }

    /// The same, said under Main branch: the line and its main branch lock together, and the branch
    /// it merges into is the project's own.
    public static func mainBranchLocked(since: String?, main: String) -> String {
        "This project started integrating\(since.map { " \($0)" } ?? ""), so the line it lands on and its "
            + "main branch can no longer change. Merge it into \(main), or give up the branch, to start another."
    }

    /// What a paused project says before what pausing does: since when — "Paused 2h ago."
    public static func pausedSince(_ since: String) -> String {
        "Paused \(since)."
    }

    /// The sentence under Pause project / Resume project: since when it is paused, then what a pause
    /// does — or only what it does, for a project that is running. Pausing stops merges into the main
    /// branch the project stands on, `main`.
    public static func pauseFootnote(pausedAt: String?, now: Date, main: String = defaultMainBranch) -> String {
        guard let pausedAt, let since = RelativeTime.ago(pausedAt, now: now) else { return pauseHint(main) }
        return "\(pausedSince(since)) \(pauseHint(main))"
    }

    /// Whether How it runs' merge check row is the amber one, on the line the project is on: the
    /// start card's rule (`mergeCheckMissing`), and never for a line nobody has decided — nothing
    /// merges into main off a line that is not there yet.
    public static func mergeCheckMissing(onLine line: IntegrationLine?, automatic: Bool,
                                         mergeCheckCommand: String?) -> Bool {
        guard let line else { return false }
        return mergeCheckMissing(line: line, automatic: automatic, mergeCheckCommand: mergeCheckCommand)
    }

    /// Whether How it runs is drawn: once the project is started — and for a read that does not say,
    /// which is an older server's project that runs — but never for one nobody has started, whose
    /// settings are the start card's to set.
    public static func shown(started: Bool?) -> Bool {
        started != false
    }

    // MARK: the escalation window

    /// One point on the escalation window's range worth a press.
    public struct EscalationChoice: Equatable, Sendable, Identifiable {
        public let seconds: Int
        public let label: String
        public var id: Int { seconds }

        public init(seconds: Int, label: String) {
            self.seconds = seconds
            self.label = label
        }
    }

    /// The column's CHECK bounds it 300 s to a week (§4.1); these are the points worth a press.
    public static let escalationChoices: [EscalationChoice] = [
        EscalationChoice(seconds: 1800, label: "30 minutes"),
        EscalationChoice(seconds: 3600, label: "1 hour"),
        EscalationChoice(seconds: 7200, label: "2 hours"),
        EscalationChoice(seconds: 14400, label: "4 hours"),
        EscalationChoice(seconds: 28800, label: "8 hours"),
        EscalationChoice(seconds: 86400, label: "24 hours"),
    ]

    /// The window in words, including a window nobody offered.
    public static func escalationLabel(_ seconds: Int) -> String {
        if let known = escalationChoices.first(where: { $0.seconds == seconds }) { return known.label }
        if seconds % 3600 == 0 {
            let hours = seconds / 3600
            return "\(hours) hour\(hours == 1 ? "" : "s")"
        }
        let minutes = Int((Double(seconds) / 60).rounded())
        return "\(minutes) minute\(minutes == 1 ? "" : "s")"
    }

    /// The menu's choices: the offered points, and the project's own window when it is none of them
    /// — shown as itself rather than snapped to the nearest one.
    public static func escalationOptions(current: Int) -> [EscalationChoice] {
        escalationChoices.contains { $0.seconds == current }
            ? escalationChoices
            : escalationChoices + [EscalationChoice(seconds: current, label: escalationLabel(current))]
    }

    // MARK: the main branch

    /// The main branch the project stands on, by name — before it is bound to its repository, the
    /// one binding gives it: the owner's last choice there, else main (L6) — and nil for a project
    /// with no repository, which draws no Main branch row. Web's `storedUpstream`.
    public static func storedMainBranch(_ view: ProjectIntegrationView) -> String? {
        guard let repository = view.repository, !repository.isEmpty else { return nil }
        return mainBranchName(view.upstreamRef ?? view.lastMainBranch?.branch)
    }

    /// Near enough to git's rule for a branch name to refuse a typo before the door does (which
    /// takes any `refs/heads/` name without whitespace): no whitespace, no `~ ^ : ? * [` or
    /// backslash, no `..`, no leading `-` or `/`, no trailing `/` or `.lock` — web's `BRANCH_NAME`.
    public static func takesBranchName(_ name: String) -> Bool {
        guard !name.isEmpty, !name.hasPrefix("-"), !name.hasPrefix("/"), !name.contains(".."),
              !name.hasSuffix("/"), !name.hasSuffix(".lock") else { return false }
        return !name.unicodeScalars.contains { $0.properties.isWhitespace || "~^:?*[\\".unicodeScalars.contains($0) }
    }

    /// One row of the Main branch picker: a branch by its name, or a typed name the runner never
    /// reported, offered as itself (`Use “…”`).
    public struct BranchChoice: Equatable, Sendable, Identifiable {
        public let name: String
        /// The row's words: the name, or `Use “name”` for a typed one.
        public let label: String
        /// The branch the owner chose last for the repository, tagged `last chosen`.
        public let lastChosen: Bool
        /// The branch the row stands on now, ticked.
        public let current: Bool
        public var id: String { label }
        public var typed: Bool { label != name }
    }

    /// The picker's rows, filtered by what the reader typed: the branches the runner reported for the
    /// coordination workspace, the remembered one and the current one — each once, in that order —
    /// then, when what was typed is none of them and looks like a branch name, that name offered as
    /// itself. Web's `MainBranchSelect`: one list for the start card and How it runs, so the two
    /// cannot offer different branches.
    public static func branchChoices(branches: ProjectBranchCandidates?, remembered: String?,
                                     current: String, query: String) -> [BranchChoice] {
        var names: [String] = []
        for name in (branches?.names ?? []) + [remembered ?? "", current] where !name.isEmpty && !names.contains(name) {
            names.append(name)
        }
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = typed.isEmpty ? names : names.filter { $0.lowercased().contains(typed.lowercased()) }
        var choices = shown.map {
            BranchChoice(name: $0, label: $0, lastChosen: $0 == remembered, current: $0 == current)
        }
        if !typed.isEmpty, !names.contains(typed), takesBranchName(typed) {
            choices.append(BranchChoice(name: typed, label: useBranch(typed), lastChosen: false, current: false))
        }
        return choices
    }

    /// The picker's head: whose branches it lists, or — with none reported — that a name is typed.
    public static func branchesHead(_ branches: ProjectBranchCandidates?) -> String {
        branches.map { branchesIn($0.workspaceName) } ?? typeABranch
    }

    /// Whether the start card says where its main branch came from: while it shows the branch the
    /// owner chose last for this repository — and not once it is changed to another.
    public static func lastChoiceNote(upstream: String?, lastMainBranch: ProjectLastMainBranch?) -> String? {
        guard let lastMainBranch, let upstream, upstream == lastMainBranch.branch else { return nil }
        return lastChoiceFor(lastMainBranch.repository)
    }

    /// What How it runs says under its Main branch row: what the row decides, and that a choice there
    /// is also the repository's next default — or, once the line has started integrating, why the
    /// row can no longer move. Nil for a project with no repository, which has no row.
    public static func mainBranchNote(_ view: ProjectIntegrationView, since: String?) -> String? {
        guard let repository = view.repository, !repository.isEmpty,
              let main = storedMainBranch(view) else { return nil }
        if view.locked { return mainBranchLocked(since: since, main: main) }
        return "\(mainBranchHint) \(mainBranchRemembers(repository))"
    }

    // MARK: the writes, one control at a time

    /// The line a press on Tasks land on writes — only while it can still move, and only when it is
    /// a move: sending the value a locked line already holds is refused 409 by the trigger.
    public static func lineWrite(_ view: ProjectIntegrationView,
                                 to line: IntegrationLine) -> UpdateProjectIntegrationRequest? {
        guard !view.locked, line != .unknown, line != view.line else { return nil }
        return UpdateProjectIntegrationRequest(line: line)
    }

    /// The main branch a pick in How it runs writes: only while it can still move (L4 locks it with
    /// the line — sending the value a locked line already holds is refused 409), only for a project
    /// with a repository, and only when it is a move. The owner's choice, and the one their next
    /// project in the repository starts with.
    public static func mainBranchWrite(_ view: ProjectIntegrationView,
                                       to name: String) -> UpdateProjectIntegrationRequest? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !view.locked, let stored = storedMainBranch(view), !name.isEmpty, name != stored
        else { return nil }
        return UpdateProjectIntegrationRequest(upstreamRef: mainBranchRef(name))
    }

    /// The merge check a Save writes: trimmed, blank is none — and nothing when it is what is stored.
    public static func mergeCheckWrite(_ view: ProjectIntegrationView,
                                       to command: String) -> UpdateProjectIntegrationRequest? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let next: String? = trimmed.isEmpty ? nil : trimmed
        guard next != view.mergeCheckCommand else { return nil }
        return UpdateProjectIntegrationRequest(mergeCheckCommand: .some(next))
    }

    /// The escalation window a pick writes, when it moves it.
    public static func escalationWrite(_ view: ProjectIntegrationView,
                                       to seconds: Int) -> UpdateProjectIntegrationRequest? {
        guard seconds != view.escalationSeconds else { return nil }
        return UpdateProjectIntegrationRequest(exceptionEscalationSeconds: seconds)
    }
}
