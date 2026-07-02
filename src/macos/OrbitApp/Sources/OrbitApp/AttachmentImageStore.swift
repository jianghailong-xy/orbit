import Foundation
import Observation
import OrbitKit
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
@MainActor
@Observable
final class AttachmentImageStore {
    private let api: APIClient
    private var cache: [String: PlatformImage] = [:]
    /// Ids that failed to decode (not an image, or a fetch error) — render a file chip instead of
    /// retrying forever.
    private var notImage: Set<String> = []
    private var loading: Set<String> = []

    init(baseURL: URL, tokenStore: TokenStore) {
        self.api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// Decoded image for `id`, if already cached. Non-mutating — safe in a view `body`.
    func image(for id: String) -> PlatformImage? { cache[id] }

    /// True once a fetch decided `id` isn't a renderable image (show a file chip).
    func isNotImage(_ id: String) -> Bool { notImage.contains(id) }

    /// Pre-fill the cache from bytes already in hand (the just-uploaded attachment), so the sent
    /// bubble renders its image with no fetch. No-op if already cached or the bytes don't decode.
    func seed(_ id: String, data: Data) {
        guard cache[id] == nil, let img = PlatformImage(data: data) else { return }
        cache[id] = img
    }

    /// Fetch + decode `id` if not already known. Idempotent and dedups concurrent callers.
    func load(_ id: String) async {
        guard cache[id] == nil, !notImage.contains(id), !loading.contains(id) else { return }
        loading.insert(id)
        defer { loading.remove(id) }
        guard let data = try? await api.downloadAttachment(id), let img = PlatformImage(data: data) else {
            notImage.insert(id)
            return
        }
        cache[id] = img
    }
}
