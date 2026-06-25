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
