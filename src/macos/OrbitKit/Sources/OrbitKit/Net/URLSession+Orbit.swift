import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Two dedicated URLSessions so the long-lived SSE event streams and the short-lived REST calls do
// NOT share a connection pool. Everything used to default to `URLSession.shared`, whose per-host
// connection cap is small on iOS (~4–6). An open session holds one SSE stream (`GET /events`) for
// its whole lifetime; a couple of those — plus streams that linger briefly after a session switch,
// since `URLSession.bytes` is slow to release — could occupy every slot in that shared pool. The
// REST call that paints a reopened transcript (`/events/page`, `/sessions/:id`) then queues behind
// them and, in the worst case, never returns — so the transcript stays empty ("reopened session
// shows no reply"). Splitting the pools guarantees a REST slot is always free regardless of how
// many streams are open, and the raised caps give both room to breathe.
public extension URLSession {
    /// Short-lived REST (`APIClient`). Its own pool + a raised per-host cap so a burst of
    /// transcript/context/poll requests on session open never waits on the SSE streams.
    static let orbitREST: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: cfg)
    }()

    /// Long-lived SSE event streams (`URLSessionEventStream`). Isolated from REST so a stream can
    /// never consume a REST slot, with headroom for several open/closing streams at once.
    static let orbitStreaming: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpMaximumConnectionsPerHost = 8
        cfg.timeoutIntervalForRequest = 3600 // an SSE read stays open; don't time out a healthy one
        return URLSession(configuration: cfg)
    }()
}
