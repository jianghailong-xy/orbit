import Foundation
import Observation
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UserNotifications
#endif
import OrbitKit

/// The Share Extension's state: what was shared, where it goes, and the hand-off to the app
/// (docs/share-to-orbit-design.md §3.1). Nothing here holds a credential or touches the network:
/// the picker reads the app's snapshot and Add writes one inbox entry, then hands off: on iOS it
/// opens the app with the link if `openApp` can, else posts a local notification; on macOS it
/// opens the app with the link (§3.3). The macOS Share-menu extension hosts this same model and view.
@MainActor
@Observable
final class ShareModel {
    enum Destination: Equatable {
        case newSession(RecentSessionsSnapshot.Workspace)
        case session(RecentSessionsSnapshot.Row)

        var target: ShareTarget {
            switch self {
            case .newSession(let w): return .newSession(workspaceId: w.id)
            case .session(let row): return .session(id: row.id)
            }
        }

        var title: String {
            switch self {
            case .newSession(let w): return ShareCopy.newSession(in: w.name)
            case .session(let row): return row.title
            }
        }
    }

    enum Phase: Equatable {
        case loading
        case picking
        case adding
        /// Added. `notified` says whether the hand-off reached the person: the "tap to finish"
        /// notification was posted (iOS), or the app was opened on the entry (macOS).
        case done(title: String, notified: Bool)
        /// Added, and Orbit was opened on the entry (iOS): the sheet closes at once.
        case opened
        case failed(String)
    }

    /// One loaded item and, for a file, the private copy the extension made of it.
    struct Loaded {
        var item: SharePickerItem
        var file: URL?
    }

    private(set) var loaded: [Loaded] = []
    var items: [SharePickerItem] { loaded.map(\.item) }
    /// Nil: no snapshot, so signed out.
    let snapshot: RecentSessionsSnapshot?
    var query = ""
    var note = ""
    var destination: Destination?
    var workspace: RecentSessionsSnapshot.Workspace?
    private(set) var phase: Phase = .loading
    /// iOS: opens the containing app on a link; false when it could not. Set by the host controller.
    var openApp: ((URL) async -> Bool)?

    private let container: URL?
    private let scratch: URL

    init(container: URL? = ShareAppGroup.container()) {
        self.container = container
        let snapshot = container.flatMap { RecentSessionsSnapshotStore(root: $0).load() }
        let workspace = snapshot?.defaultWorkspace
        self.snapshot = snapshot
        self.workspace = workspace
        destination = SharePicker.rows(snapshot ?? .init(sessions: []), query: "").first.map(Destination.session)
            ?? workspace.map(Destination.newSession)
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("OrbitShare-\(UUID().uuidString)", isDirectory: true)
    }

    var rows: [RecentSessionsSnapshot.Row] {
        snapshot.map { SharePicker.rows($0, query: query) } ?? []
    }

    var going: [Loaded] { loaded.filter(\.item.goes) }

    var canAdd: Bool {
        phase == .picking && snapshot != nil && destination != nil && !going.isEmpty
    }

    func choose(_ destination: Destination) { self.destination = destination }

    func chooseWorkspace(_ w: RecentSessionsSnapshot.Workspace) {
        workspace = w
        destination = .newSession(w)
    }

    // MARK: loading what was shared

    func load(_ providers: [NSItemProvider]) async {
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        var out: [Loaded] = []
        for (index, provider) in providers.prefix(SharePicker.maxItems).enumerated() {
            out.append(await Self.load(provider, index: index, into: scratch))
        }
        loaded = out
        phase = .picking
    }

