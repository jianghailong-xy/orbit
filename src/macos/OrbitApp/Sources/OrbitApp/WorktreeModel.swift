import Foundation
import Observation
import OrbitKit

/// Drives the worktree status bar for one session: the `SessionDetail` snapshot behind the bar, the
/// lazily-fetched per-file diffs, and the commit / merge / resolve-in-session actions with their
/// shared busy flag. Split out of `ConsoleModel` so the console keeps to stream + composer +
/// approvals; owned by it (`console.worktree`) and rendered by `WorktreeBar`. The two callbacks are
/// wired by `ConsoleModel` — the session's live status (poll cadence) and the console status line
/// (action failures) are the only context it needs from its host.
@MainActor
@Observable
final class WorktreeModel {
    private let sessionID: String
    private let api: APIClient

    /// Whether the host session is currently live — drives the poll cadence. Wired by `ConsoleModel`.
    @ObservationIgnored var isSessionLive: () -> Bool = { false }
    /// Surface a user-facing status line ("Commit failed"…) on the host console. Wired by `ConsoleModel`.
    /// Every outcome of a worktree action — success and failure alike — goes to the app's toast
    /// host, which is where web puts them too (`sessionNotice`): a merge result is a session result,
    /// not a comment on what you just typed, so it doesn't belong in the composer's error line.
    /// Failures carry a warning/error tone, which is what keeps them on screen until dismissed.
    @ObservationIgnored var onOutcome: (ToastRequest) -> Void = { _ in }
    /// Surface a transient, informational status line that auto-dismisses (the resume confirmation).

    /// GET /sessions/:id detail driving the status bar (branch, changedFiles +/− stats, merge /
    /// commit status, targets). Polled while the console is on screen — see `startPolling`.
    private(set) var detail: SessionDetail?
    /// Per-file unified diffs for the expandable diff sheet, fetched lazily when it opens.
    private(set) var diff: [FilePatch] = []
    /// Diff loading has its own state: waiting for a live refresh must not disable Commit/Merge or
    /// race their shared action flag back to false.
    private(set) var diffLoading = false
    private(set) var diffRefreshing = false
    private(set) var busy = false
    @ObservationIgnored private var diffLoadGeneration = 0

    /// Web uses the same two-second cadence and gives the runner eight chances to publish the
    /// freshly recomputed snapshot (about 16 seconds total).
    private static let diffRefreshPolls = 8
    private static let diffRefreshInterval: UInt64 = 2_000_000_000

    init(sessionID: String, api: APIClient) {
        self.sessionID = sessionID
        self.api = api
    }

    /// Fetch the session detail behind the status bar (branch / changedFiles / merge+commit status).
    /// Best-effort: a failure keeps the last snapshot so a transient blip doesn't blank the bar.
    func loadDetail() async {
        guard !sessionID.isEmpty else { return }
        do {
            let next = try await api.sessionDetail(sessionID)
            surfaceCompletedAction(from: detail, to: next)
            detail = next
        }
        catch { /* keep last */ }
    }

    /// Keep the status bar current while the console is focused, mirroring web's refetch policy:
    /// poll every 3s while a merge/commit is pending (the runner's outcome is ≤1 heartbeat away),
    /// every 5s while the session is live (so a mid-turn diff appears without waiting for turn-end),
    /// and otherwise stay idle — re-checking cheaply so a user-triggered commit/merge (which flips
    /// the status to pending) is picked up. Owned by `ConsoleModel` and cancelled when the session
    /// loses focus (`stopStreaming`), not tied to the bar view's lifecycle — see `startStreaming`.
    func startPolling() async {
        await loadDetail()
        while !Task.isCancelled {
            let pending = detail?.mergeStatus == "pending" || detail?.commitStatus == "pending"
            let live = isSessionLive()
            guard pending || live else {
                // Settled + terminal: nothing to fetch. Wait, then re-evaluate — an action that sets
                // pending (below) will make the next pass enter the 3s outcome poll.
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                continue
            }
            try? await Task.sleep(nanoseconds: pending ? 3_000_000_000 : 5_000_000_000)
            if Task.isCancelled { break }
            await loadDetail()
        }
    }

