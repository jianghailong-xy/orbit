import Foundation

// Share to Orbit, the picker's rules (docs/share-to-orbit-design.md §3.1, board 1). The Share
// Extension draws them and the app reads the same link and toast words back, so they live here
// where they are unit-tested, not in either target.

/// Every word the share picker, its notification and the app's claim say.
public enum ShareCopy {
    public static let title = "Add to Orbit"
    public static let cancel = "Cancel"
    public static let add = "Add"
    public static let searchPlaceholder = "Search sessions"
    public static let newSession = "New session"
    public static let recent = "Recent"
    public static let notePlaceholder = "Add a note (optional)"
    public static let noMatches = "No sessions match"
    public static let signInFirst = "Sign in to Orbit first"
    public static let signInDetail = "Open Orbit and sign in, then share again."
    public static let unsupported = "Not supported"
    public static let nothingToAdd = "Nothing here can be added to Orbit."
    public static let addFailed = "Couldn't add these items. Try again."
    public static let openToSend = "Open Orbit to write your message and send."
    public static let openToFinish = "Open Orbit to finish"
    public static let done = "Done"

    /// The struck-out row's reason: over the cap the app's own attach path applies to that kind.
    public static func tooLarge(maxBytes: Int) -> String {
        "Too large (max \(maxBytes / (1024 * 1024)) MB)"
    }

    /// "1 file", "3 files".
    public static func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count) files" }

    /// The done state's heading.
    public static func added(to title: String) -> String { "Added to “\(title)”" }

    /// The local notification's body; a share of text alone says so instead of "0 files".
    public static func notificationBody(files count: Int, title: String) -> String {
        let lead = count == 0 ? "Your text is ready" : "\(files(count)) ready"
        return "\(lead) in “\(title)” — tap to finish"
    }

    /// What a new-session target is called where a session's title would be.
    public static func newSession(in workspace: String) -> String { "New session in \(workspace)" }

    /// The app's toast once the items are staged.
    public static func filesAdded(_ count: Int) -> String {
        count == 1 ? "1 shared file added" : "\(count) shared files added"
    }

    public static let textAdded = "Shared text added"

    /// The app's toast when the chosen session is gone: the items went to a new draft instead.
    public static let targetGone = "That session is gone, so the shared items are in a new session"
}

/// One thing that was shared, as the picker judges it before anything is copied.
public struct SharePickerItem: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        case file(mime: String, bytes: Int64)
        case text(String, isURL: Bool)
        case unsupported
    }

    public var id: Int
    public var name: String
    public var kind: Kind

    public init(id: Int, name: String, kind: Kind) {
        self.id = id
        self.name = name
        self.kind = kind
    }

    /// Why this item is left out (drawn struck out), or nil when it goes. A file is held to the cap
    /// the composer's `attachFile` will apply, so nothing the picker lets through is refused later.
    public var rejectReason: String? {
        switch kind {
        case .unsupported: return ShareCopy.unsupported
        case .text(let text, _): return text.isEmpty ? ShareCopy.unsupported : nil
        case .file(let mime, let bytes):
            if bytes <= 0 { return ShareCopy.unsupported }
            let cap = Attachments.cap(mimeType: mime)
            return bytes > Int64(cap) ? ShareCopy.tooLarge(maxBytes: cap) : nil
        }
    }

    public var goes: Bool { rejectReason == nil }

    /// The chip's size label, "25 KB".
    public var sizeLabel: String? {
        guard case .file(_, let bytes) = kind else { return nil }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// The chip's kind badge: "TXT", "PNG", "LINK".
    public var badge: String {
        switch kind {
        case .text(_, let isURL): return isURL ? "LINK" : "TEXT"
        case .unsupported: return "?"
        case .file:
            let ext = (name as NSString).pathExtension.uppercased()
            return ext.isEmpty ? "FILE" : String(ext.prefix(4))
        }
    }
}

/// The picker's lists over a snapshot.
public enum SharePicker {
    /// The extension's activation rule takes at most this many items.
    public static let maxItems = 10

    /// The rows under Recent: the snapshot's sessions, newest first, narrowed by a search that
    /// matches the title or the workspace name.
    public static func rows(_ snapshot: RecentSessionsSnapshot, query: String) -> [RecentSessionsSnapshot.Row] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let sorted = snapshot.sessions.sorted { $0.updatedAt > $1.updatedAt }
        guard !q.isEmpty else { return sorted }
        return sorted.filter {
            $0.title.localizedCaseInsensitiveContains(q) || $0.workspaceName.localizedCaseInsensitiveContains(q)
        }
    }

    /// The text the entry carries for the composer: the short shared texts and links, then the note.
    /// Long text is not here — it travels as a `shared-text.txt` item (§3.4).
    public static func composerText(sharedTexts: [String], note: String) -> String? {
        let parts = (sharedTexts + [note])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }
}

/// `orbit-session://<sessionId>?share=<entryId>` — the link the extension's notification carries.
/// A new-session target is `orbit-session://new?share=<entryId>`. The app routes by the entry it
/// claims, so the session in the link is for reading, not trusted.
public enum ShareHandoffLink {
    public static let scheme = "orbit-session"
    public static let parameter = "share"
    /// The notification's `userInfo` key that holds the link.
    public static let userInfoKey = "shareLink"

    public static func url(target: ShareTarget, entryID: String) -> URL {
        var c = URLComponents()
        c.scheme = scheme
        switch target {
        case .session(let id): c.host = id
        case .newSession: c.host = "new"
        }
        c.queryItems = [URLQueryItem(name: parameter, value: entryID)]
        return c.url!
    }

    /// The entry a link names, or nil for any other link.
    public static func entryID(in url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == parameter })?.value,
              !value.isEmpty else { return nil }
        return value
    }
}

/// The App Group both Apple targets share; the inbox and the snapshot live in its container.
public enum ShareAppGroup {
    public static let identifier = "group.io.orbitd.app"

    /// The container, or nil where the entitlement is missing (an unsigned build, the macOS app
    /// until its extension ships): every share path is then a no-op.
    public static func container() -> URL? {
        #if os(iOS) || os(macOS)
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
        #else
        return nil
        #endif
    }
}

extension RecentSessionsSnapshot {
    /// How many sessions the picker is given: enough to search, small enough to read at once.
    public static let maxSessions = 40

    /// The snapshot the app writes from its Open list: newest first, titled as the lists title
    /// them. `workspaces` is the app's default first.
    public static func from(sessions: [Session], workspaces: [Workspace]) -> RecentSessionsSnapshot {
        let rows: [Row] = sessions.compactMap { s in
            guard s.deletedAt == nil, let workspaceId = s.agent?.id ?? s.agentId else { return nil }
            let title = (s.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let name = s.agent?.name ?? workspaces.first(where: { $0.id == workspaceId })?.name ?? ""
            let updated = (s.updatedAt ?? s.createdAt).flatMap(RelativeTime.parse) ?? .distantPast
            return Row(id: s.id, title: title.isEmpty ? SessionMessageCard.untitled : title,
                       workspaceId: workspaceId, workspaceName: name, updatedAt: updated)
        }
        let newest = rows.sorted { $0.updatedAt > $1.updatedAt }.prefix(maxSessions)
        return RecentSessionsSnapshot(sessions: Array(newest), workspaces: workspaces)
    }
}
