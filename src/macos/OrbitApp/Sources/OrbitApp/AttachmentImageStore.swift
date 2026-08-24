import Foundation
import Observation
import OrbitKit
import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Shared, per-instance cache of decoded attachment images, keyed by attachment id. The transcript
/// fetches a user turn's images via the bearer-guarded GET /attachments/:id (an `<img src>` can't
/// carry the JWT), so the bytes are pulled once and the decoded `PlatformImage` is reused across re-renders
/// and session switches. Lives on `ConsoleRegistry` (one per instance) and is injected into the
/// transcript via SwiftUI environment.
///
/// The just-sent image is `seed`ed from the bytes already in hand at upload time, so the optimistic
/// bubble shows it instantly (no fetch round-trip) — mirroring the web composer's local preview.
///
/// The cache is *bounded* and evicts on its own: this used to be a plain dictionary that only ever
/// grew, so every image scrolled past stayed decoded until logout. A phone screenshot decodes to tens
/// of megabytes, which on iOS is a straight line from browsing a few image-heavy sessions to a jetsam
/// kill. Anything evicted is re-fetchable — see `loadsAttachmentImage`, which is how a view that lost
/// its entry asks for the bytes again.
@MainActor
@Observable
final class AttachmentImageStore {
    /// One resolved answer about an attachment: the decoded image, or `nil` for "the server served
    /// these bytes and they aren't a renderable image" (render a file chip). Both answers share the
    /// cache so a session full of PDFs can't grow an unbounded set of ids either.
    private final class Entry {
        let image: PlatformImage?
        init(_ image: PlatformImage?) { self.image = image }
    }

    private let api: APIClient
    private let cache = NSCache<NSString, Entry>()

    /// Ids with a fetch in flight — dedups concurrent callers. Bounded by what's actually in flight:
    /// every insert below is paired with a `defer`red removal.
    private var loading: Set<String> = []

    /// Bumped whenever an entry lands. `cache` is a reference type `@Observable` can't see through,
    /// so this counter is what view bodies actually observe — reading it in the accessors below is
    /// what re-renders the transcript when a fetch finishes. One counter for the whole store matches
    /// the old `[String: PlatformImage]`, where any write likewise invalidated every reader.
    private var revision: UInt64 = 0

    // Byte ceiling for the decoded bitmaps, counted as real pixel bytes (see `bitmapBytes`) rather
    // than entries: 20 grid thumbnails and 20 4K screenshots differ by two orders of magnitude. iOS
    // gets the smaller budget — that's the platform with a jetsam limit to stay under; a Mac has room
    // to keep a long transcript's images hot.
    #if os(iOS)
    private static let byteLimit = 64 << 20
    #else
    private static let byteLimit = 256 << 20
    #endif
    /// Second bound, for the "not an image" markers: their cost is nominal, so without a count limit
    /// a long enough run of non-image attachments would still accumulate under the byte ceiling.
    private static let entryLimit = 512
    private static let markerCost = 1

    init(baseURL: URL, tokenStore: TokenStore) {
        self.api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        cache.totalCostLimit = Self.byteLimit
        cache.countLimit = Self.entryLimit
    }

    /// Decoded image for `id`, if still cached. Non-mutating — safe in a view `body`. May answer nil
    /// for an id it answered non-nil for earlier: the cache evicts, and the view's `.task` refetches.
    func image(for id: String) -> PlatformImage? {
        _ = revision
        return cache.object(forKey: id as NSString)?.image
    }

    /// True once a fetch decided `id` isn't a renderable image (show a file chip).
    func isNotImage(_ id: String) -> Bool {
        _ = revision
        guard let entry = cache.object(forKey: id as NSString) else { return false }
        return entry.image == nil
    }

    /// Whether `id` has an answer — of either kind — still in the cache. What `loadsAttachmentImage`
    /// watches to notice an eviction.
    func isResolved(_ id: String) -> Bool {
        _ = revision
        return cache.object(forKey: id as NSString) != nil
    }

    /// Pre-fill the cache from bytes already in hand (the just-uploaded attachment), so the sent
    /// bubble renders its image with no fetch. No-op if already cached or the bytes don't decode.
    func seed(_ id: String, data: Data) {
        guard !isResolved(id), let img = PlatformImage(data: data) else { return }
        remember(id, img)
    }

    /// Raw bytes for `id`, uncached — what the "download" affordance on an `orbit-attachment:` link
    /// shares. It hands off the file itself (any type, image or not), so the decoded-image cache
    /// above is the wrong shape for it and a one-off fetch is cheaper than holding another copy.
    func data(for id: String) async -> Data? {
        try? await api.downloadAttachment(id)
    }

    /// Fetch + decode `id` if not already known. Idempotent and dedups concurrent callers.
    ///
    /// Only an answer about the file itself is remembered. This used to latch on any thrown error,
    /// which meant a `.task` cancelled when its row scrolled out of the List — or one dropped
    /// connection — permanently redressed a sent screenshot as a `photo.png` chip, with nothing to
    /// undo it short of relaunching the app. A transport failure says nothing about the bytes, so it
    /// leaves the id unresolved and the next appearance tries again.
    func load(_ id: String) async {
        guard !isResolved(id), !loading.contains(id) else { return }
        loading.insert(id)
        defer { loading.remove(id) }
        let data: Data
        do {
            data = try await api.downloadAttachment(id)
        } catch let APIError.http(status, _) where (400..<500).contains(status) {
            remember(id, nil)     // the server won't serve it — gone or not ours; asking again won't help
            return
        } catch {
            return                // offline, dropped, or cancelled — retry when the row comes back
        }
        remember(id, PlatformImage(data: data))   // undecodable bytes resolve as "not an image"
    }

    /// The one way in, so every path (seed and load alike) is charged the same cost and every landing
    /// entry re-renders the views waiting on it.
    private func remember(_ id: String, _ image: PlatformImage?) {
        cache.setObject(Entry(image), forKey: id as NSString,
                        cost: image.map(Self.bitmapBytes) ?? Self.markerCost)
        revision &+= 1
    }

    /// What a decoded bitmap actually costs in memory: 4 bytes per pixel, at the image's *pixel*
    /// dimensions rather than its points (a Retina screenshot is 2-3x larger than `size` suggests).
    private static func bitmapBytes(_ image: PlatformImage) -> Int {
        #if os(iOS)
        let px = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        #else
        // A bitmap rep carries the true pixel dimensions, but reports 0 when it's device-matched —
        // `max` falls back to the point size in that case.
        let rep = image.representations.first
        let px = CGSize(width: max(CGFloat(rep?.pixelsWide ?? 0), image.size.width),
                        height: max(CGFloat(rep?.pixelsHigh ?? 0), image.size.height))
        #endif
        return max(markerCost, Int(px.width * px.height) * 4)
    }
}

extension View {
    /// Keep `id`'s attachment image loaded for as long as this view is on screen, re-fetching it if
    /// the bounded cache evicted it.
    ///
    /// The task is keyed on *whether the store still has an answer*, not just on the id, and that's
    /// the whole point: with a plain `.task(id: id)`, a body pass that ran after an eviction would
    /// swap in the placeholder and then nothing would ever ask for the bytes again — the id, and so
    /// the task, hasn't changed — leaving a grey box until the row happened to be rebuilt.
    func loadsAttachmentImage(_ id: String, from store: AttachmentImageStore) -> some View {
        task(id: AttachmentImageLoad(id: id, resolved: store.isResolved(id))) {
            await store.load(id)
        }
    }
}

private struct AttachmentImageLoad: Equatable {
    let id: String
    let resolved: Bool
}
