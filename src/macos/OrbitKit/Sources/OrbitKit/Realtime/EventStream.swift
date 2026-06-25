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

#if os(macOS)
/// Live SSE transport over `URLSession.bytes`. Native clients set the `Authorization` header
/// directly (unlike browser `EventSource`, which can only pass `?access_token=`), keeping the
/// token out of URLs and logs. macOS-only: `bytes(for:)` isn't reliably present on Linux
/// Foundation, and this is a macOS app — Linux only builds the pure parser + reducer.
public struct URLSessionEventStream: EventStreaming {
    let baseURL: URL
    let token: @Sendable () -> String?
    let session: URLSession

    public init(baseURL: URL, token: @escaping @Sendable () -> String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public func events(sessionID: String, sinceSeq: Int) -> AsyncThrowingStream<RunEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var comps = URLComponents(url: baseURL.appendingPathComponent("api/sessions/\(sessionID)/events"),
                                              resolvingAgainstBaseURL: false)!
                    comps.queryItems = [URLQueryItem(name: "sinceSeq", value: String(sinceSeq))]
                    var req = URLRequest(url: comps.url!)
                    req.timeoutInterval = 3600
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }

                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        throw APIError.http(status: http.statusCode, body: nil)
                    }
                    var parser = SSEFrameParser()
                    for try await line in bytes.lines {
                        if let sse = parser.consume(line: line), let ev = SSEDecoding.runEvent(from: sse) {
                            continuation.yield(ev)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
#endif
