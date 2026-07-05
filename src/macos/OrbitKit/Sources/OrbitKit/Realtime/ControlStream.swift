import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What a control-plane transport yields: a local `connected` marker the moment the HTTP
/// response comes back 200 (so the consumer can rebuild its snapshot and stop fallback polling
/// without waiting for the first — possibly seconds-away — event), then the decoded events.
public enum ControlStreamEvent: Sendable, Equatable {
    /// The stream is live (HTTP 200). Local marker, not a wire event.
    case connected
    case event(ControlEvent)
}

/// Source of the user-scoped control-plane stream (`GET /api/events`). Abstracted so the
/// consume/reconnect loop is testable with a mock; mirrors `EventStreaming` on the data plane.
public protocol ControlPlaneStreaming: Sendable {
    func events() -> AsyncThrowingStream<ControlStreamEvent, Error>
}

/// Feeds `connected` + a fixed list of events then finishes — for tests and previews.
public struct MockControlStream: ControlPlaneStreaming {
    public let feed: [ControlEvent]
    public init(_ feed: [ControlEvent]) { self.feed = feed }
    public func events() -> AsyncThrowingStream<ControlStreamEvent, Error> {
        let evs = feed
        return AsyncThrowingStream { continuation in
            continuation.yield(.connected)
            for e in evs { continuation.yield(.event(e)) }
            continuation.finish()
        }
    }
}

/// Tracks when the last byte arrived so a watchdog can detect a half-dead connection — the
/// server keepalives every ~20s, so silence for `timeout` (2× that, with margin) means the
/// socket is dead even though the read hasn't errored. Plain lock-guarded state: the reader
/// task pulses it per byte while the monitor task polls it.
final class ByteClock: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()

    func pulse() {
        lock.lock(); last = Date(); lock.unlock()
    }

    func starved(timeout: TimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return Date().timeIntervalSince(last) > timeout
    }
}

public enum ControlStreamError: Error, Equatable {
    /// No bytes (events OR keepalives) for the watchdog window — the connection is half-dead.
    case watchdogTimeout
}

#if os(macOS) || os(iOS)
/// Live SSE transport for `GET /api/events` over `URLSession.bytes`, with the `Authorization`
/// header (native clients never put the token in the URL) and a byte watchdog: the server
/// keepalives every ~20s, so a silent 45s window finishes the stream with `watchdogTimeout`
/// and the consumer's reconnect loop takes over. Apple-only, like `URLSessionEventStream`.
public struct URLSessionControlStream: ControlPlaneStreaming {
    let baseURL: URL
    let token: @Sendable () -> String?
    let session: URLSession
    let watchdogTimeout: TimeInterval

    public init(baseURL: URL, token: @escaping @Sendable () -> String?,
                session: URLSession = .shared, watchdogTimeout: TimeInterval = 45) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.watchdogTimeout = watchdogTimeout
    }

    public func events() -> AsyncThrowingStream<ControlStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let clock = ByteClock()
            let reader = Task {
                do {
                    var req = URLRequest(url: baseURL.appendingPathComponent("api/events"))
                    req.timeoutInterval = 3600
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }

                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        throw APIError.http(status: http.statusCode, body: nil)
                    }
                    clock.pulse()   // connection established counts as liveness
                    continuation.yield(.connected)
                    var parser = SSEFrameParser()
                    // Byte-wise iteration for the same reason as the data plane (see
                    // URLSessionEventStream): `bytes.lines` can swallow SSE's blank-line frame
                    // delimiter. Every byte — keepalive comments included — feeds the clock.
                    for try await byte in bytes {
                        clock.pulse()
                        if let sse = parser.consume(byte: byte), let ev = SSEDecoding.controlEvent(from: sse) {
                            continuation.yield(.event(ev))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Watchdog: URLSession won't error a silently-dropped socket until its long read
            // timeout, so declare the stream dead ourselves when the keepalive cadence stops.
            let monitor = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    if Task.isCancelled { return }
                    if clock.starved(timeout: watchdogTimeout) {
                        continuation.finish(throwing: ControlStreamError.watchdogTimeout)
                        reader.cancel()
                        return
                    }
                }
            }
            continuation.onTermination = { _ in
                reader.cancel()
                monitor.cancel()
            }
        }
    }
}
#endif
