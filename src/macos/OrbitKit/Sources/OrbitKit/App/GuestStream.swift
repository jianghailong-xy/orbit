import Foundation

// The guest view followed over the guest door's stream (docs/session-viewer-stream-design.md §3, §4, §7):
// `GET /api/guest-sessions/:id/stream` carries the transcript as it is written — durable events, the
// typed-out deltas — plus `head` frames for the status and the waiting line, and `gone` once the
// session is no longer shared. Polling (`GuestFollow`) stays as the fallback.

/// Source of the guest door's stream. Abstracted so the follow's decisions are testable without a
/// network; the concrete transport is `URLSessionEventStream` (Apple only).
public protocol GuestStreaming: Sendable {
    /// Frames of the guest stream, replaying the stored events with `seq > sinceSeq` first. Ends when
    /// the connection closes; throws `APIError.http` when the door answers anything but 200.
    func guestFrames(sessionID: String, sinceSeq: Int) -> AsyncThrowingStream<GuestStreamFrame, Error>
}

/// One frame of the guest stream as the follow reads it.
public enum GuestStreamFrame: Equatable, Sendable {
    /// A transcript event: durable, or live-only (a delta, a tool's running output, `resync`).
    case event(RunEvent)
    /// The head as it stands now (`type: "head"`).
    case head(GuestSessionHead)
    /// The session is no longer shared with this account (`type: "gone"`): the stream ends after it.
    case gone
    /// The keepalive (~20 s).
    case ping

    private struct Peek: Decodable { let type: String? }
    private struct HeadFrame: Decodable { let payload: GuestSessionHead }

    /// One dispatched SSE frame, or nil when it is not JSON or names a type no reader knows.
    public static func decode(_ sse: SSEEvent) -> GuestStreamFrame? {
        guard let data = sse.data.data(using: .utf8),
              let peek = try? JSONDecoder().decode(Peek.self, from: data) else { return nil }
        switch peek.type {
        case "head": return (try? JSONDecoder().decode(HeadFrame.self, from: data)).map { .head($0.payload) }
        case "gone": return .gone
        case "ping": return .ping
        default:
            guard let event = try? JSONDecoder().decode(RunEvent.self, from: data), event.type != .unknown else { return nil }
            return .event(event)
        }
    }
}

/// The decisions of the guest view's follow (web `GuestConversation`, Android `GuestConversation`):
/// which frames to draw, where the reconnect cursor stands, and when to stream, reconnect or poll.
///
///   - Every stored event moves the cursor (`sinceSeq` of the next connection); one at or below it is
///     a replay already held and is skipped. Deltas and other live-only events are drawn and never move it.
///   - A drop or a clean close reconnects on `ReconnectPolicy`'s ramp from the cursor; a `resync`
///     re-seeds from the tail page first.
///   - The stream refused at open (a 404 from a server without the route, or from a door that no longer
///     shares the session; a 429 over a cap; anything but 200), or `failuresBeforePolling` attempts in a
///     row ending before any frame, falls back to polling (`GuestFollow`), and the stream is tried again
///     `streamRetry` later or when the app comes back to the foreground.
///   - In the background the stream is closed; back in the foreground it is reopened from the cursor.
public struct GuestStreamFollow: Sendable, Equatable {
    public enum Mode: Sendable, Equatable { case stream, polling }

    /// How one connection attempt ended.
    public enum End: Sendable, Equatable {
        /// The server closed the stream cleanly (an apiserver stopping).
        case ended
        /// The connection dropped, errored or went quiet past the watchdog.
        case failed
        /// The door answered `status` instead of opening the stream.
        case refused(status: Int)
        /// The app went to the background, and the stream was closed.
        case background
        /// The server sent `resync`: the cursor is too far behind to replay.
        case resync
        /// The view went away.
        case cancelled
    }

    /// What to do with one frame.
    public enum Step: Sendable, Equatable {
        /// Fold it into the transcript.
        case apply(RunEvent)
        /// Redraw the status, the title and the waiting line.
        case head(GuestSessionHead)
        /// Show the not-shared state.
        case gone
        /// Read the tail page again, then reconnect from its newest seq.
        case reseed
        /// Nothing to draw: a keepalive, or a replay of an event already held.
        case skip
    }

