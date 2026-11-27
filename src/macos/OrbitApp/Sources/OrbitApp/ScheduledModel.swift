import Foundation
import Observation
import OrbitKit

/// Scheduled tasks (docs/scheduled-tasks-design.md §9.2): the account's schedules behind the Scheduled page, its
/// detail panel, the drafts the quick-add line made, and the cards a conversation or Waiting on you draws. Owned
/// by `AppModel` and rebuilt per instance, like the other section stores. What the server answered is what is
/// drawn; every press reads its answer back. The words and the rules are OrbitKit's (`ScheduleCopy`,
/// `ScheduleDisplay`).
@MainActor
@Observable
final class ScheduledModel {
    /// Every schedule not ended, each with its last run.
    private(set) var schedules: [ScheduleView] = []
    /// The runs of the page's window the list carried (each under way, and the ended ones of the last 24 hours);
    /// nil from a server that sends none, where each schedule's detail read stands in.
    private(set) var listRuns: [ScheduleRunView]?
    /// The OPEN tasks waiting for their startWhen condition: the "Waiting for a condition" group's task rows, or Needs
    /// you when one cannot be read (docs/condition-triggers-design.md §9).
    private(set) var waitingTasks: [ScheduleWaitingTask] = []
    /// Conditions read on their own (the inspector's Condition block, a run's firing, a Waiting on you card), by id.
    private(set) var conditions: [String: ConditionView] = [:]
    /// The account's PENDING create cards: the timeline's dashed rows and the draft panel.
    private(set) var drafts: [ScheduleCard] = []
    /// The inspector's reads, by schedule id.
    private(set) var details: [String: ScheduleDetailResponse] = [:]
    /// Cards read on their own (a widen item's), by request id.
    private(set) var cards: [String: ScheduleCard] = [:]
    /// A run's pending approval (a SCHEDULE_APPROVAL item's), by approval id.
    private(set) var approvals: [String: ApprovalInfo] = [:]
    /// The first read has come back.
    private(set) var loaded = false
    /// The list answered 404: a server before scheduled tasks. The drawer row stays away.
    private(set) var unsupported = false

    /// The ⋯ menu's Show past runs.
    var showPastRuns = false
    /// All workspaces, or one.
    var workspaceFilter: String?
    /// The schedule whose detail panel is up.
    var inspectedID: String?
    /// The schedule whose title the Mac's detail panel is editing in place (Rename…, §8.4).
    var renamingID: String?
    /// The draft panel: the sentence typed and the session it opened.
    var draftPanel: DraftPanel?
    /// The draft change conversation (§8.2, board 03-change ③): Orbit's opening and a composer, before any
    /// session exists. The person's first words open the change conversation, and the page gives way to it.
    var changeDraft: ChangeDraft?
    /// The last refusal a press came back with, said once under what was pressed.
    var errorText: String?

    struct DraftPanel: Equatable, Identifiable {
        let sessionID: String
        let typed: String
        var id: String { sessionID }
    }

    /// The schedule the draft change conversation is about.
    struct ChangeDraft: Equatable, Identifiable {
        let scheduleID: String
        var id: String { scheduleID }
    }

    /// The viewer's zone: the timeline's days, and the zone a create card naming none is allowed in.
    var timezone: String { TimeZone.current.identifier }

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    init(api: APIClient) {
        self.api = api
    }

    // MARK: reads

    /// The drawer's number: held, failing with no run under way, or a condition that cannot be read; nothing at zero.
    /// The list's runs say which failing ones are already running again (owner 2026-11-19).
    var needsYouCount: Int {
        ScheduleDisplay.needsYouCount(schedules, waitingTasks: waitingTasks,
                                      runs: listRuns ?? schedules.compactMap(\.lastRun))
    }

    /// The count beside the page title (board ②): what the timeline lists.
    var listedCount: Int { shownSchedules.count + drafts.count + shownWaitingTasks.count }

    var shownWaitingTasks: [ScheduleWaitingTask] {
        waitingTasks.filter { workspaceFilter == nil || $0.workspaceId == workspaceFilter }
    }

    var shownSchedules: [ScheduleView] {
        schedules.filter { $0.state != "ENDED" && (workspaceFilter == nil || $0.workspaceId == workspaceFilter) }
    }

    /// The workspaces the filter offers: the ones a schedule runs in, by name.
    var workspaces: [(id: String, name: String)] {
        var seen: [String: String] = [:]
        for s in schedules where seen[s.workspaceId] == nil { seen[s.workspaceId] = s.workspaceName ?? s.workspaceId }
        for t in waitingTasks where seen[t.workspaceId] == nil { seen[t.workspaceId] = t.workspaceName ?? t.workspaceId }
        return seen.map { (id: $0.key, name: $0.value) }.sorted { $0.name < $1.name }
    }

