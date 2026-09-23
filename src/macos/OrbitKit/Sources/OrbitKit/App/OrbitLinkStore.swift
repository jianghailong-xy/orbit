import Foundation

// The cards a conversation has asked for, kept between refreshes.
//
// One read per batch of refs (`LinkPreviewRef`), never one per link: a conversation with six links
// in it would otherwise be six round trips on every refresh. What the store adds on top of a plain
// fetch is the two things a screenful of links needs — a cache keyed by the object rather than by
// the spelling the link was written in, and one flight per object, so two conversations showing the
// same task ask for it once.
//
// It holds nothing a failed read could poison: a request that throws caches nothing at all, so the
// cards it was for stay in their loading state and the next refresh tries again. Only the server's
// own `unavailable` answer is remembered as an answer — that one is a fact about the object rather
// than about the network.

/// The one thing the store needs from whoever does the reading. `APIClient` is the real one; a test
/// hands in a stub and counts the requests.
public protocol LinkPreviewClient: Sendable {
    func fetchLinkPreviews(_ refs: [LinkPreviewRef]) async throws -> [LinkPreview]
}

/// A cache of the cards a conversation shows, and the batching and single-flight in front of it.
public actor OrbitLinkPreviewStore {
    private let client: any LinkPreviewClient
    private let maxRefs: Int

    /// One request in flight: the task, the keys it answers, and a number that identifies it while
    /// its keys are being resolved (two keys of one batch share a task, so the task itself cannot be
    /// compared).
    private struct Read {
        let id: Int
        let task: Task<[String: LinkPreview], Never>
        let keys: [String]
    }

    private var answers: [String: LinkPreview] = [:]
    private var reads: [String: Read] = [:]
    private var nextReadID = 0

    public init(client: any LinkPreviewClient, maxRefs: Int = linkPreviewMaxRefs) {
        self.client = client
        self.maxRefs = max(1, maxRefs)
    }

    /// The card for each link asked for, reading whatever is not already known. Keyed by
    /// `LinkPreviews.key`, which is canonicalised: the two spellings of one id are one entry.
    ///
    /// At most `maxRefs` links go in one request (the endpoint refuses more), and a link whose
    /// answer is already in hand — or already being read — costs no request at all. A read that
    /// fails simply does not appear in the answer, which is what leaves its card loading.
    public func previews(for refs: [OrbitLinkRef]) async -> [String: LinkPreview] {
        var answer: [String: LinkPreview] = [:]
        var missing: [OrbitLinkRef] = []
        var pending: [Read] = []
        var pendingIDs = Set<Int>()
        var seen = Set<String>()

        for ref in refs where seen.insert(ref.target.key).inserted {
            let key = ref.target.key
            if let hit = answers[key] {
                answer[key] = hit
            } else if let read = reads[key] {
                if pendingIDs.insert(read.id).inserted { pending.append(read) }
            } else {
                missing.append(ref)
            }
        }

        // Started before anything is awaited, so a link of this call never waits behind a read that
        // a later one has not asked for yet.
        for batch in batches(missing) {
            let read = read(batch)
            for ref in batch { reads[ref.target.key] = read }
            pending.append(read)
        }

        for read in pending {
            for (key, preview) in await read.task.value {
                answers[key] = preview
                answer[key] = preview
            }
            // Whether it answered or threw, the flight is over: a refusal must not stop the next
            // refresh from asking again.
            for key in read.keys where reads[key]?.id == read.id { reads[key] = nil }
        }
        return answer
    }

    /// The answer already in hand for one link, if there is one.
    public func cachedPreview(for target: OrbitLinkTarget) -> LinkPreview? { answers[target.key] }

    /// Forget everything, for a sign-out or a server change: a card read from one account is not one
    /// to draw against another.
    public func removeAll() {
        answers.removeAll()
        reads.removeAll()
    }

    private func batches(_ refs: [OrbitLinkRef]) -> [[OrbitLinkRef]] {
        stride(from: 0, to: refs.count, by: maxRefs).map {
            Array(refs[$0..<min($0 + maxRefs, refs.count)])
        }
    }

    /// One request, answered as a lookup by key. The endpoint answers one preview per ref in the
    /// order asked, so a short answer leaves the refs it did not reach uncached.
    private func read(_ batch: [OrbitLinkRef]) -> Read {
        nextReadID += 1
        let id = nextReadID
        let requested = batch.map { LinkPreviewRef(kind: $0.kind, id: $0.target.id) }
        let task = Task { [client] in
            do {
                let previews = try await client.fetchLinkPreviews(requested)
                var answer: [String: LinkPreview] = [:]
                for (index, ref) in batch.enumerated() where index < previews.count {
                    answer[ref.target.key] = previews[index]
                }
                return answer
            } catch {
                return [:]
            }
        }
        return Read(id: id, task: task, keys: batch.map(\.target.key))
    }
}

extension APIClient: LinkPreviewClient {
    public func fetchLinkPreviews(_ refs: [LinkPreviewRef]) async throws -> [LinkPreview] {
        try await linkPreviews(refs)
    }
}
