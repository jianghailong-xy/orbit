import Foundation

// The Wiki while it has nothing to read (design §12.3.1, mock 41) on the native pages — the Swift half of the web's
// `src/web/src/lib/wikiStart.ts`: one card of three steps — connect the repository, confirm the plan, write the
// documents — that says what happens next and offers at most one thing to press, and the workspaces its two forms
// offer.
//
// ONE CARD FOR EVERY EMPTY STATE. With no wiki at all it is the first step, whose button makes the wiki; with a wiki
// it reads the plan as Activity does (`WikiPlanLogic.look`) and says where that state stands on the way to something
// to read. It keeps nothing of its own: whether it is drawn, and what it says, is worked out from the reads each time.
//
// Every sentence is a constant or a function here, because `WikiStartParityTests` looks each one up in the web source;
// every reading is proved against `src/shared/src/wiki-start.fixture.json`, which the web's `lib/wikiStart.test.ts` and
// Android's `WikiStartLogicTest` read too.
//
// Pure, with no SwiftUI, so it is tested on Linux like the rest of this directory.

/// Every sentence the setup card and its two forms say. The web's constant each one mirrors is named beside it.
public enum WikiStartCopy {
    public static let title = "Set up this wiki"                              // WIKI_START_TITLE
    public static let firstTitle = "Set up your first wiki"                   // WIKI_START_FIRST_TITLE
    public static let lead = "Documents for this codebase, written from its repository and sessions, for you and your agents."   // WIKI_START_LEAD
    public static let firstLead = "A wiki is documents for one codebase, written from its repository and sessions, for you and your agents."   // WIKI_START_FIRST_LEAD
    public static let connect = "Connect the repository"                      // WIKI_START_CONNECT
    public static let connectFirst = "Connect a repository"                   // WIKI_START_CONNECT_FIRST
    public static let confirm = "Confirm the plan"                            // WIKI_START_CONFIRM
    public static let write = "Write the documents"                           // WIKI_START_WRITE
    public static let connectText = "Pick the workspace Orbit reads this repository from."   // WIKI_START_CONNECT_TEXT
    public static let connectFirstText = "Pick a workspace. Its repository is what this wiki will describe."   // WIKI_START_CONNECT_FIRST_TEXT
    public static let noRepository = "None of your workspaces has a repository yet. Add one, then come back."   // WIKI_START_NO_REPOSITORY
    public static let confirmTodo = "The \(WikiPlanCopy.drafterServer) drafts the documents this wiki should have. Nothing is written until you confirm it."   // WIKI_START_CONFIRM_TODO
    public static let writeTodo = "They appear here one by one."              // WIKI_START_WRITE_TODO
    public static let connected = "Connected"                                 // WIKI_START_CONNECTED
    public static let draftingNote = "Usually 1–2 hours. You can leave this page."   // WIKI_START_DRAFTING_NOTE
    public static let noPlan = "No plan yet. A plan lays out this wiki’s documents; nothing is written until you confirm it."   // WIKI_START_NO_PLAN
    public static let notWritten = "No document is written yet."              // WIKI_START_NOT_WRITTEN
    public static let create = "Create wiki"                                  // WIKI_CREATE
    public static let createOpen = "Create wiki…"                             // WIKI_CREATE_OPEN
    /// The answer on the sheet's bar (mock 41's iOS sheet): `Create`, under the sheet's title `Create wiki`.
    public static let createAnswer = "Create"
    public static let createNote = "A wiki describes one repository and stays up to date from its sessions, tasks and receipts. Runs on the server with this deployment’s \(WikiPlanCopy.drafterServer)."   // WIKI_CREATE_NOTE
    public static let workspaceOffline = "offline"                            // WIKI_WORKSPACE_OFFLINE

    /// A done first step: where maintenance reads the repository from (`wikiStartReadsFrom`).
    public static func readsFrom(_ workspace: String?) -> String { workspace.map { "Reads from \($0)" } ?? connected }

    /// A done second step: `v1 confirmed Nov 2 · 34 documents` (`wikiStartConfirmed`).
    public static func confirmed(version: Int, day: String?, documents: Int) -> String {
        "v\(version) confirmed\(day.map { " \($0)" } ?? "") · \(WikiArticleCopy.count(documents)) \(documents == 1 ? "document" : "documents")"
    }

