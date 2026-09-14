import Foundation

/// A bounded cache that doesn't drop what's in use.
///
/// `NSCache` evicts whatever it likes once its cost limit is passed, including an object a view is
/// drawing right now. For attachment images that turned into a loop: two images on screen together
/// over the limit took turns evicting each other, every eviction sent the view that lost its image to
/// fetch it again, and every fetch evicted the other — an image-viewer page flickering between its
/// picture and a spinner, re-downloading both, for as long as it stayed open.
///
/// So a key can be pinned while something uses it. A pinned key's object is held outside the cache and
/// answered from there however much is inserted after it; unpinned, it's the cache's to evict again.
/// Holding it costs nothing: an image on screen is retained by the view drawing it whether a cache
/// keeps it or not.
///
/// Not synchronized — confine each one to a single actor.
public final class PinnedCache<Object: AnyObject> {
    private let cache = NSCache<NSString, Object>()
    private var held: [String: Object] = [:]
    private var pins: [String: Int] = [:]

    public init(totalCostLimit: Int, countLimit: Int) {
        cache.totalCostLimit = totalCostLimit
        cache.countLimit = countLimit
    }

    public func object(forKey key: String) -> Object? {
        held[key] ?? cache.object(forKey: NSString(string: key))
    }

    public func setObject(_ object: Object, forKey key: String, cost: Int) {
        cache.setObject(object, forKey: NSString(string: key), cost: cost)
        if pins[key] != nil { held[key] = object }
    }

    /// Something has started using `key`. Until the matching `unpin`, its object — cached now, or
    /// inserted later — stays answerable. Pins count, so two users of one key each release their own.
    public func pin(_ key: String) {
        pins[key, default: 0] += 1
        if held[key] == nil, let object = cache.object(forKey: NSString(string: key)) {
            held[key] = object
        }
    }

    public func unpin(_ key: String) {
        guard let count = pins[key] else { return }
        if count > 1 {
            pins[key] = count - 1
        } else {
            pins[key] = nil
            held[key] = nil
        }
    }

    /// Empties the cache the way memory pressure can, leaving pinned objects where they are.
    func evictAll() {
        cache.removeAllObjects()
    }
}
