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

/// A transcript link naming an Orbit object: `[title](orbit-task:<id>)`, and likewise
/// `orbit-session:`, `orbit-project:` and `orbit-list:`. The composer's `#`-references send them and
/// agents are told to write them instead of a bare id, so the reader sees a title. Mirrors web's
/// `referenceRoute` (Transcript.tsx), except that this app has a screen only for tasks and sessions.
public enum ReferenceLink {
    /// Where tapping the link goes, or nil for a reference whose destination the app has to look up
    /// first: a project leads to the conversation that coordinates it, which only a read can name.
    public static func route(_ url: URL) -> Route? {
        guard let ref = parse(url), PublicID.toUUID(ref.id) != nil else { return nil }
        switch ref.kind {
        case "task":    return .task(ref.id)
        case "session": return .session(ref.id)
        case "list":    return .list(ref.id)
        default:        return nil
        }
    }

    /// Whether a reference names nothing this app could ever open, and should therefore be drawn as
    /// prose rather than as a link whose tap could only do nothing.
    ///
    /// A project or a task list is NOT inert: both have a destination now — a list switches the Tasks
    /// page to its scope, and a project opens the conversation that coordinates it — reached through
    /// the app's own link door (`AppModel.openOrbitLink`), which is where the read a project needs
    /// happens. Only an id that doesn't parse has nowhere to go.
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