    /// Under the workspace in the form that makes a wiki: what the wiki will be about, and how it gets there
    /// (`wikiCreateRepositoryNote`).
    public static func createRepositoryNote(_ repository: String) -> String {
        "This wiki will describe \(repository). The server reads the repository through this workspace’s runner."
    }

    public static let draftQueued = "Draft queued · \(WikiPlanCopy.queuedText)."
    public static let draftingSoon = "Drafting the plan · \(WikiPlanCopy.writingSoon)"
    public static func drafting(attempt: Int, of attempts: Int, started: String) -> String {
        "Drafting the plan · attempt \(attempt) of \(attempts) · started \(started)"
    }
}

public enum WikiStartLogic {
    // MARK: whether it is drawn

    /// Whether the home has nothing to read: no document of the confirmed plan written, and no topic article
    /// listed in its place. The first document, or the first article, takes the card away (`wikiStartShown`).
    public static func shown(written: Int, topics: Int) -> Bool { written == 0 && topics == 0 }

    // MARK: what it says

    /// Amber waits on the owner, blue is the server at work, a tick is done, grey has not come yet (`WikiStartStepState`).
    public enum StepState: String, Sendable {
        case done, wait, run, todo
    }

    /// What a step's button does: the two forms on the spot, a draft on the spot, or the page that takes it on
    /// (`WikiStartActionTo`).
    public enum ActionTo: String, Sendable {
        case create, setUp, draft, plan, runners
    }

    public struct Action: Equatable, Sendable {
        public let label: String
        public let to: ActionTo
        public let primary: Bool
    }

    public struct Step: Equatable, Sendable, Identifiable {
        public let state: StepState
        public let title: String
        public let text: String
        public let note: String?
        /// Writing: how far, and the document being written now.
        public let progress: WikiPlanLogic.JobCard.Progress?
        public let action: Action?
        public var id: String { title }

        init(state: StepState, title: String, text: String, note: String? = nil,
             progress: WikiPlanLogic.JobCard.Progress? = nil, action: Action? = nil) {
            self.state = state
            self.title = title
            self.text = text
            self.note = note
            self.progress = progress
            self.action = action
        }
    }

    public struct Card: Equatable, Sendable {
        public let title: String
        public let lead: String
        public let steps: [Step]
    }

    /// What the card reads besides the plan (`WikiStartContext`).
    public struct Context: Sendable {
        public let now: Date
        /// Whether the space's maintenance is on.
        public let maintenance: Bool
        /// The workspace it reads the repository from, as `WikiModeLogic.workspaceLabel` names it; nil while that is
        /// not known.
        public let readsFrom: String?
        public let runnerOnline: Bool?
        /// The confirmed plan's documents, for the writing's count and the document being written.
        public let directory: WikiDocsDirectory?

        public init(now: Date, maintenance: Bool, readsFrom: String?, runnerOnline: Bool?, directory: WikiDocsDirectory?) {
            self.now = now
            self.maintenance = maintenance
            self.readsFrom = readsFrom
            self.runnerOnline = runnerOnline
            self.directory = directory
        }
    }

    private static func openPlan(primary: Bool) -> Action { Action(label: WikiPlanCopy.open, to: .plan, primary: primary) }
    private static let viewRunners = Action(label: WikiPlanCopy.viewRunners, to: .runners, primary: true)
    private static let confirmTodo = Step(state: .todo, title: WikiStartCopy.confirm, text: WikiStartCopy.confirmTodo)
    private static let writeTodo = Step(state: .todo, title: WikiStartCopy.write, text: WikiStartCopy.writeTodo)

