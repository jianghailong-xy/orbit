import Foundation
import Observation
import OrbitKit

/// The account's projects, behind the Projects section and the drawer's project rows. Owned by
/// `AppModel` and rebuilt per instance, like the other section stores.
///
/// The list is refetched: when the section or the drawer appears, on pull-to-refresh, on a short
/// coalesced nudge after a project changed or a member session or task moved (a task write
/// is what moves a project's lanes), after every write this client makes, and every 15 seconds
/// while loaded: integration jobs can move without changing a task or session.
@MainActor
@Observable
final class ProjectsModel {
    /// Every project, open and closed, as `GET /projects` answered — newest first.
    private(set) var projects: [ProjectSummary] = []
    /// The slimmer open-project summaries, including the session list's stored task progress.
    private(set) var sidebarProjects: [ProjectSummary] = []
    private(set) var loadState = ListLoadState()

    private let api: APIClient
    /// Handed out from inside view bodies, so reading and filling it must not invalidate them.
    @ObservationIgnored private var details: [String: ProjectDetailModel] = [:]
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?
    @ObservationIgnored private var refreshNotBefore = Date.distantPast

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// By either spelling of its id: a link may name the UUID while the list spells it base62.
    func project(_ id: String) -> ProjectSummary? {
        let key = PublicID.storageKey(id)
        return projects.first { PublicID.storageKey($0.id) == key }
    }

    /// How many projects have something waiting on the reader in person — the drawer's count.
    var needsYouCount: Int { ProjectAttention.needsYouCount(projects) }

    /// The drawer's project rows: open projects, the ones waiting on the reader first, then the most
    /// recently active — a coordinator's live turns counted beside the fetched task activity.
    func drawerProjects(coordinators: [String: ProjectCoordinatorPulse]) -> [ProjectSummary] {
        ProjectAttention.drawerProjects(projects, coordinators: coordinators)
    }

    func load() async {
        loadState.begin()
        async let sidebarRead = api.sidebarProjects()
        do {
            let list = try await api.projects()
            if list != projects { projects = list }
            loadState.succeed()
        } catch {
            loadState.fail()
        }
        if let list = try? await sidebarRead, list != sidebarProjects { sidebarProjects = list }
    }

    /// Called by the app's existing polling task, which stops on sign-out.
    func refreshIfDue(now: Date = Date()) async {
        guard loadState.hasLoaded, now >= refreshNotBefore else { return }
        refreshNotBefore = now.addingTimeInterval(15)
        await load()
        for detail in details.values where detail.isVisible { await detail.load(refreshGraph: false) }
    }

    /// A project or its member changed: refetch shortly, once for a burst.
    func nudge() {
        guard nudgeTask == nil, loadState.hasLoaded else { return }
        nudgeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let self else { return }
            self.nudgeTask = nil
            await self.load()
            for detail in self.details.values where detail.isVisible { await detail.load() }
        }
    }

    /// The one store per project page, kept while the app runs so going back and forth does not
    /// start every page from a spinner.
    func detail(_ id: String) -> ProjectDetailModel {
        let key = PublicID.storageKey(id)
        if let existing = details[key] { return existing }
        let model = ProjectDetailModel(projectID: id, api: api) { [weak self] in
            Task { await self?.load() }
        }
        details[key] = model
        return model
    }
}

/// One project's page: its document, lanes, integration line, open items, coordinator, dependency
/// graph, run queue and tasks.
@MainActor
@Observable
final class ProjectDetailModel {
    let projectID: String

    private(set) var document: ProjectDocument?
    private(set) var panorama: ProjectPanorama?
    private(set) var integration: ProjectIntegrationView?
    /// The integration read failed and there is no earlier answer to draw — what How it runs says
    /// instead of a spinner that never ends.
    private(set) var integrationUnread = false
    private(set) var integrationReadAt: Date?
    private(set) var integrationReadFailed = false
    private(set) var openItems: ProjectOpenItemsView?
    /// A failed first read must not leave the Open items panel spinning or claim there are none.
    private(set) var openItemsUnread = false
    private(set) var coordinator: ProjectCoordinatorStatus?
    private(set) var graph: ProjectDependencyGraph?
    private(set) var readyQueue: ProjectReadyToRun?
    private(set) var readyQueueUnread = false
    /// What has been asked about work crossing into or out of this project (`ProjectCrossings`),
    /// and whether that read failed with no earlier answer to draw.
    private(set) var crossings: [ProjectCrossing]?
    private(set) var crossingsUnread = false
    /// The crossing an answer is on its way for: its row says so and takes no second press.
    private(set) var answeringCrossing: String?
    /// Run-queue rows a Run press is starting: the row says so until the next read has it running.
    private(set) var starting: Set<String> = []
    private(set) var tasks: [ProjectTaskRow] = []
    private(set) var nextTaskCursor: String?
    private(set) var loadingMoreTasks = false
    @ObservationIgnored private var refreshing = false
    private(set) var loadState = ListLoadState()
    /// The project is gone (deleted here or elsewhere); the page says so instead of spinning.
    private(set) var missing = false
    /// A write in flight, so its controls do not take a second press.
    private(set) var busy = false
    /// Whether a page is showing this project — what a nudge refreshes.
    var isVisible = false
    /// The criteria's standing — the seal a start confirms — read when the owner's own Start… opens,
    /// and whether that read failed: a card that cannot name the version it confirms offers no press.
    private(set) var confirmation: StandardSetConfirmationStanding?
    private(set) var confirmationUnread = false
    /// At most, as the Stepper has it while the write it will make waits for the presses to stop:
    /// each press moves the number at once, and one write carries where it stopped.
    private(set) var pendingConcurrency: Int?
    @ObservationIgnored private var concurrencyWrite: Task<Void, Never>?

