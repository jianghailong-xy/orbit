import Foundation
import Observation
import OrbitKit

/// The account's wiki, behind the Wiki section, the drawer's Wiki row and every entry page. Owned by
/// `AppModel` and rebuilt per instance, like the other section stores.
///
/// Refetched rather than patched: `wiki.changed` names a space and nothing else (contract
/// `realtime.redaction`), so a nudge re-reads what is loaded — the spaces list (the drawer's amber
/// number), the home page on screen, Review, and the entry pages kept — and so does every write this
/// client makes. Nothing depends on the event arriving: the pages also re-read when they appear.
@MainActor
@Observable
final class WikiModel {
    /// Every space, by slug, each with the proposals waiting in it.
    private(set) var spaces: [WikiSpace] = []
    private(set) var spacesState = ListLoadState()
    /// The home page of the space on screen, once all four of its reads are in.
    private(set) var home: WikiHomeContent?
    private(set) var homeState = ListLoadState()
    /// Every changeset with an op still waiting, across the spaces — the queue Review pages through.
    private(set) var review: [WikiChangeset] = []
    private(set) var reviewState = ListLoadState()
    /// The entry pages read so far, and the ones the server would not show.
    private(set) var details: [String: WikiEntryDetail] = [:]
    private(set) var missing: Set<String> = []
    /// A write in flight, so its controls do not take a second press.
    private(set) var busy = false

    private let api: APIClient
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?