    /// The second step before a version is confirmed: the draft, wherever it has got to.
    private static func confirmStep(_ state: WikiPlanState, _ context: Context) -> Step {
        let title = WikiStartCopy.confirm
        let open = WikiPlanLogic.openJob(state)
        let look = WikiPlanLogic.look(state, runnerOnline: context.runnerOnline)
        func wait(_ text: String, _ action: Action, note: String? = nil) -> Step {
            Step(state: .wait, title: title, text: text, note: note, action: action)
        }
        if look == .held, let open { return wait(WikiPlanLogic.heldText(open, .runnerOffline), viewRunners) }
        if look == .draftFailed, let failed = WikiPlanLogic.failedJob(state) {
            return wait(WikiPlanLogic.draftFailedText(failed, state: state), openPlan(primary: true))
        }
        if look == .draftReady, let draft = state.draft {
            return wait(WikiPlanLogic.draftReadyText(draft), openPlan(primary: true), note: WikiPlanLogic.draftCounts(draft))
        }
        if look == .queued { return Step(state: .run, title: title, text: WikiStartCopy.draftQueued, action: openPlan(primary: false)) }
        if look == .drafting, let open {
            let text = open.startedAt.map {
                WikiStartCopy.drafting(attempt: open.attempt ?? 1, of: open.attemptsMax ?? 3, started: WikiHealthLogic.ago($0, now: context.now))
            } ?? WikiStartCopy.draftingSoon
            return Step(state: .run, title: title, text: text, note: WikiStartCopy.draftingNote, action: openPlan(primary: false))
        }
        return wait(WikiStartCopy.noPlan, Action(label: WikiPlanCopy.draft, to: .draft, primary: true), note: WikiPlanCopy.noteServer)
    }

    /// The third step, once a version is confirmed: its documents' writing, or that it stopped.
    private static func writeStep(_ state: WikiPlanState, _ context: Context) -> Step {
        let title = WikiStartCopy.write
        let build = WikiPlanLogic.buildJob(state)
        if let build, WikiPlanLogic.held(build, runnerOnline: context.runnerOnline) != nil {
            return Step(state: .wait, title: title, text: WikiPlanLogic.heldText(build, .runnerOffline), action: viewRunners)
        }
        guard let card = WikiPlanLogic.jobCard(build ?? WikiPlanLogic.failedBuild(state), now: context.now, runnerOnline: context.runnerOnline,
                                               failed: nil, inForce: true, directory: context.directory) else {
            return Step(state: .wait, title: title, text: WikiStartCopy.notWritten, action: openPlan(primary: true))
        }
        let text = "\(card.title) · \(card.text)"
        if card.look == .failed { return Step(state: .wait, title: title, text: text, action: openPlan(primary: true)) }
        return Step(state: .run, title: title, text: text, progress: card.progress, action: openPlan(primary: false))
    }

    /// The card of a wiki with nothing to read (`wikiStartCard`). The first step waits while there is no workspace to
    /// read the repository through: a job held for one, or no job and maintenance not on. With a version confirmed the
    /// second step is done whatever the first says, so a workspace lost later reads as what it is.
    public static func card(_ state: WikiPlanState, context: Context, timeZone: TimeZone = .current) -> Card {
        let held = WikiPlanLogic.held(WikiPlanLogic.openJob(state) ?? WikiPlanLogic.buildJob(state), runnerOnline: context.runnerOnline)
        let noPlan = WikiPlanLogic.look(state, runnerOnline: context.runnerOnline) == .noPlan
        let connect = (held != nil && held != .runnerOffline) || (noPlan && !context.maintenance)
        let first = connect
            ? Step(state: .wait, title: WikiStartCopy.connect, text: WikiStartCopy.connectText,
                   action: Action(label: WikiModeCopy.setUp, to: .setUp, primary: true))
            : Step(state: .done, title: WikiStartCopy.connect, text: WikiStartCopy.readsFrom(context.readsFrom))
        let second: Step
        if let confirmed = state.confirmed {
            second = Step(state: .done, title: WikiStartCopy.confirm,
                          text: WikiStartCopy.confirmed(version: confirmed.version,
                                                        day: WikiModeLogic.monthDay(confirmed.confirmedAt ?? "", timeZone: timeZone),
                                                        documents: confirmed.docs?.count ?? 0))
        } else {
            second = connect ? confirmTodo : confirmStep(state, context)
        }
        let third = state.confirmed != nil && !connect ? writeStep(state, context) : writeTodo
        return Card(title: WikiStartCopy.title, lead: WikiStartCopy.lead, steps: [first, second, third])
    }