    private let api: APIClient
    /// Tell the list a write changed what its row says.
    private let onChanged: () -> Void

    init(projectID: String, api: APIClient, onChanged: @escaping () -> Void) {
        self.projectID = projectID
        self.api = api
        self.onChanged = onChanged
    }

    /// Every read the page draws, side by side. The document is the one the page cannot draw
    /// without; the others each leave their own card out when they fail.
    func load(refreshGraph: Bool = true) async {
        guard !refreshing, !loadingMoreTasks else { return }
        refreshing = true
        defer { refreshing = false }
        loadState.begin()
        // Keep these reads concurrent without `async let`: iOS 27's concurrency runtime can abort
        // while tearing down several async-let result buffers in one continuation. Explicit task
        // handles keep each result on its own allocation and preserve the page's parallel reads.
        let documentRead = Task { try await api.project(projectID) }
        let panoramaRead = Task { try await api.projectPanorama(projectID) }
        let integrationRead = Task { try await api.projectIntegration(projectID) }
        let openItemsRead = Task { try await api.projectOpenItems(projectID: projectID) }
        let coordinatorRead = Task { try await api.projectCoordinatorStatus(projectID) }
        let graphRead: Task<ProjectDependencyGraph, Error>? = refreshGraph
            ? Task { try await api.projectDependencyGraph(projectID) }
            : nil
        let queueRead = Task { try await api.projectReadyToRun(projectID) }
        let tasksRead = Task { try await refreshedTaskWindow(count: max(100, tasks.count)) }
        let crossingsRead = Task { try await api.projectCrossings(projectID: projectID) }
        defer {
            documentRead.cancel()
            panoramaRead.cancel()
            integrationRead.cancel()
            openItemsRead.cancel()
            coordinatorRead.cancel()
            graphRead?.cancel()
            queueRead.cancel()
            tasksRead.cancel()
            crossingsRead.cancel()
        }
        do {
            let fetched = try await documentRead.value
            document = fetched
            missing = false
            loadState.succeed()
        } catch APIError.http(let status, _) where status == 404 {
            missing = true
            loadState.succeed()
        } catch {
            loadState.fail()
        }
        panorama = (try? await panoramaRead.value) ?? panorama
        if let view = try? await integrationRead.value {
            integration = view
            integrationUnread = false
            integrationReadAt = Date()
            integrationReadFailed = false
        } else {
            integrationUnread = integration == nil
            integrationReadFailed = true
        }
        if let items = try? await openItemsRead.value {
            openItems = items
            openItemsUnread = false
        } else {
            openItemsUnread = openItems == nil
        }
        coordinator = (try? await coordinatorRead.value) ?? coordinator
        if let graphRead {
            graph = (try? await graphRead.value) ?? graph
        }
        if let queue = try? await queueRead.value {
            readyQueue = queue
            readyQueueUnread = false
        } else {
            readyQueueUnread = true
        }
        if let page = try? await tasksRead.value {
            tasks = page.items
            nextTaskCursor = page.nextCursor
        }
        if let rows = try? await crossingsRead.value {
            crossings = rows
            crossingsUnread = false
        } else {
            crossingsUnread = crossings == nil
        }
    }

    /// Refresh every loaded page so a polling tick neither collapses the list nor leaves its tail stale.
    private func refreshedTaskWindow(count: Int) async throws -> ProjectTaskPage {
        var items: [ProjectTaskRow] = []
        var cursor: String?
        repeat {
            let page = try await api.projectTaskPage(projectID, cursor: cursor,
                                                    limit: min(200, count - items.count))
            items += page.items
            cursor = page.nextCursor
        } while items.count < count && cursor != nil
        return ProjectTaskPage(items: items, nextCursor: cursor)
    }

