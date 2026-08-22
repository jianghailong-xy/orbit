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
    /// Ids the server answered for with bytes that are not a renderable image — render a file chip.
    /// A *failed* fetch never lands here: see `load`.
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
        guard cache[id] == nil, !notImage.contains(id), !loading.contains(id) else { return }
        loading.insert(id)
        defer { loading.remove(id) }
        let data: Data
        do {
            data = try await api.downloadAttachment(id)
        } catch let APIError.http(status, _) where (400..<500).contains(status) {
            notImage.insert(id)   // the server won't serve it — gone or not ours; asking again won't help
            return
        } catch {
            return                // offline, dropped, or cancelled — retry when the row comes back
        }
        guard let img = PlatformImage(data: data) else {
            notImage.insert(id)
            return
        }
        cache[id] = img
    }
}
