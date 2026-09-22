import Foundation

/// How a transcript link that doesn't point at a web page should be read. Two shapes turn up:
///
///   • `orbit-attachment:<id>` — what the runner rewrites an uploaded file to (`[label](orbit-attachment:id "name")`).
///     The bytes are bearer-guarded, so a client fetches them through the API rather than opening a URL.
///   • an absolute path on the runner's disk (`/root/…`, `/home/…`, `/tmp/…`, `/Users/…`) — a file the
///     runner never uploaded. No client can reach it; web draws an inert file chip instead of a link.
///
/// Pure parsing so both clients (and the tests) share one reading of a link; the view layer decides
/// what to draw. Mirrors web's `attachmentIdFromSrc` / `isLocalFileSrc` in Transcript.tsx.
public enum AttachmentLink {
    public static let scheme = "orbit-attachment"

    /// The attachment id in an `orbit-attachment:<id>` link, or nil for any other URL. Strips the
    /// scheme, trims, and keeps the leading non-whitespace run (web's parse).
    public static func attachmentID(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let rest = url.absoluteString.dropFirst(scheme.count + 1).trimmingCharacters(in: .whitespaces)
        let id = rest.prefix { !$0.isWhitespace }
        return id.isEmpty ? nil : String(id)
    }

    /// The same reading on the raw source a Markdown image carries (`![alt](orbit-attachment:<id>)`),
    /// which is a string rather than a URL. Nil for any other source.
    public static func attachmentID(source: String) -> String? {
        let prefix = scheme + ":"
        guard source.hasPrefix(prefix) else { return nil }
        let rest = source.dropFirst(prefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
        let id = rest.prefix { !$0.isWhitespace }
        return id.isEmpty ? nil : String(id)
    }

    /// True for a link that names a file on the runner's disk rather than something a client can
    /// open. Deliberately limited to the roots web chips (`/root`, `/home`, `/tmp`, `/Users`), so an
    /// ordinary site-relative link isn't mistaken for one.
    public static func isRunnerLocalPath(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        guard scheme == nil || scheme == "file" else { return false }
        let raw = url.absoluteString
        guard !raw.contains("?"), !raw.contains("#") else { return false }
        let path = url.path.isEmpty ? raw : url.path
        return ["/root/", "/home/", "/tmp/", "/Users/"].contains { path.hasPrefix($0) }
    }

    /// The path of a file the control plane can still serve for `sessionID`, when a transcript names
    /// one — the file an agent drew, linked by where it wrote it. Nil for everything else, which is
    /// the great majority of runner-local paths.
    ///
    /// Serving it is the artifact route: the client asks by path, the control plane asks the runner,
    /// and the runner reads the file (only out of that session's own directories). Two directories
    /// are the session's own, and they are why this is worth offering a tap for:
    ///
    ///   `.orbit/uploads/<session>/…`   the scratch older sessions wrote into
    ///   `.orbit/worktrees/<session>/…` the checkout an agent works in — where the mocks it draws
    ///                                  and links actually sit
    ///
    /// Mirrors the server's own gate (`legacy-artifact-path.ts`), so the clients only offer what the
    /// API can answer; whether the file is really there is decided on the runner. Both spellings of
    /// the id are accepted, because a checkout is named after whichever one the claim carried.
    public static func runnerArtifactPath(_ url: URL, sessionID: String) -> String? {
        guard isRunnerLocalPath(url) else { return nil }
        // Compared as UUIDs rather than as strings, because the two spellings meet here and it is
        // whichever spelling each side happens to hold: the client is handed public ids (a session
        // opened from the list is `34THmsocm…`), while a path in a reply was written by the agent
        // under whatever the claim carried — on this deployment, the UUID. Listing both spellings of
        // the session and looking for one of them in the path missed exactly that pair, which is one
        // client fetching nothing while the server, the runner and the web (which never compares
        // ids) all answered fine.
        guard let wanted = PublicID.toUUID(sessionID) else { return nil }
        let path = url.path.isEmpty ? url.absoluteString : url.path
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        for i in parts.indices where i + 3 < parts.count {
            guard parts[i] == ".orbit", parts[i + 1] == "uploads" || parts[i + 1] == "worktrees" else {
                continue
            }
            if PublicID.toUUID(parts[i + 2]) == wanted { return path }
        }
        return nil
    }

    /// The same reading on a raw source string (`![alt](/root/…)`), which is what Markdown hands a
    /// renderer. Nil when the source isn't a URL at all, or isn't one of the session's own files.
    public static func runnerArtifactPath(source: String, sessionID: String) -> String? {
        guard let url = URL(string: source) else { return nil }
        return runnerArtifactPath(url, sessionID: sessionID)
    }

    /// Whether a path names something the clients can draw as a picture. The extension is all there
    /// is to go on before the bytes are in hand, and it is enough: an agent's mock ends in `.png`
    /// because that is what it wrote.
    ///
    /// What this decides is whether an unreachable-path chip is *worth fetching unprompted* — a
    /// reader who linked an image meant to show it, and one who linked a PDF meant to hand it over.
    /// SVG is deliberately absent: web draws it, but neither native client's `PlatformImage(data:)`
    /// decodes it, so fetching one here would only produce the chip it started as.
    public static func looksLikeImage(path: String) -> Bool {
        let ext = (path.split(separator: ".").last.map(String.init) ?? "").lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff"].contains(ext)
    }

    /// The file name at the end of a path — what a save or a share sheet should call it, since the
    /// artifact route serves the bytes without one.
    public static func fileName(inPath path: String) -> String {
        let leaf = path.split(separator: "/").last.map(String.init) ?? ""
        return leaf.isEmpty ? "file" : leaf.removingPercentEncoding ?? leaf
    }

    /// A file name to save a downloaded attachment under. The API serves attachment bytes without a
    /// name, so the id carries the identity and the extension comes from the bytes — without it the
    /// share sheet offers no "Save Image" and Files writes an extension-less blob.
    public static func suggestedFileName(id: String, data: Data) -> String {
        let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        let base = "orbit-" + (safe.isEmpty ? "attachment" : safe)
        guard let ext = fileExtension(sniffing: data) else { return base }
        return base + "." + ext
    }

    /// The extension `data`'s magic bytes identify, for the formats an agent actually emits (an
    /// image tool's output, an exported document). nil when unrecognised.
    public static func fileExtension(sniffing data: Data) -> String? {
        let b = [UInt8](data.prefix(12))
        guard b.count >= 4 else { return nil }
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "png" }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpg" }
        if b.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "gif" }
        if b.starts(with: [0x25, 0x50, 0x44, 0x46]) { return "pdf" }
        if b.count >= 12, b.starts(with: [0x52, 0x49, 0x46, 0x46]), Array(b[8..<12]) == [0x57, 0x45, 0x42, 0x50] {
            return "webp"
        }
        return nil
    }
}