    func loadMoreTasks() async {
        guard let cursor = nextTaskCursor, !loadingMoreTasks, !refreshing else { return }
        loadingMoreTasks = true
        defer { loadingMoreTasks = false }
        guard let page = try? await api.projectTaskPage(projectID, cursor: cursor) else { return }
        let known = Set(tasks.map(\.id))
        tasks += page.items.filter { !known.contains($0.id) }
        nextTaskCursor = page.nextCursor
    }

    /// Record the project done or cancelled, or reopen it. Nil when it went through; otherwise the
    /// sentence to show.
    func setStatus(_ status: ProjectStatus) async -> String? {
        await write("change the project's status") {
            self.document = try await self.api.updateProjectStatus(self.projectID, to: status)
        }
    }

    // MARK: How it runs

    /// Automatic, or the concurrency limit — How it runs' half of the authorization set, fenced on
    /// the revision the page read. `automatic`, never `coordinatorEnabled`: the server reads an
    /// older client's off as a pause too, and switching Automatic off no longer stops the project.
    func updateAuthorization(automatic: Bool? = nil, maxConcurrentTasks: Int? = nil) async -> String? {
        guard let revision = document?.configRevision else {
            return "\(RunSettings.notSaved) — reload the project and try again."
        }
        return await runWrite(RunSettings.notSaved) {
            self.document = try await self.api.updateProjectAuthorization(
                self.projectID, UpdateProjectAuthorizationRequest(automatic: automatic,
                                                                  maxConcurrentTasks: maxConcurrentTasks,
                                                                  expectedConfigRevision: revision))
        }
    }

