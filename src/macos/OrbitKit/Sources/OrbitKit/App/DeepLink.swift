import Foundation

/// An in-app navigation target. Notifications and menu-bar items carry one of these; the app
/// routes to it. Also the payload of an `orbit://` deep link.
public enum Route: Equatable, Sendable {
    case active
    case session(String)
    case task(String)
    case runner(String)
}

/// `orbit://` URL scheme. `orbit://session/<id>`, `orbit://task/<id>`, `orbit://runner/<id>`,
/// `orbit://active`. Parsing/formatting is pure so it's unit-tested; registering the scheme
/// (Info.plist `CFBundleURLTypes`) + `onOpenURL` handling is the app's macOS glue.
public enum DeepLink {
    public static let scheme = "orbit"

    public static func parse(_ url: URL) -> Route? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let host = url.host?.lowercased() ?? ""
        let id = url.pathComponents.first { $0 != "/" && !$0.isEmpty }
        switch host {
        case "session": return id.map(Route.session)
        case "task":    return id.map(Route.task)
        case "runner":  return id.map(Route.runner)
        case "active", "": return .active
        default:        return nil
        }
    }

    public static func url(for route: Route) -> URL {
        switch route {
        case .active:            return URL(string: "\(scheme)://active")!
        case .session(let id):   return URL(string: "\(scheme)://session/\(encode(id))")!
        case .task(let id):      return URL(string: "\(scheme)://task/\(encode(id))")!
        case .runner(let id):    return URL(string: "\(scheme)://runner/\(encode(id))")!
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
    /// Where tapping the link goes, or nil for anything but a task or session reference.
    public static func route(_ url: URL) -> Route? {
        guard let ref = parse(url), PublicID.toUUID(ref.id) != nil else { return nil }
        switch ref.kind {
        case "task":    return .task(ref.id)
        case "session": return .session(ref.id)
        default:        return nil
        }
    }

    /// A reference this app can't open — a project or task list it has no screen for, or an id that
    /// doesn't parse. A view draws its title as prose rather than a link whose tap could only do nothing.
    public static func isInert(_ url: URL) -> Bool {
        parse(url) != nil && route(url) == nil
    }

    private static func parse(_ url: URL) -> (kind: String, id: String)? {
        guard let scheme = url.scheme?.lowercased(), scheme.hasPrefix("orbit-") else { return nil }
        let kind = String(scheme.dropFirst("orbit-".count))
        guard ["task", "session", "project", "list"].contains(kind) else { return nil }
        return (kind, String(url.absoluteString.dropFirst(scheme.count + 1)))
    }
}
