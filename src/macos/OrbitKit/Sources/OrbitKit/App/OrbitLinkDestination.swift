import Foundation

// Where tapping an Orbit link card goes.
//
// Its own type and not `Route`: `Route` lives in the app shells, `OrbitApp` switches over it
// exhaustively, and it compiles only in CI — so a case added for this would leave every open branch
// of that app unbuildable until it was merged there too. The shells map this to their own route
// where they already map everything else.
//
// Every kind has a page in the app itself. A project's is its own page — the one the web opens too.
// It used to lead to the conversation that coordinates it, from before this client had a project
// page; inside that conversation the tap then went nowhere. For anything the server would not
// describe, the link opens the deployment in a browser instead, the honest answer for an object this
// client cannot show.
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
    /// A project's page, pushed where the link was — over a phone's conversation, or in the Projects
    /// section.
    case project(id: String)
    /// A wiki entry's page, pushed where the link was — the Wiki section's own, or over a phone's
    /// conversation.
    case wikiEntry(id: String)
    /// Nowhere in this app can show it: opened outside, at the link the card replaced.
    case web(URL)

    /// Where a link goes with nothing read: every kind is a page in this app whatever the object turns
    /// out to be, and the page is the one that says so when the object is gone.
    ///
    /// This is the answer for a link somebody wrote or pasted (`orbit-task:<id>`, or a page URL of
    /// this deployment), as opposed to ``tap(for:preview:baseURL:)``, which answers for a card that
    /// has already been read.
    public static func inApp(for target: OrbitLinkTarget) -> OrbitLinkDestination {
        switch target.kind {
        case .task:    return .task(id: PublicID.toPublic(target.id))
        case .session: return .session(id: PublicID.toPublic(target.id))
        case .list:    return .list(id: PublicID.toPublic(target.id))
        case .wiki:    return .wikiEntry(id: PublicID.toPublic(target.id))
        case .project: return .project(id: PublicID.toPublic(target.id))
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
            case .project: return .project(id: PublicID.toPublic(target.id))
            }
        }
        guard let url = OrbitLinkParser.pageURL(for: target, baseURL: baseURL) else { return .web(baseURL) }
        return .web(url)
    }
}
