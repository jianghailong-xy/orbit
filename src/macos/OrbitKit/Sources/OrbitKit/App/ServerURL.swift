import Foundation

/// Normalizes a user-typed instance address into a control-plane base URL. Self-hosted means
/// users type things like `orbitd.io`, `https://orbit.example.com/`, or
/// `localhost:2086`; the client needs one canonical `URL` (scheme present, no trailing slash).
public enum ServerURL {
    public static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }

        if !s.contains("://") {
            // Default to https, except localhost/loopback which dev deployments serve over http.
            let isLocal = s.hasPrefix("localhost") || s.hasPrefix("127.0.0.1")
            s = (isLocal ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }

        guard let url = URL(string: s),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else { return nil }
        return url
    }
}
