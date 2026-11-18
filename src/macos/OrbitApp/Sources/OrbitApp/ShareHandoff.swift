import Foundation
import OrbitKit

/// Which share entry the app is to claim: one a notification named, or the newest one younger than
/// `ShareInbox.openWindow` (Orbit opened any other way soon after a share).
enum PendingShareClaim: Equatable {
    case entry(String)
    case newest
}

/// Share to Orbit, the app's half (docs/share-to-orbit-design.md §3.1, board 1 panel 4). The Share
/// Extension leaves an inbox entry in the App Group; the app claims it, opens the session it names
/// (or a new-session draft), stages each item through the composer's own `attachFile`, puts the
/// short text in the composer, and deletes the entry. Nothing is sent: the person sends.
///
/// Without the App Group entitlement (`ShareAppGroup.container()` nil — a `swift run` macOS app, an
/// unsigned build) every call here is a no-op. On macOS the extension opens the app with the
/// `orbit-session://<id>?share=<entry>` link itself (§3.3), so no notification is involved.
extension AppModel {
    private var shareContainer: URL? { ShareAppGroup.container() }

    // MARK: the picker's snapshot

    /// Writes the extension's snapshot of the Open list, if it changed. Called whenever the server
    /// answers the list.
    func writeShareSnapshot() {
        guard let root = shareContainer else { return }
        let ordered = orderedAgents
        let first = currentAgentID
        let workspaces = (ordered.filter { $0.id == first } + ordered.filter { $0.id != first })
            .map { RecentSessionsSnapshot.Workspace(id: $0.id, name: $0.name) }
        let snapshot = RecentSessionsSnapshot.from(sessions: sessions, workspaces: workspaces)
        guard snapshot != lastShareSnapshot else { return }
        lastShareSnapshot = snapshot
        try? RecentSessionsSnapshotStore(root: root).save(snapshot)
    }

    /// Sign-out: the extension then says "Sign in to Orbit first".
    func removeShareSnapshot() {
        lastShareSnapshot = nil
        pendingShareClaim = nil
        guard let root = shareContainer else { return }
        RecentSessionsSnapshotStore(root: root).remove()
    }

    func shareListLoaded() {
        writeShareSnapshot()
        drainShareClaim()
    }

    // MARK: claiming

    /// The app came to the front (a launch included): sweep entries older than a day on launch,
    /// and route to the newest one if it is younger than ten minutes.
    func noticeSharedItems(launching: Bool) {
        guard let root = shareContainer else { return }
        let inbox = ShareInbox(root: root)
        if launching { inbox.sweep() }
        guard inbox.entryForOpen() != nil else { return }
        if pendingShareClaim == nil { pendingShareClaim = .newest }
        drainShareClaim()
    }

    /// The notification's tap: that entry, whatever its age.
    func requestShareClaim(entryID: String) {
        pendingShareClaim = .entry(entryID)
        drainShareClaim()
    }

    /// Claims and stages the pending entry once signed in with a loaded list — the list is what says
    /// whether the chosen session is still there — and once a cold launch has landed, so the launch's
    /// own landing does not replace the session this opens.
    func drainShareClaim() {
        guard let pending = pendingShareClaim, signedIn, openListLoaded, !launchLandingPending,
              consoleRegistry != nil, let root = shareContainer else { return }
        pendingShareClaim = nil
        let inbox = ShareInbox(root: root)
        let id: String?
        switch pending {
        case .entry(let entryID): id = entryID
        case .newest: id = inbox.entryForOpen()?.id
        }
        guard let id, let claimed = inbox.claim(id: id) else { return }
        stage(claimed, inbox: inbox)
    }

    private func stage(_ claimed: ClaimedShareEntry, inbox: ShareInbox) {
        switch claimed.entry.target {
        case .session(let raw):
            let key = PublicID.storageKey(raw)
            if let listed = sessions.first(where: { PublicID.storageKey($0.id) == key })?.id {
                // The console the route opens is keyed by the public spelling `route` uses.
                let id = PublicID.toPublic(listed)
                route(to: .session(id))
                guard let console = consoleRegistry?.model(for: id, agentID: agentID(for: id)) else { return }
                fill(console, from: claimed, inbox: inbox, gone: false)
            } else {
                // Deleted or ended since the share: a draft in its workspace, and a toast saying why.
                let workspace = shareWorkspace(ofSession: raw) ?? currentAgentID
                guard let workspace else { return }
                openNewSession(inWorkspace: workspace) { [weak self] console in
                    self?.fill(console, from: claimed, inbox: inbox, gone: true)
                }
            }
        case .newSession(let workspace):
            openNewSession(inWorkspace: workspace) { [weak self] console in
                self?.fill(console, from: claimed, inbox: inbox, gone: false)
            }
        }
    }

    /// The workspace a session was in, as the snapshot the picker chose it from recorded it.
    private func shareWorkspace(ofSession id: String) -> String? {
        let row = lastShareSnapshot?.sessions.first { PublicID.storageKey($0.id) == PublicID.storageKey(id) }
        return row?.workspaceId
    }

    /// Stages each item as a composer chip, appends the text, says how many, then deletes the
    /// entry. `attachFile` reads each copy before it returns, so the entry can go once all are in.
    private func fill(_ console: ConsoleModel, from claimed: ClaimedShareEntry, inbox: ShareInbox, gone: Bool) {
        Task { @MainActor [weak self] in
            for (item, url) in zip(claimed.entry.items, claimed.itemURLs) {
                await console.attachFile(url: url, name: item.name)
            }
            if let note = claimed.entry.note, !note.isEmpty {
                console.composerText = SharedText.appending(note, to: console.composerText)
            }
            inbox.delete(claimed)
            let count = claimed.entry.items.count
            let message = gone ? ShareCopy.targetGone
                : (count == 0 ? ShareCopy.textAdded : ShareCopy.filesAdded(count))
            self?.showToast(message)
        }
    }
}
