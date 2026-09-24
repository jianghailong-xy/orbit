import Foundation
import Observation
import OrbitKit

/// The account's projects, behind the Projects section and the drawer's project rows. Owned by
/// `AppModel` and rebuilt per instance, like the other section stores.
///
/// The control plane has no project event, so the list is refetched: when the section or the
/// drawer appears, on pull-to-refresh, on a short coalesced nudge after a task moved (a task write
/// is what moves a project's lanes), and after every write this client makes.
@MainActor
@Observable
final class ProjectsModel {
    /// Every project, open and closed, as `GET /projects` answered — newest first.
    private(set) var projects: [ProjectSummary] = []
    private(set) var loadState = ListLoadState()

    private let api: APIClient
    /// Handed out from inside view bodies, so reading and filling it must not invalidate them.
    @ObservationIgnored private var details: [String: ProjectDetailModel] = [:]
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?

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

    /// The drawer's project rows: open projects, the ones waiting on the reader first.
    var drawerProjects: [ProjectSummary] { ProjectAttention.drawerProjects(projects) }

    func load() async {
        loadState.begin()
        do {
            let list = try await api.projects()
            if list != projects { projects = list }
            loadState.succeed()
        } catch {
            loadState.fail()
        }
    }

    /// A task moved, and a project's lanes with it maybe: refetch shortly, once for a burst.
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

/// One project's page: its document, lanes, integration line, open items, coordinator and tasks.
@MainActor
@Observable
final class ProjectDetailModel {
    let projectID: String

    private(set) var document: ProjectDocument?
    private(set) var panorama: ProjectPanorama?
    private(set) var integration: ProjectIntegrationView?
    private(set) var openItems: ProjectOpenItemsView?
    private(set) var coordinator: ProjectCoordinatorStatus?
    private(set) var tasks: [ProjectTaskRow] = []
    private(set) var nextTaskCursor: String?
    private(set) var loadingMoreTasks = false
    private(set) var loadState = ListLoadState()
    /// The project is gone (deleted here or elsewhere); the page says so instead of spinning.
    private(set) var missing = false
    /// A write in flight, so its controls do not take a second press.
    private(set) var busy = false
    /// Whether a page is showing this project — what a nudge refreshes.
    var isVisible = false

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
    func load() async {
        loadState.begin()
        async let documentRead = api.project(projectID)
        async let panoramaRead = api.projectPanorama(projectID)
        async let integrationRead = api.projectIntegration(projectID)
        async let openItemsRead = api.projectOpenItems(projectID: projectID)
        async let coordinatorRead = api.projectCoordinatorStatus(projectID)
        async let tasksRead = api.projectTaskPage(projectID)
        do {
            let fetched = try await documentRead
            document = fetched
            missing = false
            loadState.succeed()
        } catch APIError.http(let status, _) where status == 404 {
            missing = true
            loadState.succeed()
        } catch {
            loadState.fail()
        }
        panorama = (try? await panoramaRead) ?? panorama
        integration = (try? await integrationRead) ?? integration
        openItems = (try? await openItemsRead) ?? openItems
        coordinator = (try? await coordinatorRead) ?? coordinator
        if let page = try? await tasksRead {
            tasks = page.items
            nextTaskCursor = page.nextCursor
        }
    }

    func loadMoreTasks() async {
        guard let cursor = nextTaskCursor, !loadingMoreTasks else { return }
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

    /// Flip the Automatic switch, fenced on the revision the page read.
    func setAutomatic(_ enabled: Bool) async -> String? {
        guard let revision = document?.configRevision else {
            return "Couldn't change Automatic: reload the project and try again."
        }
        return await write("change Automatic") {
            self.document = try await self.api.setProjectAutomatic(self.projectID, enabled: enabled,
                                                                   expectedConfigRevision: revision)
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

    /// Resolve-or-create the coordinator conversation. Throws the sentence to show.
    func openCoordinator() async -> Result<ProjectCoordinatorOpened, ProjectActionError> {
        do {
            return .success(try await api.openProjectCoordinator(projectID))
        } catch {
            return .failure(ProjectActionError(
                message: "Couldn't open the coordinator: \(APIClient.failureReason(error))."))
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