    func loadDiff() async {
        guard !sessionID.isEmpty else { return }

        // A sheet can be dismissed and reopened while URLSession is still completing the old GET.
        // Only the newest invocation may publish data or clear the visible loading state.
        diffLoadGeneration &+= 1
        let generation = diffLoadGeneration
        diffLoading = true
        diffRefreshing = false
        defer {
            if generation == diffLoadGeneration {
                diffLoading = false
                diffRefreshing = false
            }
        }

        do {
            let patches = try await api.diff(sessionID: sessionID).patches
            guard ownsDiffLoad(generation) else { return }
            diff = patches
        } catch {
            return // keep the last good snapshot, as before
        }

        // Heartbeats can publish a changed-file row before the turn-boundary patch snapshot exists.
        // For a live session, ask its runner for a consistent snapshot now and poll until it lands.
        guard shouldRefreshDiff else { return }
        diffLoading = false
        diffRefreshing = true
        // The POST can reach the server even if its response is lost. Match web by polling anyway;
        // a failed/no-op refresh simply exhausts the same bounded window and falls back gracefully.
        try? await api.refreshDiff(sessionID: sessionID)

        for _ in 0..<Self.diffRefreshPolls {
            do { try await Task.sleep(nanoseconds: Self.diffRefreshInterval) }
            catch { return }
            // Fetch once even if the session just became terminal: turn completion may have
            // published the final committed patch while we were sleeping.
            guard ownsDiffLoad(generation) else { return }
            guard let patches = try? await api.diff(sessionID: sessionID).patches else { continue }
            guard ownsDiffLoad(generation) else { return }
            diff = patches
            // The runner publishes changedFiles and patches together, but they live behind two
            // client endpoints. Refresh the summary too so removed/renamed paths and a just-ended
            // session are evaluated against the same recomputation.
            await loadDetail()
            guard ownsDiffLoad(generation) else { return }
            if !shouldRefreshDiff { return }
        }
    }

    private var canRefreshLiveDiff: Bool {
        // `detail` is authoritative on a cold-opened session. Fall back to the console only for an
        // older/slim server response that omitted status entirely.
        if let status = detail?.effectiveRunStatus { return status.isLive }
        return isSessionLive()
    }

    private var shouldRefreshDiff: Bool {
        WorktreeBarLogic.shouldRefreshDiff(isLive: canRefreshLiveDiff,
                                           changedFiles: detail?.changedFiles ?? [], patches: diff)
    }

    private func ownsDiffLoad(_ generation: Int) -> Bool {
        generation == diffLoadGeneration && !Task.isCancelled
    }

    func commit() async {
        busy = true
        defer { busy = false }
        do { try await api.commit(sessionID: sessionID) }
        catch { onOutcome(Self.failure("Commit failed", error: error)); return }
        // Reflect the pending commit immediately; the poll loop then follows the runner's outcome.
        await loadDetail()
    }

    func merge(target: String?) async {
        busy = true
        defer { busy = false }
        do { try await api.merge(sessionID: sessionID, targetBranch: target) }
        catch { onOutcome(Self.failure("Merge failed", error: error)); return }
        await loadDetail()
    }

    /// Adopt the worktree's actual HEAD branch (after an in-worktree `git checkout -b`) as the
    /// session's tracked branch, so Merge/diff act on the real work instead of a stale "In main".
    /// Pure server-side re-point; reload so the bar re-derives (the divergence flag clears).
    func adopt() async {
        busy = true
        defer { busy = false }
        do { try await api.adoptBranch(sessionID: sessionID) }
        catch { onOutcome(Self.failure("Adopt failed", error: error)); return }
        onOutcome(ToastRequest(message: "Now tracking this worktree's branch"))
        await loadDetail()
    }

