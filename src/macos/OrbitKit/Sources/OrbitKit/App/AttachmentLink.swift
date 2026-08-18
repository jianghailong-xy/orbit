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