    /// The card of an account with no wiki: the same three steps, the first of which makes one — or, with no workspace
    /// on a repository to make one from, says so and offers nothing to press (`wikiStartFirstCard`).
    public static func firstCard(workspaces: Bool) -> Card {
        let first = workspaces
            ? Step(state: .wait, title: WikiStartCopy.connectFirst, text: WikiStartCopy.connectFirstText,
                   action: Action(label: WikiStartCopy.createOpen, to: .create, primary: true))
            : Step(state: .wait, title: WikiStartCopy.connectFirst, text: WikiStartCopy.noRepository)
        return Card(title: WikiStartCopy.firstTitle, lead: WikiStartCopy.firstLead, steps: [first, confirmTodo, writeTodo])
    }

    // MARK: the workspaces the two forms offer

    private static func captures(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<match.numberOfRanges).map { i in Range(match.range(at: i), in: text).map { String(text[$0]) } ?? "" }
    }

    /// A repository as a wiki space names it (`normalizeRepoUrl` on the server, design §2.1): no scheme, user, trailing
    /// `/` or `.git`, the scp form read as a path and the host in lower case, so every spelling of one remote is one
    /// repository. Nil when nothing is left (`wikiRepositoryName`).
    public static func repositoryName(_ raw: String?) -> String? {
        var url = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme = "^[a-z][a-z0-9+.-]*://"
        if let scp = captures(#"^(?:[^@/\s]+@)?([^:/\s]+):(?!/)(\S+)$"#, in: url),
           captures(scheme, in: url, options: .caseInsensitive) == nil {
            url = "ssh://\(scp[1])/\(scp[2])"
        }
        if let remote = captures(scheme + "(?:[^@/]*@)?([^/]*)(.*)$", in: url, options: .caseInsensitive) {
            url = remote[1].lowercased() + remote[2]
        }
        while true {
            var trimmed = url
            while trimmed.hasSuffix("/") { trimmed.removeLast() }
            if trimmed.hasSuffix(".git") { trimmed.removeLast(4) }
            if trimmed == url { return url.isEmpty ? nil : url }
            url = trimmed
        }
    }

    /// What a wiki is called when it is made: its repository's last segment (`wikiRepositoryTitle`).
    public static func repositoryTitle(_ repository: String) -> String {
        repository.split(separator: "/").last.map(String.init) ?? repository
    }

    /// One workspace as the forms offer it (`WikiWorkspaceChoice`).
    public struct WorkspaceChoice: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        /// Its repository (`repositoryName`), and the URL as the workspace records it.
        public let repository: String?
        public let repoUrl: String?
        /// False when its runner is known to be offline.
        public let online: Bool

        public init(id: String, label: String, repository: String?, repoUrl: String?, online: Bool) {
            self.id = id
            self.label = label
            self.repository = repository
            self.repoUrl = repoUrl
            self.online = online
        }
    }

    /// Ids are compared in their storage spelling: a space's settings keep a workspace's id as it was stored, and the
    /// lists answer in the other spelling.
    private static func sameID(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b else { return false }
        return PublicID.storageKey(a) == PublicID.storageKey(b)
    }

    private static func label(_ agent: Agent, runnerNames: [String: String]) -> String {
        WikiModeLogic.workspaceLabel(name: agent.name, runner: agent.runnerId.flatMap { runnerNames[$0] })
    }

    /// Every workspace as the two forms offer it: its name and runner, its repository, and whether that runner is
    /// offline (`useWikiWorkspaceChoices`). A runner no read has said anything of is not offline.
    public static func choices(_ agents: [Agent], runnerNames: [String: String], runnerOnline: [String: Bool]) -> [WorkspaceChoice] {
        agents.map { agent in
            WorkspaceChoice(id: agent.id, label: label(agent, runnerNames: runnerNames),
                            repository: repositoryName(agent.repoUrl), repoUrl: agent.repoUrl,
                            online: runnerOnline.first { sameID($0.key, agent.runnerId) }?.value ?? true)
        }
    }

    /// A workspace by id, as the card names where maintenance reads from; nil while this client does not hold it.
    public static func workspaceLabel(_ id: String?, agents: [Agent], runnerNames: [String: String]) -> String? {
        agents.first { sameID($0.id, id) }.map { label($0, runnerNames: runnerNames) }
    }

    /// The choices in the order they are offered: every one a draft could start on first, then by name
    /// (`wikiWorkspaceChoicesInOrder`).
    public static func choicesInOrder(_ choices: [WorkspaceChoice]) -> [WorkspaceChoice] {
        choices.enumerated().sorted { a, b in
            if a.element.online != b.element.online { return a.element.online }
            let (x, y) = (a.element.label.lowercased(), b.element.label.lowercased())
            return x != y ? x < y : a.offset < b.offset
        }.map(\.element)
    }

    /// A row of a form's menu, which holds one line: the workspace, and `offline` when its runner is.
    public static func optionLabel(_ choice: WorkspaceChoice) -> String {
        choice.online ? choice.label : "\(choice.label) · \(WikiStartCopy.workspaceOffline)"
    }

    /// The workspaces a form's menu lists under one head: a repository in the form that makes a wiki, none in Set up.
    public struct WorkspaceGroup: Equatable, Sendable, Identifiable {
        public let repository: String?
        public let choices: [WorkspaceChoice]
        public var id: String { repository ?? "" }

        public init(repository: String?, choices: [WorkspaceChoice]) {
            self.repository = repository
            self.choices = choices
        }
    }

    /// The repositories the form that makes a wiki groups its workspaces under, by name. A workspace with none is left
    /// out (`wikiRepositoryGroups`).
    public static func repositoryGroups(_ choices: [WorkspaceChoice]) -> [WorkspaceGroup] {
        var groups: [String: [WorkspaceChoice]] = [:]
        for choice in choicesInOrder(choices) {
            if let repository = choice.repository { groups[repository, default: []].append(choice) }
        }
        return groups.sorted { $0.key < $1.key }.map { WorkspaceGroup(repository: $0.key, choices: $0.value) }
    }

    /// The workspace a form opens on: the one maintenance already reads from; else the one the reader came from, when
    /// its runner is not offline; else the first offered whose runner is not; else the first, since a draft that waits
    /// for its runner says so on the card (`wikiWorkspaceDefault`).
    public static func workspaceDefault(_ choices: [WorkspaceChoice], current: String?, from: String?) -> String? {
        if let current { return current }
        let offered = choicesInOrder(choices)
        return offered.first { $0.id == from && $0.online }?.id ?? offered.first(where: \.online)?.id ?? offered.first?.id
    }

    /// What Set up maintenance offers (`WikiSetUpDialog`): this wiki's workspaces, always with the one it reads from
    /// now — the workspaces of another repository could only read the wrong code. A wiki with no workspace in it yet
    /// offers them all.
    public static func setUpOffered(_ choices: [WorkspaceChoice], members: WikiSpaceWorkspaces?, current: String?) -> [WorkspaceChoice] {
        let inWiki = (members?.workspaces ?? []).filter(\.inWiki)
        if inWiki.isEmpty { return choicesInOrder(choices) }
        return choicesInOrder(choices.filter { choice in
            sameID(choice.id, current) || inWiki.contains { sameID($0.id, choice.id) }
        })
    }

    /// `workspaceDefault` over what a form offers, `current` and `from` spelled as its choices spell them.
    public static func opensOn(_ offered: [WorkspaceChoice], current: String?, from: String?) -> String? {
        workspaceDefault(offered, current: offered.first { sameID($0.id, current) }?.id ?? current,
                         from: offered.first { sameID($0.id, from) }?.id)
    }

    /// The line under the workspace in the form that makes a wiki: what it will describe, for the workspace picked.
    public static func createWorkspaceNote(_ choice: WorkspaceChoice?) -> String {
        choice?.repository.map(WikiStartCopy.createRepositoryNote) ?? WikiModeCopy.repoFromNote
    }

    /// What Create wiki sends for the workspace picked: the wiki, named for its repository, with maintenance on from the
    /// start. Nil for a workspace on no repository, which the form does not offer.
    public static func createRequest(_ choice: WorkspaceChoice, maintenance: WikiMaintenanceUpdate) -> WikiSpaceCreate? {
        guard let repository = choice.repository, let repoUrl = choice.repoUrl else { return nil }
        return WikiSpaceCreate(title: repositoryTitle(repository), repoUrl: repoUrl, maintenance: maintenance)
    }
}