    /// What to do after an attempt ends.
    public enum Next: Sendable, Equatable {
        /// Connect again after `afterMs` (to be jittered by the caller).
        case reconnect(afterMs: Int)
        /// Follow by polling (`GuestFollow`) until `retryStream` says to try the stream again.
        case poll
        /// Wait for the foreground, then connect again from the cursor.
        case waitForeground
        /// Stop following.
        case stop
    }

    /// Attempts in a row ending before any frame, after which the follow polls.
    public static let failuresBeforePolling = 3
    /// How long the follow polls before it tries the stream again.
    public static let streamRetry: TimeInterval = 60

    public private(set) var mode: Mode = .stream
    /// The newest stored seq held: what the next connection, or the next poll, asks after.
    public private(set) var cursor: Int
    private var policy = ReconnectPolicy()
    private var unheard = 0
    private var pollingSince: Date?

    public init(after cursor: Int = 0) {
        self.cursor = max(0, cursor)
    }

    /// A frame arrived: the connection is healthy, and this is what to do with it.
    public mutating func read(_ frame: GuestStreamFrame) -> Step {
        policy.noteHealthy()
        unheard = 0
        switch frame {
        case .ping: return .skip
        case .gone: return .gone
        case .head(let head): return .head(head)
        case .event(let event):
            if event.type == .resync { return .reseed }
            if Self.stored(event) {
                guard event.seq > cursor else { return .skip }
                cursor = event.seq
            }
            return .apply(event)
        }
    }

    /// Events read some other way (the first read, a poll) reached `seq`.
    public mutating func held(_ seq: Int) {
        if seq > cursor, seq != RunEvent.sentinelSeq { cursor = seq }
    }

    /// The window was read again from the tail (the first read, a `resync`): the cursor is its newest seq.
    public mutating func reseeded(after seq: Int) {
        cursor = max(0, seq == RunEvent.sentinelSeq ? cursor : seq)
    }

    public mutating func next(after end: End, at now: Date = Date()) -> Next {
        switch end {
        case .cancelled:
            return .stop
        case .refused:
            return fallBack(at: now)
        case .background:
            _ = policy.next(after: .kicked)
            return .waitForeground
        case .resync:
            return Self.reconnect(policy.next(after: .resync))
        case .ended, .failed:
            if !policy.connectionHealthy { unheard += 1 }
            if unheard >= Self.failuresBeforePolling {
                _ = policy.next(after: .failed)
                return fallBack(at: now)
            }
            return Self.reconnect(policy.next(after: end == .ended ? .ended : .failed))
        }
    }

    /// How a connection that threw `error` ended: refused when the door answered a status, cancelled
    /// with the view, failed otherwise (a drop, a timeout, the watchdog).
    public static func end(of error: Error) -> End {
        if error is CancellationError { return .cancelled }
        if case APIError.http(let status, _) = error { return .refused(status: status) }
        return .failed
    }

    /// While polling: whether it is time to try the stream again (`streamRetry` after falling back).
    /// When it is, the follow is back in stream mode.
    public mutating func retryStream(at now: Date = Date()) -> Bool {
        guard mode == .polling, let since = pollingSince, now.timeIntervalSince(since) >= Self.streamRetry else { return false }
        resume()
        return true
    }

    /// Back in the foreground: the stream is opened again, a follow that fell back to polling included.
    public mutating func foreground() {
        resume()
    }

    private mutating func fallBack(at now: Date) -> Next {
        mode = .polling
        pollingSince = now
        unheard = 0
        return .poll
    }

    private mutating func resume() {
        mode = .stream
        pollingSince = nil
        unheard = 0
        policy = ReconnectPolicy()
    }

    private static func stored(_ event: RunEvent) -> Bool {
        event.type.isDurable && event.seq > 0 && event.seq != RunEvent.sentinelSeq
    }

    private static func reconnect(_ action: ReconnectAction) -> Next {
        switch action {
        case .stop: return .stop
        case .reconnect(let ms): return .reconnect(afterMs: ms)
        }
    }
}
