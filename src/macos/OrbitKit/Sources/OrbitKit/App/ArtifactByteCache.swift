import Foundation

/// The bytes the artifact route returned for a path, kept so a row that scrolls out and back does not
/// fetch the same file again.
///
/// What it is for: an agent's mock is fetched whenever its row appears (see MarkdownImageView), and a
/// List re-creates rows as they scroll — so the same 1 MB PNG was re-requested every time it came
/// back on screen. The server is a round trip per fetch even when it has the bytes ready, and on a
/// phone that is a real cost in data and battery for a picture the reader has already been shown.
///
/// Keyed by path, which is unique per session on its own: the path carries the session's directory.
/// Bounded by the bytes it holds, like the decoded-image cache beside it, and it evicts on its own —
/// `NSCache` drops entries under memory pressure, which is the behaviour wanted here (a fetch that is
/// dropped is just a fetch again).
///
/// It inherits one property of the route it caches, deliberately: the server answers a path with the
/// newest attachment it already holds under that file name, so a mock *rewritten at the same path*
/// keeps serving the first version it uploaded. Caching the same answer here does not change that;
/// it only stops re-asking.
public final class ArtifactByteCache {
    private let cache = NSCache<NSString, NSData>()

    public init(byteLimit: Int) {
        cache.totalCostLimit = byteLimit
    }

    /// The bytes for `path`, if this cache still holds them.
    public func data(for path: String) -> Data? {
        cache.object(forKey: path as NSString) as Data?
    }

    /// Keep `bytes` for `path`, charged at their size — so the limit is a byte budget, not an entry
    /// count, exactly as the decoded-image cache charges its bitmaps.
    public func store(_ bytes: Data, for path: String) {
        cache.setObject(bytes as NSData, forKey: path as NSString, cost: bytes.count)
    }
}
