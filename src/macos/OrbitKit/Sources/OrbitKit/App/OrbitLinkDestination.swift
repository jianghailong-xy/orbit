import Foundation

// Where tapping an Orbit link card goes.
//
// Its own type and not `Route`: `Route` lives in the app shells, `OrbitApp` switches over it
// exhaustively, and it compiles only in CI — so a case added for this would leave every open branch
// of that app unbuildable until it was merged there too. The shells map this to their own route
// where they already map everything else.
//
// Four kinds have a page in the app itself. A project does not: what a card leads to is the
// conversation that coordinates it, and the id for that comes from the read the card was drawn from
// — without one, and for anything the server would not describe, the link opens the deployment in a
// browser instead, which is the honest answer for an object this client cannot show.
//
// A wiki entry is the one kind whose unread card stays in the app. Its page here reads by the id
// alone, while the deployment's page takes the entry's space too (`/wiki/<space>/e/<id>`), which only
// the read names — so for an entry the server would not describe there is no browser page to leave
// for, and the entry's own page is the one that can say so ("That entry is no longer in this space.").

/// The five kinds of object a link can name, plus the one destination that leaves the app.
public enum OrbitLinkDestination: Equatable, Sendable {
    case task(id: String)
    case session(id: String)
    case list(id: String)
    /// A wiki entry's page, pushed where the link was — the Wiki section's own, or over a phone's
    /// conversation.
    case wikiEntry(id: String)
    /// Nowhere in this app can show it: opened outside, at the link the card replaced.
    case web(URL)

    /// Where a link goes with nothing read: the four kinds that are a page in this app whatever the
    /// object turns out to be. Nil for a project — the conversation that coordinates it is an id only
    /// a read can give — and for an id that names nothing.
    ///
    /// This is the answer for a link somebody wrote or pasted (`orbit-task:<id>`, or a page URL of
    /// this deployment), as opposed to ``tap(for:preview:baseURL:)``, which answers for a card that
    /// has already been read.
    public static func inApp(for target: OrbitLinkTarget) -> OrbitLinkDestination? {
        switch target.kind {
        case .task:    return .task(id: PublicID.toPublic(target.id))
        case .session: return .session(id: PublicID.toPublic(target.id))
        case .list:    return .list(id: PublicID.toPublic(target.id))
        case .wiki:    return .wikiEntry(id: PublicID.toPublic(target.id))
        case .project: return nil
        }
    }

    /// Where a tap on a card goes.
    ///
    /// `preview` is nil while a card is still loading, and the loading card's answer is the same as
    /// the unavailable one's — a tap that arrives before the read finishes leaves the app rather
    /// than opening a page that has nothing to show yet.
    public static func tap(for ref: OrbitLinkRef, preview: LinkPreview?, baseURL: URL) -> OrbitLinkDestination {
        let target = ref.target
        // Read or not: see the note at the top of this file.
        if target.kind == .wiki { return .wikiEntry(id: PublicID.toPublic(target.id)) }
        if let preview, preview.state == .ok {
            switch target.kind {
            case .task:    return .task(id: PublicID.toPublic(target.id))
            case .session: return .session(id: PublicID.toPublic(target.id))
            case .list:    return .list(id: PublicID.toPublic(target.id))
            case .wiki:    return .wikiEntry(id: PublicID.toPublic(target.id))
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
