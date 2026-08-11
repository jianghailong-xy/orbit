import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Source of a session's live `RunEvent` stream. Abstracted so the reconnect/reduce loop is
/// platform-agnostic and testable with a mock; the concrete URLSession transport is macOS-only.
public protocol EventStreaming: Sendable {
    /// Stream events with `seq > sinceSeq`. The server replays persisted durable events first,
    /// then goes live. The stream ends when the connection closes; the caller reconnects.
    func events(sessionID: String, sinceSeq: Int) -> AsyncThrowingStream<RunEvent, Error>
}

/// Feeds a fixed list of events then finishes — for SwiftUI previews and tests.
public struct MockEventStream: EventStreaming {
    public let events: [RunEvent]
    public init(_ events: [RunEvent]) { self.events = events }
    public func events(sessionID: String, sinceSeq: Int) -> AsyncThrowingStream<RunEvent, Error> {
        let evs = events.filter { !($0.type.isDurable && $0.seq > 0 && $0.seq <= sinceSeq) }
        return AsyncThrowingStream { continuation in
            for e in evs { continuation.yield(e) }
            continuation.finish()
        }
    }
}

public enum EventStreamError: Error, Equatable {
    /// No bytes (events OR keepalives) for the watchdog window — the connection is half-dead.
    case watchdogTimeout
}

#if os(macOS) || os(iOS)
/// Live SSE transport over `URLSession.bytes`. Native clients set the `Authorization` header
/// directly (unlike browser `EventSource`, which can only pass `?access_token=`), keeping the
/// token out of URLs and logs. Apple-only (macOS + iOS): `bytes(for:)` isn't reliably present
/// on Linux Foundation, so Linux only builds the pure parser + reducer.
///
/// Carries the same byte watchdog as `URLSessionControlStream`, and for the same reason: a socket
/// suspended by iOS or reaped by an intermediary comes back readable-but-dead, and URLSession will
/// not error it until the 3600s read timeout. Nothing else would notice — the network path monitor
/// only fires on a genuine down→up transition and the foreground kick only after a real background
/// trip — so a phone left on this screen watched a transcript that had silently stopped updating.
/// The server pings this endpoint every ~20s (`KEEPALIVE_MS`), so 45s of silence is conclusive.
public struct URLSessionEventStream: EventStreaming {
    let baseURL: URL
    let token: @Sendable () -> String?
    let session: URLSession
    let watchdogTimeout: TimeInterval

    public init(baseURL: URL, token: @escaping @Sendable () -> String?,
                session: URLSession = .orbitStreaming, watchdogTimeout: TimeInterval = 45) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.watchdogTimeout = watchdogTimeout
    }

    public func events(sessionID: String, sinceSeq: Int) -> AsyncThrowingStream<RunEvent, Error> {
        AsyncThrowingStream { continuation in
            let clock = ByteClock()
            let task = Task {
                do {
                    var comps = URLComponents(url: baseURL.appendingPathComponent("api/sessions/\(sessionID)/events"),
                                              resolvingAgainstBaseURL: false)!
                    comps.queryItems = [
                        URLQueryItem(name: "sinceSeq", value: String(sinceSeq)),
                        // Same preview-sized tool bodies the page fetch asks for, so a card looks
                        // identical whether it arrived by replay or live (APIClient.maxEventPayload).
                        URLQueryItem(name: "maxPayload", value: String(APIClient.maxEventPayload)),
                    ]
                    var req = URLRequest(url: comps.url!)
                    req.timeoutInterval = 3600
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }

                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        throw APIError.http(status: http.statusCode, body: nil)
                    }
                    clock.pulse()   // connection established counts as liveness
                    var parser = SSEFrameParser()
                    // Iterate raw bytes, not `bytes.lines`: SSE delimits events with a blank line
                    // (`\n\n`), and `bytes.lines`' empty-line handling can swallow it, leaving the
                    // stream connected but never dispatching a frame. Every byte — keepalive `ping`
                    // frames included — feeds the clock.
                    for try await byte in bytes {
                        clock.pulse()
                        if let sse = parser.consume(byte: byte), let ev = SSEDecoding.runEvent(from: sse) {
                            continuation.yield(ev)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Watchdog: declare the stream dead ourselves when the keepalive cadence stops, so
            // `ConsoleModel.run()` reconnects on its backoff instead of hanging on a dead socket.
            let monitor = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    if Task.isCancelled { return }
                    if clock.starved(timeout: watchdogTimeout) {
                        continuation.finish(throwing: EventStreamError.watchdogTimeout)
                        task.cancel()
                        return
                    }
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
                monitor.cancel()
            }
        }
    }
}
#endif
