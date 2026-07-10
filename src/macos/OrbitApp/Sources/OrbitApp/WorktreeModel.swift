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
    @ObservationIgnored var onStatus: (String) -> Void = { _ in }
    /// Surface a transient, informational status line that auto-dismisses (the resume confirmation).
    /// Web shows these as a self-dismissing toast; the sticky `onStatus` banner is for errors only.
    @ObservationIgnored var onInfo: (String) -> Void = { _ in }

    /// GET /sessions/:id detail driving the status bar (branch, changedFiles +/− stats, merge /
    /// commit status, targets). Polled while the console is on screen — see `startPolling`.
    private(set) var detail: SessionDetail?
    /// Per-file unified diffs for the expandable diff sheet, fetched lazily when it opens.
    private(set) var diff: [FilePatch] = []
    private(set) var busy = false

    init(sessionID: String, api: APIClient) {
        self.sessionID = sessionID
        self.api = api
    }

    /// Fetch the session detail behind the status bar (branch / changedFiles / merge+commit status).
    /// Best-effort: a failure keeps the last snapshot so a transient blip doesn't blank the bar.
    func loadDetail() async {
        guard !sessionID.isEmpty else { return }
        do { detail = try await api.sessionDetail(sessionID) }
        catch { /* keep last */ }
    }

    /// Keep the status bar current while the console is on screen, mirroring web's refetch policy:
    /// poll every 3s while a merge/commit is pending (the runner's outcome is ≤1 heartbeat away),
    /// every 5s while the session is live (so a mid-turn diff appears without waiting for turn-end),
    /// and otherwise stay idle — re-checking cheaply so a user-triggered commit/merge (which flips
    /// the status to pending) is picked up. Cancelled when the view goes away.
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
        busy = true
        defer { busy = false }
        do { diff = try await api.diff(sessionID: sessionID).patches }
        catch { /* keep last */ }
    }

    func commit() async {
        busy = true
        defer { busy = false }
        do { try await api.commit(sessionID: sessionID) }
        catch { onStatus("Commit failed"); return }
        // Reflect the pending commit immediately; the poll loop then follows the runner's outcome.
        await loadDetail()
    }

    func merge(target: String?) async {
        busy = true
        defer { busy = false }
        do { try await api.merge(sessionID: sessionID, targetBranch: target) }
        catch { onStatus("Merge failed"); return }
        await loadDetail()
    }

    /// Resolve a merge conflict in-session: revive the session so its own agent rebases the branch
    /// onto the latest main and fixes the conflicts (it has the context for its own changes). The
    /// resume clears the stale mergeStatus server-side, so the bar offers Merge again once it's done.
    /// Same prompt web sends from `resolveMut`.
    func resolveInSession(branch: String) async {
        busy = true
        defer { busy = false }
        let content = "Rebase this branch onto the latest `main` and resolve any conflicts.\n\n"
            + "You're in this session's isolated git worktree, checked out on `\(branch)`. "
            + "Run `git rebase main` — it may stop on conflicts. For each, resolve every conflict "
            + "using your knowledge of the changes made on this branch, `git add` the resolved "
            + "files, then `git rebase --continue`, repeating until the rebase completes. Do not "
            + "push. Once the rebase finishes, the branch can be merged into main cleanly from the "
            + "status bar above the composer."
        do {
            _ = try await api.resume(sessionID: sessionID,
                                     ResumeRequest(clientTurnId: UUID().uuidString, content: content,
                                                   kind: "message"))
            onInfo("Resuming the session to resolve the conflict…")
        } catch { onStatus("Couldn't resume the session"); return }
        await loadDetail()
    }
}
