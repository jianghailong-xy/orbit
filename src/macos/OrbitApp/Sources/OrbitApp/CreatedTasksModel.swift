import Foundation
import Observation
import OrbitKit

/// What the "Tasks created here" card above one session's composer is drawn from: the session's
/// `GET /sessions/:id/created-tasks`, read when the console is focused, again when a task event or a
/// reconnect says a task may have moved, and every 15s while a row is running or queued. Owned by
/// `ConsoleModel` (`console.createdTasks`) and rendered by `CreatedTasksCard`.
///
/// The poll is started and stopped with the console's stream (`startStreaming` / `stopStreaming`),
/// from the app's focus state, for the reason `WorktreeModel`'s is: a `.task` on the pushed iPhone
/// console can stop iterating while the card is still on screen.
@MainActor
@Observable
final class CreatedTasksModel {
    private let sessionID: String
    private let api: APIClient

    /// The last answer. Nil until the first read lands, and kept through a failed one so a blip
    /// doesn't blank the card.
    private(set) var snapshot: SessionCreatedTasks?

    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?
    /// The last read failed on the way there (not the server saying there is nothing to read), so
    /// the next tick asks again even with no live row to watch.
    @ObservationIgnored private var retryDue = false

    private static let pollInterval: UInt64 = 15_000_000_000
    /// One read for a burst of task events, the same window the watches and projects use.
    private static let nudgeDelay: UInt64 = 2_000_000_000

    init(sessionID: String, api: APIClient) {
        self.sessionID = sessionID
        self.api = api
    }

    func load() async {
        guard !sessionID.isEmpty else { return }
        generation &+= 1
        let current = generation
        do {
            let next = try await api.sessionCreatedTasks(sessionID: sessionID)
            // A read that started later owns the card; this one's answer may predate it.
            guard current == generation else { return }
            retryDue = false
            if next != snapshot { snapshot = next }
        } catch APIError.http(let status, _) where status == 404 {
            // A server without the route, or a session that is gone: asking again changes nothing.
            if current == generation { retryDue = false }
        } catch {
            if current == generation { retryDue = true }
        }
    }

    /// Read now, then every 15s while a row is running or queued. Cancelled with the stream when the
    /// session loses focus; the next focus reads again first.
    func startPolling() async {
        await load()
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: Self.pollInterval)
            if Task.isCancelled { break }
            if retryDue || snapshot?.hasLiveRows == true { await load() }
        }
    }

    /// A task may have moved: read again shortly, once for a burst.
    func nudge() {
        guard !sessionID.isEmpty, nudgeTask == nil else { return }
        nudgeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.nudgeDelay)
            guard let self else { return }
            self.nudgeTask = nil
            await self.load()
        }
    }
}

extension AppModel {
    /// Tell the focused console's "Tasks created here" card that a task may have moved. With a
    /// `taskID` (a run starting or settling on it) only a card that draws that task reads again; a
    /// task event or a reconnect can be about a task the card doesn't hold yet, so those always do.
    func nudgeCreatedTasks(taskID: String? = nil) {
        guard let id = focusedConsoleSessionID,
              let createdTasks = consoleRegistry?.peek(id)?.createdTasks else { return }
        if let taskID, createdTasks.snapshot?.draws(taskID: taskID) != true { return }
        createdTasks.nudge()
    }

    /// The card's `View all in Tasks ›`: the Tasks page, narrowed to what that session created, on
    /// every status. The same moves a link to a list makes (`route(to: .list)`), with the session in
    /// place of the list.
    func showTasksCreated(inSession sessionID: String, title: String) {
        selectedSection = .tasks
        taskListsDirectoryPresented = false
        tasks?.showCreated(in: TaskCreatorFilter(sessionID: sessionID, sessionTitle: title))
        selectedTaskID = nil
    }
}
