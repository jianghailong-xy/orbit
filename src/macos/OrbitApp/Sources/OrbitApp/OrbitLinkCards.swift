import SwiftUI
import OrbitKit

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// The live readings behind the Orbit link cards a conversation is showing, and the one door every
// Orbit link in the app is opened through.
//
// One store, one object per link, however many screens are showing it: `OrbitLinkPreviewStore` (the
// batching and the cache) is owned by `AppModel`, so two conversations showing the same task ask for
// it once and the header's copy of the card is the transcript's copy. This type is the part that
// belongs to the UI: it keeps the card each answer produced, and it is what a view asks.
//
// When a read happens is decided by the screens, never by a timer. A message notes the links it
// drew as it appears, and the console asks for anything stale as part of the refresh it is already
// doing — so a card is live while somebody is watching the conversation it is in, and idle otherwise.

/// The cards for the links a session is showing, keyed by object rather than by the spelling the
/// link was written in.
@MainActor
@Observable
final class OrbitLinkCards {
    /// How long a reading stays current. A conversation that stays open gets its cards re-read on the
    /// same refresh that already brings its rows: a card is a reading of a live object, and one
    /// claiming "Running" an hour later would be worse than no card at all.
    static let maxAge: TimeInterval = 60

    /// The deployment these links point at, as the parser wants it (`host` accepts a whole URL).
    let baseURL: URL
    var host: String { baseURL.absoluteString }

    private let store: OrbitLinkPreviewStore

    /// The card each answer produced. What the views draw, and the only mutable state they see.
    private(set) var readings: [String: Reading] = [:]

    /// One link's answer, and the card built from it — built once, at the moment it was read, so
    /// every draw of that card says the same thing (relative times included).
    struct Reading {
        let content: OrbitLinkCardContent
        let preview: LinkPreview
    }

    @ObservationIgnored private var refs: [String: OrbitLinkRef] = [:]
    /// The links waiting for the next read, and when each was last asked for. The timestamp is set
    /// when the request goes out, not when it lands, so a read that fails is retried on the next
    /// refresh rather than on every one.
    @ObservationIgnored private var pending: Set<String> = []
    @ObservationIgnored private var askedAt: [String: Date] = [:]
    @ObservationIgnored private var scheduled = false

    init(baseURL: URL, store: OrbitLinkPreviewStore) {
        self.baseURL = baseURL
        self.store = store
    }

    // MARK: what a view asks

    /// The card to draw for a link: what the server said, or the skeleton while nothing has.
    func content(for ref: OrbitLinkRef) -> OrbitLinkCardContent {
        readings[ref.target.key]?.content ?? .loading(ref, host: host)
    }

    /// Where a tap on a card goes — OrbitKit's rule, from whatever that card's read returned.
    func destination(for ref: OrbitLinkRef) -> OrbitLinkDestination {
        OrbitLinkDestination.tap(for: ref, preview: readings[ref.target.key]?.preview, baseURL: baseURL)
    }

    /// The deployment's own page for an object: what a long press copies, and what a project with no
    /// coordinator session opens.
    func pageURL(for ref: OrbitLinkRef) -> URL? {
        OrbitLinkParser.pageURL(for: ref.target, baseURL: baseURL)
    }

    // MARK: reading

    /// Note the links a screen is showing. Links already answered — and still current — cost nothing,
    /// and everything new goes out in one request on the next turn of the runloop: a transcript
    /// appears row by row, and six links in it are one round trip, not six.
    func note(_ refs: [OrbitLinkRef]) {
        for ref in refs { self.refs[ref.target.key] = ref }
        request(now: Date())
    }

    /// Ask again for whatever has gone stale. Called as the conversation refreshes — the same redraw
    /// that brings a new row — so a card follows the object it describes without a poll of its own.
    func refreshStale(now: Date = Date()) {
        request(now: now)
    }

    /// The server's own answer for one link, read now when it is not in hand. For the one question
    /// that has to be answered before anything is drawn: where a project's card leads.
    func preview(for ref: OrbitLinkRef) async -> LinkPreview? {
        let key = ref.target.key
        refs[key] = ref
        askedAt[key] = Date()
        guard let preview = (await store.previews(for: [ref]))[key] else { return nil }
        readings[key] = Reading(content: OrbitLinkCardContent.preview(ref, preview, host: host),
                                preview: preview)
        return preview
    }

    /// Forget everything, for a sign-out or a server change: a card read from one account is not one
    /// to draw against another.
    func removeAll() {
        readings.removeAll()
        refs.removeAll()
        pending.removeAll()
        askedAt.removeAll()
    }