    /// The space the home page shows, by slug — the last one picked, kept across launches.
    var selectedSlug: String? {
        didSet {
            guard selectedSlug != oldValue else { return }
            UserDefaults.standard.set(selectedSlug, forKey: Self.spaceKey)
        }
    }
    private static let spaceKey = "orbit.wiki.space"

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        selectedSlug = UserDefaults.standard.string(forKey: Self.spaceKey)
    }

    /// The drawer's amber number: every space's proposals, summed as the web sidebar sums them.
    var proposalsToReview: Int { WikiLogic.proposalsToReview(spaces) }

    /// The space the home page is about: the one picked, else the first by slug.
    var currentSpace: WikiSpace? {
        spaces.first { $0.slug == selectedSlug } ?? spaces.first
    }

    /// The pending ops Review pages through.
    var reviewCards: [WikiLogic.ReviewCard] { WikiLogic.reviewCards(review) }

    /// An entry page by either spelling of its id.
    func detail(_ id: String) -> WikiEntryDetail? {
        details[PublicID.storageKey(id)]
    }

    func isMissing(_ id: String) -> Bool { missing.contains(PublicID.storageKey(id)) }

    // MARK: reads

    func loadSpaces() async {
        spacesState.begin()
        do {
            let list = try await api.wikiSpaces()
            if list != spaces { spaces = list }
            spacesState.succeed()
        } catch {
            spacesState.fail()
        }
    }

    /// The spaces, then the four reads the home page is drawn from, side by side.
    func loadHome() async {
        homeState.begin()
        await loadSpaces()
        guard let space = currentSpace else {
            home = nil
            if spacesState.lastLoadFailed { homeState.fail() } else { homeState.succeed() }
            return
        }
        async let documentRead = api.wikiSpace(space.id)
        async let entriesRead = api.wikiEntries(spaceID: space.id)
        async let timelineRead = api.wikiTimeline(spaceID: space.id)
        do {
            let document = try await documentRead
            let entries = try await entriesRead
            // The timeline is one band of six; the page still draws without it.
            let timeline = try? await timelineRead
            let content = WikiHomeContent(space: document, spaces: spaces, entries: entries,
                                          timeline: timeline?.items ?? [], proposals: proposalsToReview)
            if content != home { home = content }
            homeState.succeed()
        } catch {
            homeState.fail()
        }
    }

    /// Every space's queue, which is what the drawer's number and the banner count.
    func loadReview() async {
        reviewState.begin()
        do {
            let queue = try await api.wikiReview()
            if queue != review { review = queue }
            reviewState.succeed()
        } catch {
            reviewState.fail()
        }
    }

    /// One entry's page. A 404 is an entry the server will not show — deleted, or not this account's.
    func loadEntry(_ id: String) async {
        let key = PublicID.storageKey(id)
        do {
            let detail = try await api.wikiEntry(id)
            missing.remove(key)
            if details[key] != detail { details[key] = detail }
        } catch APIError.http(let status, _) where status == 404 {
            missing.insert(key)
        } catch {
            // Keep what is on screen; the next appearance or nudge reads again.
        }
    }

    /// The entries a query finds in the space on screen.
    func search(_ query: String) async -> [WikiSearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        return (try? await api.wikiSearch(trimmed, spaceID: currentSpace?.id))?.hits ?? []
    }

    /// `wiki.changed` arrived, or a write landed: re-read what is loaded, once for a burst.
    func nudge() {
        guard nudgeTask == nil else { return }
        nudgeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self else { return }
            self.nudgeTask = nil
            await self.reloadLoaded()
        }
    }

    /// Everything a page has read, read again — what the control plane's reconnect asks for too.
    func reloadLoaded() async {
        if home != nil || homeState.hasLoaded {
            await loadHome()
        } else {
            await loadSpaces()
        }
        if reviewState.hasLoaded { await loadReview() }
        for key in Array(details.keys) { await loadEntry(key) }
    }

    // MARK: Review

    /// The owner's answer to one pending op. Nil on success, else the sentence to show.
    func decide(_ card: WikiLogic.ReviewCard, _ action: WikiDecideAction,
                reason: WikiRejectReason? = nil, edited: WikiEntryChanges? = nil) async -> String? {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.decideWikiChangeset(
                card.changeset.id,
                WikiDecideRequest(decisions: [WikiDecision(opId: card.op.id, action: action,
                                                           edited: edited, reason: reason)]))
            await reloadAfterWrite()
            return nil
        } catch {
            await reloadAfterWrite()
            return WikiCopy.refused
        }
    }

    /// The entry an op names, for the cards that are about an existing entry (an amend, a retire).
    func loadEntriesNamed(by cards: [WikiLogic.ReviewCard]) async {
        for card in cards {
            guard let id = card.op.entryId, detail(id) == nil, !isMissing(id) else { continue }
            await loadEntry(id)
        }
    }

    // MARK: the owner's own writes, from an entry's page

    /// Edit: the title and the one-line summary, as an amend that applies at once.
    func edit(_ entry: WikiEntry, title: String, summary: String) async -> String? {
        await write(entry, .amend(entryId: entry.id, baseRevision: entry.currentRevision ?? 1,
                                  changes: WikiEntryChanges(title: title, summary: summary)),
                    rationale: WikiCopy.editedRationale(entry.displayTitle), key: "wiki-edit")
    }

    /// Supersede: a replacement with the entry's kind, fields, topics, aliases and anchors, under a
    /// new title and summary; the entry points at it from then on.
    func supersede(_ entry: WikiEntry, title: String, summary: String) async -> String? {
        var draft: [String: JSONValue] = [
            "kind": .string((entry.kind ?? .unknown).rawValue),
            "title": .string(title),
            "summary": .string(summary),
            "fields": entry.fields ?? .object([:]),
            "topics": .array((entry.topics ?? []).map(JSONValue.string)),
            "aliases": .array((entry.aliases ?? []).map(JSONValue.string)),
        ]
        // An anchor's last check is the server's, never a proposer's: it goes back without it.
        draft["anchors"] = .array((entry.anchors ?? []).map(Self.anchorInput))
        return await write(entry, .supersede(entryId: entry.id, baseRevision: entry.currentRevision ?? 1,
                                             entry: .object(draft)),
                           rationale: WikiCopy.replacedRationale(entry.displayTitle), key: "wiki-supersede")
    }

    /// Retire: agents stop getting it; it stays in History.
    func retire(_ entry: WikiEntry, reason: String) async -> String? {
        await write(entry, .retire(entryId: entry.id, baseRevision: entry.currentRevision ?? 1, reason: reason),
                    rationale: WikiCopy.retiredRationale(entry.displayTitle), key: "wiki-retire")
    }

    /// One owner write, with the rationale it is recorded under and an idempotency key of its own, so
    /// a resend of the same press is one write. Nil on success, else the sentence to show.
    private func write(_ entry: WikiEntry, _ op: WikiOwnerOp, rationale: String, key: String) async -> String? {
        guard let spaceID = entry.spaceId ?? currentSpace?.id else { return WikiCopy.refused }
        busy = true
        defer { busy = false }
        do {
            let result = try await api.submitWikiChangeset(
                spaceID: spaceID,
                WikiChangesetRequest(ops: [op], rationale: rationale,
                                     idempotencyKey: "\(key):\(UUID().uuidString.lowercased())"))
            await reloadAfterWrite()
            await loadEntry(entry.id)
            let refusal = result.ops?.compactMap { $0.reasons?.first?.message }.first
            return refusal
        } catch {
            await loadEntry(entry.id)
            return WikiCopy.refused
        }
    }

    private func reloadAfterWrite() async {
        await loadSpaces()
        if reviewState.hasLoaded { await loadReview() }
        if homeState.hasLoaded { await loadHome() }
    }

    /// An anchor as a proposer writes it: every key but `check`.
    private static func anchorInput(_ anchor: WikiAnchor) -> JSONValue {
        var object: [String: JSONValue] = [:]
        if let type = anchor.type { object["type"] = .string(type.rawValue) }
        let texts: [(String, String?)] = [("path", anchor.path), ("symbol", anchor.symbol),
                                          ("regionSha256", anchor.regionSha256), ("sha", anchor.sha),
                                          ("criterionId", anchor.criterionId),
                                          ("semanticHash", anchor.semanticHash),
                                          ("contentHash", anchor.contentHash), ("command", anchor.command),
                                          ("ref", anchor.ref)]
        for (key, value) in texts { if let value { object[key] = .string(value) } }
        if let exit = anchor.expectedExit { object["expectedExit"] = .int(exit) }
        return .object(object)
    }
}