    /// One press of At most's Stepper: the number moves now, and the write goes once the presses
    /// stop — one write for a run of presses, rather than a write per press racing the revision the
    /// one before it moved.
    func stepConcurrency(to count: Int, onFailure: @escaping (String) -> Void) {
        pendingConcurrency = count
        concurrencyWrite?.cancel()
        concurrencyWrite = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let self, !Task.isCancelled else { return }
            if count != self.document?.maxConcurrentTasks,
               let failure = await self.updateAuthorization(maxConcurrentTasks: count) {
                onFailure(failure)
            }
            if self.pendingConcurrency == count { self.pendingConcurrency = nil }
        }
    }

    /// The line, the merge check or the escalation window (`PATCH /projects/:id/integration`). Nil
    /// when there is nothing to send.
    func updateIntegration(_ body: UpdateProjectIntegrationRequest?) async -> String? {
        guard let body, !body.isEmpty else { return nil }
        return await runWrite(RunSettings.notSaved) {
            self.integration = try await self.api.updateProjectIntegration(self.projectID, body)
        }
    }

    /// Pause project, or Resume project — the owner's, and a press rather than a setting: it stops
    /// the project moving at once, and resuming undoes it.
    func setPaused(_ paused: Bool) async -> String? {
        await runWrite(paused ? RunSettings.notPaused : RunSettings.notResumed) {
            if paused {
                _ = try await self.api.pauseProject(self.projectID)
            } else {
                _ = try await self.api.resumeProject(self.projectID)
            }
        }
    }

    // MARK: the owner's own start

    /// What the owner's own Start… card needs beyond the page's reads: the seal a press confirms.
    func loadStartCard() async {
        do {
            confirmation = try await api.acceptanceConfirmation(projectID: projectID)
            confirmationUnread = false
        } catch {
            confirmationUnread = true
        }
    }

    /// Start the project from the owner's own card — the same door the conversation's card presses,
    /// with no request to answer. Nil when it went through; otherwise what the card says.
    func startProject(_ body: StartProjectRequestBody) async -> String? {
        await runWrite(StartProject.notRecorded) {
            try await self.api.startProject(projectID: self.projectID, body)
        }
    }

    // MARK: the owner's record of done

    /// What "Is this project done?" over the page needs beyond the page's reads: the seal standing
    /// now — what a press names when nobody asked — and when the owner confirmed it.
    func loadDoneCard() async {
        await loadStartCard()
    }

    /// Record the project done from the card over the page (`POST /projects/:id/done`) — the
    /// coordinator's request when it asked, the owner's own record when nobody did. The record, or
    /// what the card says when the door did not take it.
    func recordDone(_ body: ProjectDoneRequestBody) async -> Result<ProjectDoneRecord, ProjectActionError> {
        guard !busy else { return .failure(ProjectActionError(message: ProjectDone.notRecorded)) }
        busy = true
        defer { busy = false }
        do {
            let record = try await api.recordProjectDone(projectID: projectID, body)
            onChanged()
            await load()
            return .success(record)
        } catch {
            await load()
            return .failure(ProjectActionError(message: APIClient.failureReason(error)))
        }
    }

    /// "Not yet…" on the coordinator's request: the note goes to the coordinator, and the request
    /// ends. Nil when it went through; otherwise the sentence to show.
    func declineDone(itemID: String, note: String) async -> String? {
        await runWrite(ProjectDone.notDeclined) {
            _ = try await self.api.declineDoneRequest(projectID: self.projectID, itemID: itemID, note: note)
        }
    }

    /// Remove the project. Only an empty one can go; the server's refusal says how many tasks it
    /// still holds.
    func delete() async -> String? {
        await write("delete the project") {
            try await self.api.deleteProject(self.projectID)
            self.missing = true
        }
    }

    /// Lift the coordinator's pause.
    func resumeFuse(episodeID: String) async -> String? {
        await write("resume the coordinator") {
            _ = try await self.api.resumeProjectFuse(projectID: self.projectID, episodeID: episodeID)
        }
    }

    /// End a blocker, with the reason the server records beside who gave it.
    func resolveBlocker(_ blockerID: String, reason: String) async -> String? {
        await write("resolve the blocker") {
            try await self.api.resolveProjectBlocker(projectID: self.projectID, blockerID: blockerID,
                                                     reason: reason)
        }
    }

    /// Answer a crossing from its row's second press. Nil when the door took it — a yes to a move
    /// has moved the task by then — and the page re-reads, so the row says what the answer left;
    /// otherwise the door's own code and reason, for the row it was given on.
    func decideCrossing(_ crossing: ProjectCrossing,
                        _ decision: ProjectCrossingDecision) async -> ProjectCrossings.Refusal? {
        guard answeringCrossing == nil else { return nil }
        answeringCrossing = crossing.id
        defer { answeringCrossing = nil }
        do {
            try await api.decideProjectCrossing(projectID: projectID, crossing: crossing, decision)
        } catch {
            return ProjectCrossings.refusal(error)
        }
        onChanged()
        await load()
        return nil
    }

    /// Run one ready task from the run queue. The press is named here, once — see
    /// `TasksModel.execute` — and the row says Starting until the reload has it queued or running.
    func run(_ taskID: String) async -> String? {
        let triggerId = PublicID.newToken()
        starting.insert(taskID)
        defer { starting.remove(taskID) }
        return await write("start the task") {
            try await self.api.executeTask(taskID, triggerId: triggerId)
        }
    }

    /// Lift the pause on the list holding a ready task, so Run is offered for it.
    func resumeList(_ listID: String) async -> String? {
        await write("resume the task list") {
            try await self.api.resumeTaskList(listID, note: ProjectPage.resumeListNote)
        }
    }

    /// Replace the coordinator conversation with an empty one; the server completes an open one first.
    func replaceCoordinator() async -> Result<ProjectCoordinatorOpened, ProjectActionError> {
        busy = true
        defer { busy = false }
        do {
            let opened = try await api.replaceProjectCoordinator(projectID)
            onChanged()
            await load()
            return .success(opened)
        } catch {
            await load()
            return .failure(ProjectActionError(
                message: "Couldn't start a new coordinator: \(APIClient.failureReason(error))."))
        }
    }

    /// Resolve-or-create the coordinator conversation. Throws the sentence to show.
    func openCoordinator() async -> Result<ProjectCoordinatorOpened, ProjectActionError> {
        do {
            return .success(try await api.openProjectCoordinator(projectID))
        } catch {
            return .failure(ProjectActionError(
                message: "Couldn't open the coordinator: \(APIClient.failureReason(error))."))
        }
    }

    /// `write`, for the presses whose refusal the browser says in a sentence of its own — "These
    /// settings were not saved", "The project was not paused" — over the door's own message.
    private func runWrite(_ refused: String, _ body: @escaping () async throws -> Void) async -> String? {
        guard !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            try await body()
            onChanged()
            await load()
            return nil
        } catch {
            await load()
            return "\(refused) — \(APIClient.failureReason(error))."
        }
    }

    private func write(_ what: String, _ body: @escaping () async throws -> Void) async -> String? {
        guard !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            try await body()
            onChanged()
            await load()
            return nil
        } catch {
            await load()
            return "Couldn't \(what): \(APIClient.failureReason(error))."
        }
    }
}

/// A press on the project page that did not go through, in words.
struct ProjectActionError: Error {
    let message: String
}
