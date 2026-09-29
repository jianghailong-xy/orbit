import Foundation

/// An in-app navigation target. Notifications and menu-bar items carry one of these; the app
/// routes to it. Also the payload of an `orbit://` deep link.
public enum Route: Equatable, Sendable {
    case active
    case session(String)
    case task(String)
    /// A named task list, on the Tasks page: the scope switches to it (see `TaskScope.list`). Where a
    /// `[名字](orbit-list:<id>)` reference and a `/lists/<key>` page URL land.
    case list(String)
    case runner(String)
    /// A watch's detail on the Following page — where a watch's notification lands.
    case watch(String)
}

/// `orbit://` URL scheme. `orbit://session/<id>`, `orbit://task/<id>`, `orbit://runner/<id>`,
/// `orbit://watch/<id>`, `orbit://active`. Parsing/formatting is pure so it's unit-tested;
/// registering the scheme (Info.plist `CFBundleURLTypes`) + `onOpenURL` handling is the app's glue.
public enum DeepLink {
    public static let scheme = "orbit"

    public static func parse(_ url: URL) -> Route? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let host = url.host?.lowercased() ?? ""
        let id = url.pathComponents.first { $0 != "/" && !$0.isEmpty }
        switch host {
        case "session": return id.map(Route.session)
        case "task":    return id.map(Route.task)
        case "list":    return id.map(Route.list)
        case "runner":  return id.map(Route.runner)
        case "watch":   return id.map(Route.watch)
        case "active", "": return .active
        default:        return nil
        }
    }

    public static func url(for route: Route) -> URL {
        switch route {
        case .active:            return URL(string: "\(scheme)://active")!
        case .session(let id):   return URL(string: "\(scheme)://session/\(encode(id))")!
        case .task(let id):      return URL(string: "\(scheme)://task/\(encode(id))")!
        case .list(let id):      return URL(string: "\(scheme)://list/\(encode(id))")!
        case .runner(let id):    return URL(string: "\(scheme)://runner/\(encode(id))")!
        case .watch(let id):     return URL(string: "\(scheme)://watch/\(encode(id))")!
        }
    }

    private static func encode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}

/// A link to one record of a session's transcript — a turn, an event or a tool call — which opens the
/// session scrolled to that record and marks it for a moment (criterion 10 v2: a wiki footnote's
/// location link). Web parity: `lib/transcriptDeepLink.ts`, whose `?at=` this reads.
///
/// The record rides BESIDE the session's `Route`, never inside it: `Route` is switched over
/// exhaustively in the app shells, which compile only in CI, and a session route already means "put
/// this session on screen". The link says where in it. Two shapes carry one:
///
///   * `orbit://session/<id>?at=<record>` — the app's own scheme (`DeepLink.parse` reads the session
///     from it exactly as before, the query ignored);
///   * `https://<host>/sessions/<id>?at=<record>` — a page URL of the deployment this app is signed in
///     to, tapped in a transcript, which is the link the web page itself carries.
///
/// The link names the record, never a seq: a seq is the transcript's own ordering, while the record's
/// id is what a wiki source stores and what the server resolves
/// (`GET /sessions/:id/events/page?around=<record>`, `APIClient.eventPageAround`).
public enum SessionRecordLink {
    /// The query parameter both shapes name the record in — the web's `RECORD_PARAM`.
    public static let parameter = "at"

    /// The words the two clients say about a link to a record, the same sentences on both ends
    /// (`TranscriptDeepLinkTests` reads them out of `lib/transcriptDeepLink.ts`).
    public enum Copy {
        /// A link to a record that is not in the session it names — a turn that never reached the
        /// transcript, another session's record, one since deleted. The session opens as it would anyway.
        public static let notFound = "That message is not in this session"
        /// The jump-to-latest control, while the window opened at a record stops short of the tail.
        public static let jumpToLatest = "Jump to latest"
        /// The newer page such a window is pulling in as the reader scrolls down.
        public static let loadingNewer = "Loading newer messages…"
    }

    /// The session and the record a link names — both in their public spelling — or nil for any link
    /// that does not name both: another object, another server, no `at`, an `at` that is not an id.
    /// `host` is the server this app is signed in to (`AppModel.baseURL`); nil reads the app's own
    /// scheme alone.
    public static func parse(_ url: URL, host: String?) -> (session: String, record: String)? {
        guard let record = record(in: url) else { return nil }
        if case .session(let id)? = DeepLink.parse(url), PublicID.toUUID(id) != nil {
            return (PublicID.toPublic(id), record)
        }
        if let host, let target = OrbitLinkParser.target(forPageURL: url.absoluteString, host: host),
           target.kind == .session {
            return (PublicID.toPublic(target.id), record)
        }
        return nil
    }

    /// The record a URL's query names, in its public spelling, or nil when it names none or names
    /// something that is not an id — a malformed link opens the session at its latest message.
    public static func record(in url: URL) -> String? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let raw = items.first(where: { $0.name == parameter })?.value?
                  .trimmingCharacters(in: .whitespaces),
              !raw.isEmpty, PublicID.toUUID(raw) != nil else { return nil }
        return PublicID.toPublic(raw)
    }

    /// `orbit://session/<id>?at=<record>`, both ids in their public spelling.
    public static func url(session: String, record: String) -> URL {
        var components = URLComponents(url: DeepLink.url(for: .session(PublicID.toPublic(session))),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: parameter, value: PublicID.toPublic(record))]
        return components.url!
    }
}

/// A transcript link naming an Orbit object: `[title](orbit-task:<id>)`, and likewise
/// `orbit-session:`, `orbit-project:` and `orbit-list:`. The composer's `#`-references send them and
/// agents are told to write them instead of a bare id, so the reader sees a title. Mirrors web's
/// `referenceRoute` (Transcript.tsx), with one difference: a project's page is not a `Route`, so
/// `route` answers nil for it and the app's own link door (`AppModel.openOrbitLink`) opens it.
public enum ReferenceLink {
    /// Where tapping the link goes, or nil for a reference the app's own link door opens instead: a
    /// project, whose page is not a `Route`.
    public static func route(_ url: URL) -> Route? {
        guard let ref = parse(url), PublicID.toUUID(ref.id) != nil else { return nil }
        switch ref.kind {
        case "task":    return .task(ref.id)
        case "session": return .session(ref.id)
        // A list is named by its public id everywhere the Tasks page knows it (`TaskListSummary.id`),
        // so a link that spelled it as a UUID still lands on the row that is showing.
        case "list":    return .list(PublicID.toPublic(ref.id))
        default:        return nil
        }
    }

    /// Whether a reference names nothing this app could ever open, and should therefore be drawn as
    /// prose rather than as a link whose tap could only do nothing.
    ///
    /// A project or a task list is NOT inert: both have a destination now — a list switches the Tasks
    /// page to its scope, and a project opens its own page — reached through the app's own link door
    /// (`AppModel.openOrbitLink`). Only an id that doesn't parse has nowhere to go.
    public static func isInert(_ url: URL) -> Bool {
        guard let ref = parse(url) else { return false }
        return PublicID.toUUID(ref.id) == nil
    }

    private static func parse(_ url: URL) -> (kind: String, id: String)? {
        guard let scheme = url.scheme?.lowercased(), scheme.hasPrefix("orbit-") else { return nil }
        let kind = String(scheme.dropFirst("orbit-".count))
        guard ["task", "session", "project", "list"].contains(kind) else { return nil }
        return (kind, String(url.absoluteString.dropFirst(scheme.count + 1)))
    }
}