    /// The runs the timeline places: the list's, or else each schedule's last run and the recent runs its detail read
    /// brought (Show past runs lists today's). A row reads them too, to keep a Failed tag off while a run is under way.
    var timelineRuns: [ScheduleRunView] {
        let shown = shownSchedules
        let ids = Set(shown.map(\.id))
        if let listRuns { return listRuns.filter { ids.contains($0.scheduleId) } }
        var runs: [ScheduleRunView] = []
        var seen = Set<String>()
        for s in shown {
            for run in [s.lastRun].compactMap({ $0 }) + (detail(s.id)?.recentRuns ?? []) where seen.insert(run.id).inserted {
                runs.append(run)
            }
        }
        return runs
    }

    func timeline(now: Date = Date()) -> [ScheduleDisplay.TimelineGroup] {
        let shown = shownSchedules
        let runs = timelineRuns
        let drafts = workspaceFilter == nil ? self.drafts : self.drafts.filter { $0.runsIn?.workspaceId == workspaceFilter }
        return ScheduleDisplay.timeline(schedules: shown, runs: runs, drafts: drafts, waitingTasks: shownWaitingTasks,
                                        showPastRuns: showPastRuns, now: now, timezone: timezone)
    }

    func schedule(_ id: String) -> ScheduleView? {
        let key = PublicID.storageKey(id)
        return details.first { PublicID.storageKey($0.key) == key }?.value.schedule
            ?? schedules.first { PublicID.storageKey($0.id) == key }
    }

    func detail(_ id: String) -> ScheduleDetailResponse? {
        let key = PublicID.storageKey(id)
        return details.first { PublicID.storageKey($0.key) == key }?.value
    }

    func load() async {
        guard !unsupported else { return }
        do {
            let list = try await api.scheduleList()
            if list.schedules != schedules { schedules = list.schedules }
            if list.runs != listRuns { listRuns = list.runs }
            let waiting = list.waitingTasks ?? []
            if waiting != waitingTasks { waitingTasks = waiting }
            if let drafts = try? await api.scheduleDrafts(), drafts != self.drafts { self.drafts = drafts }
            loaded = true
        } catch APIError.http(let status, _) where status == 404 {
            unsupported = true
        } catch {
            // The next read tries again; what was drawn stays.
        }
    }

    func loadDetail(_ id: String) async {
        guard let detail = try? await api.schedule(id) else { return }
        if details[id] != detail { details[id] = detail }
    }

    /// A condition's own read: its state, newest samples and events.
    func loadCondition(_ id: String) async {
        guard let condition = try? await api.condition(id) else { return }
        if conditions[id] != condition { conditions[id] = condition }
    }

    func condition(_ id: String?) -> ConditionView? {
        guard let id else { return nil }
        let key = PublicID.storageKey(id)
        return conditions.first { PublicID.storageKey($0.key) == key }?.value
    }

    func loadCard(_ id: String) async {
        guard let card = try? await api.scheduleRequest(id) else { return }
        if cards[id] != card { cards[id] = card }
    }

    func loadApproval(sessionID: String, approvalID: String) async {
        guard let list = try? await api.approvals(sessionID: sessionID) else { return }
        if let found = list.first(where: { PublicID.storageKey($0.id) == PublicID.storageKey(approvalID) }) {
            approvals[approvalID] = found
        }
    }

    /// The run a session belongs to, and its schedule: from the list's last runs, then each schedule's history.
    func runContext(sessionID: String) async -> (schedule: ScheduleView, run: ScheduleRunView)? {
        let key = PublicID.storageKey(sessionID)
        let matches: (ScheduleRunView) -> Bool = { $0.sessionId.map(PublicID.storageKey) == key }
        if schedules.isEmpty { await load() }
        for s in schedules {
            if let run = s.lastRun, matches(run) { return (s, run) }
        }
        for detail in details.values {
            if let run = detail.recentRuns.first(where: matches) { return (detail.schedule, run) }
        }
        for s in schedules {
            guard let runs = try? await api.scheduleRuns(s.id) else { continue }
            if let run = runs.first(where: matches) { return (s, run) }
        }
        return nil
    }

    // MARK: presses

    /// What a press on a card came to: done, withdrawn by the server (409 SCHEDULE_REQUEST_STALE: shown, not
    /// retried), or refused (said, and the card can be pressed again).
    enum PressResult: Equatable {
        case done
        case withdrawn(String)
        case refused(String)

        var said: String? {
            switch self {
            case .done: return nil
            case .withdrawn(let s), .refused(let s): return s
            }
        }

        /// The card's buttons go: it was decided, or it can no longer be.
        var settled: Bool {
            if case .refused = self { return false }
            return true
        }
    }

    @discardableResult func runNow(_ id: String) async -> String? {
        await control(id) { try await self.api.runScheduleNow(id) }
    }

    /// Run now from a run's session: the refusal's sentence, or the session of the run it started (web opens it).
    func runNowSession(_ id: String) async -> (said: String?, sessionID: String?) {
        var started: String?
        let said = await control(id) {
            let answer = try await self.api.runScheduleNow(id)
            started = answer.run.sessionId
            return answer
        }
        return (said, said == nil ? started : nil)
    }