    /// Resolve a merge conflict in-session: revive the session so its own agent rebases the branch
    /// onto the target that conflicted and fixes the conflicts (it has the context for its own
    /// changes). The resume clears the stale mergeStatus server-side, so the bar offers Merge again
    /// once it's done. Same prompt web sends from `resolveMut`.
    func resolveInSession(branch: String, target: String) async {
        busy = true
        defer { busy = false }
        let content = "Rebase this branch onto the latest \(target) and resolve any conflicts.\n\n"
            + "You're in this session's isolated git worktree, checked out on \(branch). "
            + "Run git rebase \(target) — it may stop on conflicts. For each, resolve every conflict "
            + "using your knowledge of the changes made on this branch, git add the resolved "
            + "files, then git rebase --continue, repeating until the rebase completes. Do not "
            + "push. Once the rebase finishes, the branch can be merged into \(target) cleanly from "
            + "the status bar above the composer."
        do {
            _ = try await api.resume(sessionID: sessionID,
                                     ResumeRequest(clientTurnId: UUID().uuidString, content: content,
                                                   kind: "message"))
            onOutcome(ToastRequest(message: "Resuming the session to resolve the conflict…",
                                   tone: .info))
        } catch {
            onOutcome(Self.failure("Couldn't resume the session", error: error))
            return
        }
        await loadDetail()
    }

    /// Turn a finished merge/commit into the same card web shows for it — same headline, same tone,
    /// same diagnostic line (`AgentView`'s merge/commit notices). "status bar" in web's copy is this
    /// worktree bar; on iOS that phrase would read as the system clock strip, so it's named here.
    private func surfaceCompletedAction(from old: SessionDetail?, to new: SessionDetail) {
        guard let old else { return }
        if (old.mergeStatus == "conflict" || old.mergeStatus == "error"), new.mergeStatus == "pending" {
            onOutcome(ToastRequest(message: "Merging…", tone: .info))
            return
        }
        if old.commitStatus == "error", new.commitStatus == "pending" {
            onOutcome(ToastRequest(message: "Committing…", tone: .info))
            return
        }
        let target = new.mergeTarget ?? "main"
        if old.mergeStatus == "pending", new.mergeStatus == "merged" {
            onOutcome(ToastRequest(message: "Merged into \(target)"))
        } else if old.mergeStatus == "pending", new.mergeStatus == "conflict" {
            onOutcome(ToastRequest(
                message: "Merge conflict in \(target)",
                detail: "Merge aborted; your branch is unchanged. Resolve it from the worktree bar.",
                tone: .warning))
        } else if old.mergeStatus == "pending", new.mergeStatus == "error" {
            onOutcome(ToastRequest(message: "Merge into \(target) failed",
                                   detail: Self.trimmed(new.mergeError), tone: .error))
        } else if old.commitStatus == "pending", new.commitStatus == "error" {
            onOutcome(ToastRequest(message: "Commit failed",
                                   detail: Self.trimmed(new.commitError), tone: .error))
        } else if old.commitStatus == "pending", new.commitStatus == "committed" {
            onOutcome(ToastRequest(message: "Changes committed"))
        } else if old.commitStatus == "pending", new.commitStatus == "nochange" {
            onOutcome(ToastRequest(message: "No changes to commit", tone: .neutral))
        }
    }

    /// A failed action as a card: the attempt as the headline, the server's own words underneath.
    private static func failure(_ headline: String, error: Error) -> ToastRequest {
        ToastRequest(message: headline, detail: failureDetail(error), tone: .error)
    }

    private static func failureDetail(_ error: Error) -> String? {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        if case APIError.http(_, let body) = error { return apiMessage(from: body) }
        return "Check your connection."
    }

    private static func trimmed(_ value: String?) -> String? {
        let cleaned = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return cleaned.isEmpty ? nil : cleaned
    }

    private static func apiMessage(from body: String?) -> String? {
        let trimmed = body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let json = object as? [String: Any] else {
            return trimmed
        }
        if let message = json["message"] as? String, !message.isEmpty { return message }
        if let messages = json["message"] as? [String], !messages.isEmpty {
            return messages.joined(separator: "\n")
        }
        if let error = json["error"] as? String, !error.isEmpty { return error }
        return trimmed
    }
}