    private func request(now: Date) {
        var added = false
        for (key, _) in refs where needsRead(key, now: now) {
            askedAt[key] = now
            pending.insert(key)
            added = true
        }
        guard added else { return }
        schedule()
    }

    private func needsRead(_ key: String, now: Date) -> Bool {
        guard let at = askedAt[key] else { return true }
        return now.timeIntervalSince(at) >= Self.maxAge
    }

    /// One read per turn of the runloop however many rows noted a link: the rows of one transcript
    /// appear together, and the store batches from there.
    private func schedule() {
        guard !scheduled, !pending.isEmpty else { return }
        scheduled = true
        Task { @MainActor in
            await Task.yield()
            scheduled = false
            await flush()
        }
    }

    private func flush() async {
        let keys = pending
        pending.removeAll()
        let batch = keys.compactMap { refs[$0] }
        guard !batch.isEmpty else { return }
        let now = Date()
        for (key, preview) in await store.previews(for: batch, now: now) {
            guard let ref = refs[key] else { continue }
            readings[key] = Reading(content: OrbitLinkCardContent.preview(ref, preview, host: host, now: now),
                                    preview: preview)
        }
    }
}

// MARK: - where an Orbit link goes

extension AppModel {
    /// The Orbit object a link names — a reference (`orbit-task:<id>`, what agents are told to write)
    /// or a page URL of this deployment (`https://…/tasks/<id>`) — or nil for a link this app has no
    /// business opening, which the caller hands to the system.
    func orbitRef(for url: URL) -> OrbitLinkRef? {
        let text = url.absoluteString
        if let target = OrbitLinkParser.target(forReference: text) {
            return OrbitLinkRef(target: target, source: .reference(text))
        }
        if let baseURL, let target = OrbitLinkParser.target(forPageURL: text, host: baseURL.absoluteString) {
            return OrbitLinkRef(target: target, source: .pageURL(text))
        }
        return nil
    }

    /// Open a link this app understands, and answer whether it did. The one door both shells'
    /// `OpenURLAction` and the iOS transcript's own link handler come through, so a reference in
    /// prose, a pasted page URL and a card's tap all land in the same place.
    ///
    /// `overConsole`: the link is in a phone's conversation, so what it opens is pushed over that
    /// console and the back swipe returns to it (`openFromConversation`). Everything outside a
    /// conversation — a URL, a notification, the wide shells — leaves it false and routes.
    @discardableResult
    func openOrbitLink(_ url: URL, overConsole: Bool = false) -> Bool {
        guard let ref = orbitRef(for: url) else { return false }
        openOrbitLink(ref, overConsole: overConsole)
        return true
    }

    /// Where a link goes. A task, a session and a task list are known from the link alone; a project
    /// leads to the conversation that coordinates it — an id only a read can give — and to the
    /// deployment's own page when there is no coordinator session, or no card store to read through,
    /// which is the same answer: this client cannot show that project.
    func openOrbitLink(_ ref: OrbitLinkRef, overConsole: Bool = false) {
        if let destination = OrbitLinkDestination.inApp(for: ref.target) {
            return open(destination, overConsole: overConsole)
        }
        guard let linkCards else { return openPage(for: ref) }
        Task { @MainActor in
            let preview = await linkCards.preview(for: ref)
            open(OrbitLinkDestination.tap(for: ref, preview: preview, baseURL: linkCards.baseURL),
                 overConsole: overConsole)
        }
    }

    /// Every destination an Orbit link can have, applied in one place. A task or a session opened
    /// from a phone's conversation is pushed over it (`openFromConversation`); a task list is a scope
    /// of the Tasks page rather than a page of its own, so it routes there wherever the link is.
    func open(_ destination: OrbitLinkDestination, overConsole: Bool = false) {
        switch destination {
        case .task(let id):    openFromConversation(.task(id), overConsole: overConsole)
        case .session(let id): openFromConversation(.session(id), overConsole: overConsole)
        case .list(let id):    route(to: .list(id))
        case .web(let url):    openExternal(url)
        }
    }

    /// Hand a URL to the system. Deliberately not the SwiftUI `openURL` environment action: this app
    /// installs its own action there, and a URL that reached it again would come straight back here.
    func openExternal(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #elseif os(iOS)
        UIApplication.shared.open(url)
        #endif
    }

    private func openPage(for ref: OrbitLinkRef) {
        guard let baseURL, let url = OrbitLinkParser.pageURL(for: ref.target, baseURL: baseURL) else {
            return
        }
        open(.web(url))
    }
}