    @discardableResult func pause(_ id: String) async -> String? {
        await control(id) { try await self.api.pauseSchedule(id) }
    }

    @discardableResult func resume(_ id: String) async -> String? {
        await control(id) { try await self.api.resumeSchedule(id) }
    }

    @discardableResult func delete(_ id: String) async -> String? {
        let said = await control(id) { try await self.api.deleteSchedule(id) }
        if said == nil, inspectedID == id { inspectedID = nil }
        return said
    }

    @discardableResult func undo(_ id: String, revision: Int) async -> String? {
        await control(id) { try await self.api.undoSchedule(id, revision: revision) }
    }

    /// Rename (§8.4): the title alone, applied at once.
    @discardableResult func rename(_ id: String, title: String) async -> String? {
        await control(id) { try await self.api.renameSchedule(id, title: title) }
    }

    @discardableResult func stop(runID: String, scheduleID: String) async -> String? {
        await control(scheduleID) { try await self.api.stopScheduleRun(runID) }
    }

    private func control<T>(_ id: String, _ press: @escaping () async throws -> T) async -> String? {
        errorText = nil
        var said: String?
        do {
            _ = try await press()
        } catch {
            said = Self.refusal(error)
            errorText = said
        }
        await load()
        await loadDetail(id)
        return said
    }

    /// Allow a card. A create card naming no zone is allowed in this device's zone.
    func allow(_ card: ScheduleCard) async -> PressResult {
        let zone = card.isCreate && card.when?.timezone == nil ? timezone : nil
        return await decide(card) { try await self.api.allowScheduleRequest(card.id, timezone: zone) }
    }

    func decline(_ card: ScheduleCard) async -> PressResult {
        await decide(card) { try await self.api.declineScheduleRequest(card.id) }
    }

    private func decide(_ card: ScheduleCard, _ press: () async throws -> ScheduleDecisionOutcome) async -> PressResult {
        errorText = nil
        var result = PressResult.done
        do {
            switch try await press() {
            case .decided(let answered): if let answered { cards[card.id] = answered }
            case .stale(let message): result = .withdrawn(message.isEmpty ? Self.withdrawn : message)
            }
        } catch {
            result = .refused(Self.refusal(error))
        }
        await load()
        await loadCard(card.id)
        return result
    }

    /// Change… (§8.2): the schedule's open change conversation, or the opening a new one would start with.
    /// A failure is said in `errorText`, like every other press.
    func changeConversation(_ id: String) async -> ScheduleChangeConversationResponse? {
        errorText = nil
        do {
            return try await api.scheduleChangeConversation(id)
        } catch {
            errorText = Self.refusal(error)
            return nil
        }
    }

    /// The person's first words: opens the change conversation, or — `created` false, another device opened
    /// one meanwhile — says them in that one and answers it.
    func openChangeConversation(_ id: String, text: String) async -> ScheduleChangeAnswer? {
        errorText = nil
        do {
            return try await api.openScheduleChange(id, text: text)
        } catch {
            errorText = Self.refusal(error)
            return nil
        }
    }

    /// The quick-add line: the sentence opens a conversation in the workspace on its right; the draft panel
    /// follows the card its agent drafts there.
    func ask(_ text: String, workspaceID: String) async -> Bool {
        errorText = nil
        do {
            let answer = try await api.createScheduleDraft(workspaceID: workspaceID, text: text)
            draftPanel = DraftPanel(sessionID: answer.sessionId, typed: text)
            return true
        } catch {
            errorText = Self.refusal(error)
            return false
        }
    }

    /// The draft the panel's conversation produced, once its agent has drafted it.
    func draft(forSession sessionID: String) -> ScheduleCard? {
        let key = PublicID.storageKey(sessionID)
        return drafts.first { $0.askedBySessionId.map(PublicID.storageKey) == key }
    }

    /// The approval a run waits on, answered from Waiting on you as it would be on its card.
    func decideApproval(sessionID: String, approvalID: String, allow: Bool, always: Bool) async -> String? {
        var rules: [PermissionRule]?
        if always, let info = approvals[approvalID], let tool = info.toolName, let input = info.input {
            rules = Approvals.rememberRules(toolName: tool, input: input)
        }
        do {
            try await api.decideApproval(sessionID: sessionID, approvalID: approvalID,
                                         ApprovalDecisionRequest(behavior: allow ? .allow : .deny, rememberRules: rules))
            approvals[approvalID] = nil
            return nil
        } catch {
            return Self.refusal(error)
        }
    }

    /// The server's own sentence for a refusal, else what went wrong in plain words.
    static func refusal(_ error: Error) -> String {
        ScheduleDisplay.pressFailure(error)
    }

    static let unreachable = ScheduleDisplay.PressFailure.unreachable
    static let withdrawn = "This card was withdrawn."
}
