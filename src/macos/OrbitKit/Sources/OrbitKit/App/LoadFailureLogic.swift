import Foundation

// Pure logic for telling "the request failed" apart from "the server said there is nothing".
// UI-free so it is unit-tested: the SwiftUI lists render `presentation`, and `AppModel` applies
// `defaultLanding` after each workspace fetch. Offline, the list models used to keep the empty value
// they started with and every surface read it as an answer — "No runners", a drawer with no
// workspaces, and a launch landing that sent a returning user to Runners onboarding.

/// How a list model's fetches have gone, reduced to what its surfaces need. The model advances it
/// around each fetch: `begin()` before, then `succeed()` or `fail()`.
public struct ListLoadState: Equatable, Sendable {
    /// A fetch is in flight.
    public private(set) var loading = false
    /// Some fetch has succeeded, so the list in hand is what the server said (possibly stale) rather
    /// than the empty value the model started with.
    public private(set) var hasLoaded = false
    /// The most recent fetch to finish failed. Cleared by the next success.
    public private(set) var lastLoadFailed = false

    public init() {}

    public mutating func begin() { loading = true }

    public mutating func succeed() {
        loading = false
        hasLoaded = true
        lastLoadFailed = false
    }

    public mutating func fail() {
        loading = false
        lastLoadFailed = true
    }
}

/// What a list surface draws where its rows would be.
public enum ListLoadPresentation: Equatable, Sendable {
    /// Nothing to show yet and an answer on its way — including the moment before the first fetch
    /// starts. A spinner, never "No runners".
    case loading
    /// The latest fetch failed and nothing is in hand: say the request failed and offer Retry.
    case failed
    /// A fetch succeeded and returned nothing. The only state that may say "No runners".
    case empty
    /// Rows to show. `showsError` means they are from an earlier fetch and the latest one failed, so
    /// a notice rides along with the rows instead of replacing them.
    case content(showsError: Bool)
}

/// What the one-shot launch landing does after a workspace fetch finishes.
public enum DefaultLanding: Equatable, Sendable {
    /// The list hasn't answered — still loading, or the latest fetch failed. Decide nothing and stay
    /// unlatched, so the next successful fetch (the control plane reloads it on reconnect) decides.
    case undecided
    /// Something already chose where to be: a deep link, a notification, a session, another section.
    case keepCurrent
    /// Open this workspace's session list.
    case agent(String)
    /// The server says there are no workspaces: Runners onboarding.
    case runners

    /// Whether this spends the one-shot landing. Only `undecided` leaves it open.
    public var latches: Bool { self != .undecided }
}

public enum LoadFailureLogic {
    public static func presentation(_ state: ListLoadState, isEmpty: Bool) -> ListLoadPresentation {
        if !isEmpty { return .content(showsError: state.lastLoadFailed) }
        // An earlier empty answer doesn't outlive a failed refresh: nobody can say it is still empty.
        if state.lastLoadFailed { return state.loading ? .loading : .failed }
        return state.hasLoaded ? .empty : .loading
    }

    /// Where a cold launch lands. `orderedAgentIDs` is the sidebar order and `lastAgentID` the
    /// workspace remembered from the previous run. The selection is only claimed while it is still
    /// the launch default: Workspaces, with no workspace or session picked.
    public static func defaultLanding(agents: ListLoadState,
                                      orderedAgentIDs: [String],
                                      lastAgentID: String?,
                                      section: AppSection,
                                      selectedAgentID: String?,
                                      selectedSessionID: String?) -> DefaultLanding {
        // A failed fetch leaves the empty starting list in hand; "no workspaces" read off that is
        // what sent returning users to Runners onboarding.
        guard agents.hasLoaded, !agents.lastLoadFailed else { return .undecided }
        guard section == .agents, selectedAgentID == nil, selectedSessionID == nil else { return .keepCurrent }
        // Compared through `PublicID.storageKey` because the two sides come from different eras:
        // `lastAgentID` was written by whichever build ran before this one, while the list spells ids
        // however the server does today (docs/public-id-migration-design.md). A raw `==` would
        // silently stop matching across that change and land on the first workspace instead.
        // Returns the MATCHED id, not the remembered string: everything downstream compares against
        // ids as the server spells them today.
        if let last = lastAgentID.map(PublicID.storageKey),
           let match = orderedAgentIDs.first(where: { PublicID.storageKey($0) == last }) {
            return .agent(match)
        }
        if let first = orderedAgentIDs.first { return .agent(first) }
        return .runners
    }
}