    private static func load(_ provider: NSItemProvider, index: Int, into dir: URL) async -> Loaded {
        let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
        let fallbackName = provider.suggestedName ?? "item"
        // A web link: into the composer text (§3.4, D3).
        if !types.contains(where: { $0.conforms(to: .fileURL) }),
           types.contains(where: { $0.conforms(to: .url) }),
           let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
           !url.isFileURL {
            return Loaded(item: .init(id: index, name: url.absoluteString,
                                      kind: .text(url.absoluteString, isURL: true)), file: nil)
        }
        // Text handed over as a string (Notes, a selection); a text *file* comes back as a URL below.
        if let text = types.first(where: { $0.conforms(to: .plainText) }),
           !types.contains(where: { $0.conforms(to: .fileURL) }),
           let value = try? await provider.loadItem(forTypeIdentifier: text.identifier) as? String {
            switch SharedText.route(value) {
            case .composerText(let s):
                return Loaded(item: .init(id: index, name: s, kind: .text(s, isURL: false)), file: nil)
            case .attachment(let name, let data):
                let file = dir.appendingPathComponent("\(index)-\(name)")
                guard (try? data.write(to: file)) != nil else { break }
                return Loaded(item: .init(id: index, name: name,
                                          kind: .file(mime: "text/plain", bytes: Int64(data.count))), file: file)
            }
        }
        // Anything with bytes: a file, an image, a movie. Copied by URL, never read into memory.
        guard let type = types.first(where: { $0.conforms(to: .data) || $0.conforms(to: .fileURL) })
                ?? types.first(where: { $0.conforms(to: .item) }) else {
            return Loaded(item: .init(id: index, name: fallbackName, kind: .unsupported), file: nil)
        }
        let picked = type.conforms(to: .fileURL) ? (types.first { $0.conforms(to: .data) } ?? type) : type
        return await withCheckedContinuation { cont in
            _ = provider.loadFileRepresentation(forTypeIdentifier: picked.identifier) { url, _ in
                guard let url else {
                    cont.resume(returning: Loaded(item: .init(id: index, name: fallbackName, kind: .unsupported),
                                                  file: nil))
                    return
                }
                var name = provider.suggestedName ?? url.deletingPathExtension().lastPathComponent
                let ext = url.pathExtension.isEmpty ? (picked.preferredFilenameExtension ?? "") : url.pathExtension
                if !ext.isEmpty, (name as NSString).pathExtension.lowercased() != ext.lowercased() {
                    name += "." + ext
                }
                let mime = UTType(filenameExtension: ext)?.preferredMIMEType
                    ?? picked.preferredMIMEType ?? "application/octet-stream"
                let bytes = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?
                    .int64Value ?? 0
                let item = SharePickerItem(id: index, name: name, kind: .file(mime: mime, bytes: bytes))
                // The system deletes `url` when this returns: keep a copy of what will go, and only that.
                guard item.goes else { return cont.resume(returning: Loaded(item: item, file: nil)) }
                let copy = dir.appendingPathComponent("\(index)-\(UUID().uuidString)")
                    .appendingPathExtension(ext)
                let ok = (try? FileManager.default.copyItem(at: url, to: copy)) != nil
                cont.resume(returning: Loaded(item: ok ? item : .init(id: index, name: name, kind: .unsupported),
                                              file: ok ? copy : nil))
            }
        }
    }

    // MARK: Add

    /// Writes the inbox entry, then opens Orbit on it; on iOS, where that is not a supported API and
    /// may fail, it posts "N files ready … tap to finish" instead. Nothing is uploaded or sent: the
    /// app stages the items in the composer and the person sends from there.
    func add() async {
        guard canAdd, let destination, let container else { return }
        phase = .adding
        var sources: [ShareInbox.Source] = []
        var texts: [String] = []
        for l in going {
            switch l.item.kind {
            case .text(let s, _): texts.append(s)
            case .file(let mime, _):
                if let file = l.file { sources.append(.init(url: file, name: l.item.name, mime: mime)) }
            case .unsupported: break
            }
        }
        let text = SharePicker.composerText(sharedTexts: texts, note: note)
        let entry: ShareEntry
        do {
            entry = try ShareInbox(root: container).write(target: destination.target, items: sources, note: text)
        } catch {
            phase = .failed(ShareCopy.addFailed)
            return
        }
        cleanUp()
        #if os(macOS)
        let notified = NSWorkspace.shared.open(ShareHandoffLink.url(target: entry.target, entryID: entry.id))
        #else
        if let openApp, await openApp(ShareHandoffLink.url(target: entry.target, entryID: entry.id)) {
            phase = .opened
            return
        }
        let notified = await Self.notify(entry: entry, title: destination.title)
        #endif
        phase = .done(title: destination.title, notified: notified)
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: scratch)
    }

    #if !os(macOS)
    private static func notify(entry: ShareEntry, title: String) async -> Bool {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional || status == .ephemeral else { return false }
        let content = UNMutableNotificationContent()
        content.title = "Orbit"
        content.body = ShareCopy.notificationBody(files: entry.items.count, title: title)
        content.sound = .default
        content.userInfo = [ShareHandoffLink.userInfoKey:
                                ShareHandoffLink.url(target: entry.target, entryID: entry.id).absoluteString]
        let request = UNNotificationRequest(identifier: "share-\(entry.id)", content: content, trigger: nil)
        return (try? await center.add(request)) != nil
    }
    #endif
}
