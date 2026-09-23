import Foundation

// Where tapping an Orbit link card goes.
//
// Its own type and not `Route`: `Route` lives in the app shells, `OrbitApp` switches over it
// exhaustively, and it compiles only in CI — so a case added for this would leave every open branch
// of that app unbuildable until it was merged there too. The shells map this to their own route
// where they already map everything else.
//
// Three kinds have a page in the app itself. A project does not: what a card leads to is the
// conversation that coordinates it, and the id for that comes from the read the card was drawn from
// — without one, and for anything the server would not describe, the link opens the deployment in a
// browser instead, which is the honest answer for an object this client cannot show.

/// The four kinds of object a link can name, plus the one destination that leaves the app.
public enum OrbitLinkDestination: Equatable, Sendable {
    case task(id: String)
    case session(id: String)
    case list(id: String)
    /// Nowhere in this app can show it: opened outside, at the link the card replaced.
    case web(URL)

    /// Where a tap on a card goes.
    ///
    /// `preview` is nil while a card is still loading, and the loading card's answer is the same as
    /// the unavailable one's — a tap that arrives before the read finishes leaves the app rather
    /// than opening a page that has nothing to show yet.
    public static func tap(for ref: OrbitLinkRef, preview: LinkPreview?, baseURL: URL) -> OrbitLinkDestination {
        let target = ref.target
        if let preview, preview.state == .ok {
            switch target.kind {
            case .task:    return .task(id: PublicID.toPublic(target.id))
            case .session: return .session(id: PublicID.toPublic(target.id))
            case .list:    return .list(id: PublicID.toPublic(target.id))
            case .project:
                // The server nulls this when the coordinator is in Trash, so a project whose
                // coordinator cannot be shown is one with no session to open.
                if let coordinator = preview.project?.coordinatorSessionId, !coordinator.isEmpty {
                    return .session(id: coordinator)
                }
            }
        }
        guard let url = OrbitLinkParser.pageURL(for: target, baseURL: baseURL) else { return .web(baseURL) }
        return .web(url)
    }
}
