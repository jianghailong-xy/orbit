import Foundation
import Observation
import OrbitKit

/// One console's view of its workspace's main checkout (docs/main-checkout-git-contract.md): the read
/// behind the review sheet, its file selection and patches, and the four actions. Owned by
/// `ConsoleModel` (`console.mainCheckout`); the card, the bar, the result lines and the sheet draw
/// from it. Every word and rule they show is in OrbitKit's `MainCheckoutCopy`.
@MainActor
@Observable
final class MainCheckoutModel {
    private let sessionID: String
    private let api: APIClient

    /// The sheet is open for this workspace.
    var reviewWorkspaceID: String?
    private(set) var read: MainCheckoutRead?
    private(set) var loading = false
    private(set) var loadError: String?
    var selection = MainCheckoutSelection(files: [])
    var message = ""
    /// The file whose diff the sheet shows.
    var focusedPath: String?
    private(set) var diffs: [String: MainCheckoutFileDiff] = [:]
    private(set) var diffLoading: Set<String> = []
    /// An action is on its way to the server.
    private(set) var sending = false
    /// Cards the person answered Leave as is (by row id). Held for this console's life.
    var dismissedCards: Set<String> = []
    /// Requests this device sent and their answer, so a waiting line's Cancel knows its workspace.
    private(set) var sentWorkspace: [String: String] = [:]
    /// Toasts go to the app's host. Wired by `ConsoleModel`.
    @ObservationIgnored var onOutcome: (ToastRequest) -> Void = { _ in }

    init(sessionID: String, api: APIClient) {
        self.sessionID = sessionID
        self.api = api
    }

    /// Open the review sheet on a fresh read: every file chosen, the first one's diff showing.
    func openReview(workspaceID: String) {
        reviewWorkspaceID = workspaceID
        Task { await load(workspaceID: workspaceID) }
    }

    func load(workspaceID: String) async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let next = try await api.mainCheckout(workspaceId: workspaceID)
            read = next
            selection = MainCheckoutSelection(files: next.snapshot.files)
            diffs = [:]
            focusedPath = next.snapshot.files.first?.path
            if let first = focusedPath { await loadDiff(workspaceID: workspaceID, path: first) }
        } catch {
            loadError = APIClient.failureReason(error)
        }
    }

    func loadDiff(workspaceID: String, path: String) async {
        guard diffs[path] == nil, !diffLoading.contains(path) else { return }
        diffLoading.insert(path)
        defer { diffLoading.remove(path) }
        if let answer = try? await api.mainCheckout(workspaceId: workspaceID, diff: [path]),
           let diff = answer.diffs?.first(where: { $0.path == path }) {
            diffs[path] = diff
        }
    }

    /// Send one action. The outcome is a line the server writes into this session; a request the server
    /// refuses outright (a 409 without the capability, a 400) is a toast here. True when it was accepted.
    @discardableResult
    func act(workspaceID: String, _ build: (_ requestId: String, _ from: String?) -> MainCheckoutActionPost) async -> Bool {
        let requestId = PublicID.newToken()
        let post = build(requestId, sessionID.isEmpty ? nil : sessionID)
        sending = true
        defer { sending = false }
        do {
            _ = try await api.mainCheckoutAction(workspaceId: workspaceID, post)
            sentWorkspace[requestId] = workspaceID
            return true
        } catch {
            onOutcome(ToastRequest(message: MainCheckoutCopy.actionFailed, detail: APIClient.failureReason(error),
                                   tone: .error))
            return false
        }
    }

    /// The waiting line's Cancel.
    func cancel(workspaceID: String, requestId: String) async {
        do { _ = try await api.cancelMainCheckoutAction(workspaceId: workspaceID, requestId: requestId) }
        catch {
            onOutcome(ToastRequest(message: MainCheckoutCopy.actionFailed, detail: APIClient.failureReason(error),
                                   tone: .error))
        }
    }

    /// A push waiting on the managed-branch warning (the bar's or a line's Push): the read it pushes.
    var pushWarning: MainCheckoutRead?

    /// Push the branch as the runner sees it now: Push checks only the HEAD part of the fingerprint,
    /// so a fresh read's is what the person is pushing. A branch a project lands on asks first
    /// (`pushWarning`); the warning informs and never blocks.
    func push(workspaceID: String) async {
        guard let view = try? await api.mainCheckout(workspaceId: workspaceID) else {
            onOutcome(ToastRequest(message: MainCheckoutCopy.readFailed, tone: .error))
            return
        }
        if view.managedBranch != nil {
            pushWarning = view
        } else {
            await push(view, workspaceID: workspaceID)
        }
    }

    @discardableResult
    func push(_ view: MainCheckoutRead, workspaceID: String) async -> Bool {
        await act(workspaceID: workspaceID) {
            .push(root: view.snapshot.root, fingerprint: view.snapshot.fingerprint, requestId: $0, from: $1)
        }
    }

    /// A blocked checkout's Clean up checkout: today's repair relay (save to a rescue branch, back to HEAD).
    func cleanUp(workspaceID: String) async {
        do { _ = try await api.repoCleanup(workspaceId: workspaceID) }
        catch {
            onOutcome(ToastRequest(message: MainCheckoutCopy.actionFailed, detail: APIClient.failureReason(error),
                                   tone: .error))
        }
    }
}
